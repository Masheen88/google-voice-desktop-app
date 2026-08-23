//preload.js

/**********************************************************************************************************************
 * Preload script for the main application window.  Contains all code
 * that needs to execute before the window's web content begins loading.
 *
 * IMPORTANT:
 * This preload is intentionally compatible with Electron's renderer sandbox.  It does not expose
 * ipcRenderer, Node.js, or other privileged APIs to Google Voice.  All communication with the main
 * process is kept inside this isolated preload context.
 **********************************************************************************************************************/

const { ipcRenderer, webFrame } = require("electron");

// Keep our cross-context message namespace intentionally specific so that unrelated page messages
// cannot accidentally trigger privileged Electron behavior.
const MESSAGE_SOURCE = "voice-desktop-app-notification-shim";
const MESSAGE_NOTIFICATION_CLICKED = "notification-clicked";

// Google Voice has changed its generated markup several times over the years.  Keep a short fallback
// list so notification count detection is not tied to only one exact Angular-generated DOM structure.
const NOTIFICATION_BADGE_SELECTORS = [
  ".gv_root .navListItem .navItemBadge",
  ".navListItem .navItemBadge",
  ".navItemBadge",
  '[class*="navItemBadge"]',
];

let lastNotificationCount = null;
let notificationRefreshTimer = null;
let blankBodyCheckCount = 0;

/**
 * Parses Google Voice's currently visible notification badges and returns a safe total.
 *
 * @returns {number}
 */
function readNotificationCount() {
  for (const selector of NOTIFICATION_BADGE_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll(selector));

    if (nodes.length === 0) {
      continue;
    }

    return nodes.reduce((sum, node) => {
      const text = String(node.textContent || "").trim();
      const parsed = Number.parseInt(text, 10);

      return Number.isFinite(parsed) ? sum + parsed : sum;
    }, 0);
  }

  return 0;
}

/**
 * Sends the notification count to the main process only when the count actually changes.
 */
function publishNotificationCount() {
  const count = readNotificationCount();

  if (count === lastNotificationCount) {
    return;
  }

  lastNotificationCount = count;
  ipcRenderer.send("notification-count-changed", count);
}

/**
 * Coalesces rapid Angular/DOM mutations into a single notification-count refresh.
 */
function scheduleNotificationCountRefresh() {
  if (notificationRefreshTimer) {
    clearTimeout(notificationRefreshTimer);
  }

  notificationRefreshTimer = setTimeout(() => {
    notificationRefreshTimer = null;
    publishNotificationCount();
  }, 150);
}

/**
 * Starts observing the Google Voice document for notification badge changes.
 */
function installNotificationCountObserver() {
  if (!document.documentElement) {
    return;
  }

  const observer = new MutationObserver(() => {
    scheduleNotificationCountRefresh();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Publish an initial value immediately after the observer is installed.
  publishNotificationCount();
}

/**
 * Implements the existing blank-white-screen recovery behavior without repeatedly asking the
 * main process to execute JavaScript inside the remote Google Voice renderer.
 *
 * Requiring two consecutive empty checks avoids reloading during a short-lived navigation state.
 */
function installBlankPageWatchdog() {
  setInterval(() => {
    if (document.readyState !== "complete" || !document.body) {
      blankBodyCheckCount = 0;
      return;
    }

    if (document.body.childNodes.length === 0) {
      blankBodyCheckCount += 1;

      if (blankBodyCheckCount >= 2) {
        blankBodyCheckCount = 0;
        ipcRenderer.send("blank-page-detected");
      }
    } else {
      blankBodyCheckCount = 0;
    }
  }, 5000);
}

/**
 * Installs a tiny wrapper around the page's native Notification constructor in the page's main world.
 *
 * Context isolation means this preload cannot directly replace Google Voice's window.Notification.
 * webFrame.executeJavaScript() intentionally performs only this narrow compatibility shim in the page
 * world.  Notification clicks are relayed back through window.postMessage(), which this isolated preload
 * validates before forwarding the event to the main process.
 *
 * @param {string | null} iconUrl
 */
async function installNotificationShim(iconUrl) {
  const serializedIconUrl = JSON.stringify(iconUrl || "");
  const serializedMessageSource = JSON.stringify(MESSAGE_SOURCE);
  const serializedMessageType = JSON.stringify(MESSAGE_NOTIFICATION_CLICKED);

  const script = `
    (() => {
      if (window.__VOICE_DESKTOP_NOTIFICATION_SHIM_INSTALLED__) {
        return;
      }

      window.__VOICE_DESKTOP_NOTIFICATION_SHIM_INSTALLED__ = true;

      const OldNotification = window.Notification;
      if (typeof OldNotification !== "function") {
        return;
      }

      const iconUrl = ${serializedIconUrl};
      const messageSource = ${serializedMessageSource};
      const messageType = ${serializedMessageType};

      const VoiceDesktopNotification = function (title, options) {
        const safeOptions = options ? { ...options } : {};

        // If the specified options don't include an icon for the notification, set the icon to our application icon.
        if (!safeOptions.icon && iconUrl) {
          safeOptions.icon = iconUrl;
        }

        // Create a normal Notification instance using the specified parameters.
        const notification = new OldNotification(title, safeOptions);

        // Automatically add a click handler, which notifies the isolated preload context when a click occurs.
        notification.addEventListener("click", () => {
          window.postMessage(
            {
              source: messageSource,
              type: messageType,
            },
            window.location.origin,
          );
        });

        return notification;
      };

      // Preserve the native Notification prototype and static API so Google Voice sees the same surface it expects.
      VoiceDesktopNotification.prototype = OldNotification.prototype;
      Object.setPrototypeOf(VoiceDesktopNotification, OldNotification);

      Object.defineProperty(VoiceDesktopNotification, "permission", {
        configurable: true,
        enumerable: true,
        get() {
          return OldNotification.permission;
        },
      });

      VoiceDesktopNotification.requestPermission =
        OldNotification.requestPermission.bind(OldNotification);

      window.Notification = VoiceDesktopNotification;
    })();
  `;

  try {
    await webFrame.executeJavaScript(script, true);
  } catch (error) {
    console.error("Unable to install Voice Desktop notification shim:", error);
  }
}

// Relay only the notification-shim message shape that this preload explicitly understands.
window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  if (
    !event.data ||
    event.data.source !== MESSAGE_SOURCE ||
    event.data.type !== MESSAGE_NOTIFICATION_CLICKED
  ) {
    return;
  }

  ipcRenderer.send("notification-clicked");
});

(async () => {
  // Get this application's notification icon URL from the main process.  Keeping path resolution in
  // the main process lets this preload remain compatible with Electron's sandboxed preload runtime.
  let notificationIconUrl = null;

  try {
    notificationIconUrl = await ipcRenderer.invoke("get-notification-icon-url");
  } catch (error) {
    console.error("Unable to resolve notification icon URL:", error);
  }

  // Modify JavaScript's "Notification" class such that all notifications that get generated will have a
  // click handler attached to them which fires a "notification-clicked" event back at the main process.
  await installNotificationShim(notificationIconUrl);

  // Start DOM-based application observers once the document can be safely queried.
  if (document.readyState === "loading") {
    window.addEventListener(
      "DOMContentLoaded",
      () => {
        installNotificationCountObserver();
        installBlankPageWatchdog();
      },
      { once: true },
    );
  } else {
    installNotificationCountObserver();
    installBlankPageWatchdog();
  }
})();
