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

// ====================================================================================================================
// GIF launcher + native attachment bridge
// ====================================================================================================================

/**
 * This code runs in Electron's isolated/sandboxed preload, NOT in Google's JavaScript world.
 * It adds only a launcher button. The GIPHY UI is in a separate, local BrowserWindow so Google's
 * CSP and authentication are untouched, and the key is never exposed to voice.google.com.
 */
let gifLauncherEnabled = true;
let gifComposerObserver = null;
let gifRefreshTimer = null;
let lastGifComposer = null;
let gifToastTimer = null;

function visibleGifElement(node) {
  if (!node || !node.isConnected || node.closest('[aria-hidden="true"]')) return false;
  const rect = node.getBoundingClientRect();
  return rect.height >= 12 && rect.width >= 40 && rect.bottom > 0 && rect.top < window.innerHeight;
}

/**
 * Google changes Voice's generated class names frequently. Identify the active message editor by
 * accessibility hints and on-screen location rather than a single brittle Angular CSS selector.
 */
function findGifComposer() {
  const selectors = [
    'textarea[aria-label*="message" i]',
    'textarea[placeholder*="message" i]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[role="textbox"][aria-label*="message" i]',
    '[contenteditable="true"][data-placeholder*="message" i]',
    'gv-message-input textarea',
    'gv-message-input [contenteditable="true"]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
  ];
  const editors = Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))));
  const scored = editors.filter(visibleGifElement).map((element) => {
    const rect = element.getBoundingClientRect();
    const label = [element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.getAttribute("data-placeholder")].join(" ");
    const score =
      (/message|text message|sms|type a/i.test(label) ? 120 : 0) +
      (element.closest('gv-conversation-detail, [class*="conversation" i], [class*="message-input" i]') ? 25 : 0) +
      (rect.top > window.innerHeight * 0.48 ? 20 : -45) +
      (element.tagName === "TEXTAREA" ? 5 : 0) +
      Math.round(rect.top / Math.max(1, window.innerHeight) * 10);
    return { element, rect, score };
  }).sort((a, b) => b.score - a.score);
  // Do not insert a GIF button by a global search field or an unfamiliar login page form.
  return scored.length && scored[0].score >= 5 ? scored[0].element : null;
}

/** Attempt to place the GIF button immediately beside Voice's own image-attachment control. */
function findGifToolbarAnchor(editor) {
  if (!editor) return null;
  const rect = editor.getBoundingClientRect();
  const matchingButtons = Array.from(document.querySelectorAll('button[aria-label], button[title], [role="button"][aria-label]'))
    .filter((button) => {
      const label = [button.getAttribute("aria-label"), button.getAttribute("title")].join(" ");
      if (!/attach|add image|select image|insert image|photo|upload image/i.test(label)) return false;
      if (!visibleGifElement(button)) return false;
      const bounds = button.getBoundingClientRect();
      return Math.abs(bounds.bottom - rect.bottom) < 135 && Math.abs(bounds.left - rect.left) < 950;
    });
  matchingButtons.sort((a, b) => {
    const distance = (node) => Math.abs(node.getBoundingClientRect().bottom - rect.bottom);
    return distance(a) - distance(b);
  });
  return matchingButtons[0] || null;
}

function makeGifLauncher() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "voice-desktop-gif-trigger";
  button.setAttribute("aria-label", "Search and attach GIF");
  button.title = "Search GIFs (Ctrl+Shift+G)";
  button.textContent = "GIF";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    ipcRenderer.send("gif-toggle-picker", { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  });
  return button;
}

function updateGifLauncher() {
  if (window.location.origin !== "https://voice.google.com") return;
  const oldButton = document.querySelector(".voice-desktop-gif-trigger");
  if (!gifLauncherEnabled) {
    oldButton?.remove();
    return;
  }
  const editor = findGifComposer();
  if (!editor) {
    oldButton?.remove();
    lastGifComposer = null;
    return;
  }
  if (oldButton && lastGifComposer === editor && oldButton.isConnected) return;
  oldButton?.remove();
  lastGifComposer = editor;
  const button = makeGifLauncher();
  const anchor = findGifToolbarAnchor(editor);
  if (anchor) {
    anchor.insertAdjacentElement("afterend", button);
  } else {
    // Fallback when Voice's attachment icon has no accessible label. Keep the launcher
    // adjacent to the text field, rather than modifying Google's text input itself.
    editor.parentElement?.insertBefore(button, editor);
  }
}

function scheduleGifLauncherRefresh() {
  if (gifRefreshTimer) return;
  gifRefreshTimer = setTimeout(() => {
    gifRefreshTimer = null;
    updateGifLauncher();
  }, 220);
}

function installGifLauncher() {
  if (!document.documentElement || window.location.origin !== "https://voice.google.com") return;
  ipcRenderer.invoke("gif-is-enabled").then((enabled) => {
    gifLauncherEnabled = enabled;
    updateGifLauncher();
  }).catch(() => {});
  gifComposerObserver = new MutationObserver(scheduleGifLauncherRefresh);
  gifComposerObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: false });
  window.addEventListener("resize", scheduleGifLauncherRefresh);
}

ipcRenderer.on("gif-enabled-changed", (_event, enabled) => {
  gifLauncherEnabled = enabled === true;
  updateGifLauncher();
});

/** Look for the native image input; Google Voice may keep it hidden until selection. */
function findGifFileInput() {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((input) => {
    const accept = (input.getAttribute("accept") || "").toLowerCase();
    return !input.disabled && (!accept || /image|gif|\*/.test(accept));
  });
  const editor = findGifComposer();
  if (editor) {
    const local = inputs.find((input) => {
      const parent = input.closest("form") || input.parentElement?.parentElement;
      return parent && (parent.contains(editor) || editor.closest("form") === parent);
    });
    if (local) return local;
  }
  return inputs.length === 1 ? inputs[0] : null;
}

/**
 * If Google Voice rejects a simulated input change, the picker offers a manual Save GIF fallback.
 * This function NEVER clicks Send or talks to Google's undocumented messaging endpoints.
 */
async function attachVoiceGif(payload) {
  if (window.location.origin !== "https://voice.google.com") {
    throw new Error("Open a Google Voice conversation before attaching a GIF.");
  }
  const editor = findGifComposer();
  if (!editor) throw new Error("Open a message thread first. No active message composer was found.");
  if (!(payload.bytes instanceof Uint8Array) || payload.bytes.byteLength > 2 * 1024 * 1024) {
    throw new Error("Invalid GIF payload or file exceeds 2 MB.");
  }
  const header = String.fromCharCode(...payload.bytes.subarray(0, 6));
  if (header !== "GIF89a" && header !== "GIF87a") throw new Error("Selected file is not a GIF.");
  const filename = /^voice-gif-[a-zA-Z0-9_-]+\.gif$/.test(payload.filename)
    ? payload.filename : "voice-gif.gif";
  const file = new File([payload.bytes], filename, { type: "image/gif" });
  const data = new DataTransfer();
  data.items.add(file);

  const input = findGifFileInput();
  if (input) {
    input.files = data.files;
    // React/Angular often listen for change events rather than programmatic file assignment.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // Newer Google Voice builds support clipboard-image paste. Try this only if the native
  // file input is unavailable, and report uncertainty instead of claiming a successful upload.
  try {
    const before = document.querySelectorAll('[class*="attachment-preview" i], [class*="image-preview" i], [aria-label*="remove image" i]').length;
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const after = document.querySelectorAll('[class*="attachment-preview" i], [class*="image-preview" i], [aria-label*="remove image" i]').length;
    if (after > before) return;
  } catch {
    // Paste support is not consistent across all Google Voice web builds.
  }
  throw new Error("Google Voice did not expose a compatible image attachment input. Use Save GIF in the picker, then attach it with Voice's Select image button.");
}

ipcRenderer.on("gif-attach-request", async (_event, payload) => {
  if (!payload || !Number.isInteger(payload.id)) return;
  try {
    await attachVoiceGif(payload);
    ipcRenderer.send("gif-attach-result", { id: payload.id, ok: true });
  } catch (error) {
    ipcRenderer.send("gif-attach-result", { id: payload.id, ok: false, error: String(error.message || "Attachment failed.").slice(0, 300) });
  }
});

// Install after the DOM is available. MutationObserver handles Voice's client-side SPA navigation.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", installGifLauncher, { once: true });
} else {
  installGifLauncher();
}
