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

// ====================================================================================================================
// Mini call controller · Call state and native Google Voice call buttons
// ====================================================================================================================

// A small in-app launcher offers the same Show/Hide control as the Windows tray.
// It never accesses remote page data or invokes a Google Voice API.
let miniCallLauncherStatus = { phase: 'idle', visible: false, enabled: true };
function miniCallUpdateLauncher() {
  const button = document.getElementById?.('voice-desktop-mini-toggle');
  if (!button) return;
  const active = miniCallLauncherStatus.phase !== 'idle';
  button.disabled = !miniCallLauncherStatus.enabled;
  button.classList.toggle('is-live', active);
  button.classList.toggle('is-ringing', miniCallLauncherStatus.phase === 'incoming');
  button.classList.toggle('is-open', miniCallLauncherStatus.visible);
  button.setAttribute('aria-pressed', String(!!miniCallLauncherStatus.visible));
  const label = (miniCallLauncherStatus.visible ? 'Hide' : 'Show') + ' floating call controller';
  button.setAttribute('aria-label', label);
  button.title = label + (active ? ' · ' + miniCallLauncherStatus.phase : '');
  const caption = button.querySelector('.voice-desktop-mini-label');
  if (caption) caption.textContent = miniCallLauncherStatus.visible ? 'Hide mini call' : 'Mini call';
}
function miniCallInstallLauncher() {
  if (!document.body || !document.createElement || window.location.origin !== 'https://voice.google.com') return;
  if (document.getElementById('voice-desktop-mini-toggle')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'voice-desktop-mini-toggle';
  button.className = 'voice-desktop-mini-toggle';
  // Local inline SVG is decorative only; never use remote HTML or scripts.
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none"><path d="M6.5 4.4c-.4-.4-.9-.5-1.4-.2L3 5.4a2 2 0 0 0-1 2C3 15 9 21 16.7 22a2 2 0 0 0 2-1l1.2-2.1a1.2 1.2 0 0 0-.2-1.5l-3-3a1.3 1.3 0 0 0-1.5-.2l-2.1 1.2a13 13 0 0 1-4.5-4.5l1.2-2.1a1.3 1.3 0 0 0-.2-1.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span class="voice-desktop-mini-label">Mini call</span><span class="voice-desktop-mini-dot" aria-hidden="true"></span>';
  button.addEventListener('click', () => ipcRenderer.send('mini-call-toggle-from-voice'));
  document.body.appendChild(button);
  miniCallUpdateLauncher();
  ipcRenderer.send('mini-call-request-ui-state');
}
ipcRenderer.on('mini-call-visibility', (_event, status) => {
  if (!status || !['idle', 'incoming', 'outgoing', 'screening', 'active'].includes(status.phase)) return;
  miniCallLauncherStatus = {
    phase: status.phase, visible: status.visible === true, enabled: status.enabled !== false,
  };
  miniCallUpdateLauncher();
});


/**
 * Google Voice has no supported desktop call-control API. Observe the currently rendered call UI and
 * interact with its own accessible controls. Nothing here invokes undocumented Google endpoints.
 * A conservative detector is intentional: false-positive "incoming" calls are worse than a missing
 * popup. The File > Mini call controller menu can always open the widget for troubleshooting.
 */
const MINI_CALL_ACTION_LABELS = {
  answer: /^(?:answer|accept|pick\s*up|join)(?:\s+(?:the\s+)?(?:incoming\s+)?call)?$/i,
  decline: /^(?:decline|reject|ignore|dismiss)(?:\s+(?:the\s+)?call)?$/i,
  hangup: /^(?:end\s*(?:the\s+)?call|hang\s*up|hangup|disconnect(?:\s+(?:the\s+)?call)?|leave\s*call|cancel\s*call|call_end|phone_disabled|end)$/i,
  mute: /^(?:mute|unmute)(?:\s+(?:microphone|mic|call|audio))?$/i,
  keypad: /^(?:(?:open|show|hide|close|toggle)\s+)?(?:key\s*pad|dial\s*pad|number\s*pad|dtmf|dialpad|dialpad_toggle)(?:\s+(?:button|keys))?$/i,
};
const MINI_CALL_ROOT_SELECTOR = [
  'gv-call-widget', 'gv-call-dialog', 'gv-call-panel', 'gv-call-view',
  'gv-incoming-call-dialog', 'gv-in-call', 'gv-active-call', 'gv-call-screen',
  '[class*="call-widget" i]', '[class*="call-dialog" i]',
  '[class*="in-call" i]', '[class*="call-controls" i]',
  '[class*="call-screen" i]', '[role="dialog"]',
].join(',');

// Google Voice sometimes uses a Material icon name instead of an aria-label on the clickable button.
const MINI_CALL_ICON_NAMES = {
  call_end: 'End call', phone_disabled: 'End call',
  dialpad: 'Keypad', dialpad_toggle: 'Keypad', keyboard: 'Keypad',
  mic_off: 'Unmute', mic: 'Mute', microphone: 'Mute',
  call: 'Answer', phone: 'Answer', phone_in_talk: 'Answer',
};

function miniCallVisible(element) {
  if (!element || !element.isConnected || element.disabled || element.getAttribute('aria-disabled') === 'true' ||
      element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  // Consult the owning document for same-origin iframe controls.
  const getStyle = element.ownerDocument?.defaultView?.getComputedStyle || window.getComputedStyle;
  const style = getStyle.call(element.ownerDocument?.defaultView || window, element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return element.getClientRects().length > 0;
}

/** Prefer user-facing accessible labels, then Material icon names; never rely on generated ng-tns classes. */
function miniCallLabel(element) {
  const attrs = [
    element.getAttribute('aria-label'), element.getAttribute('title'),
    element.getAttribute('data-tooltip'), element.getAttribute('mattooltip'),
    element.getAttribute('data-tooltip-content'), element.getAttribute('data-testid'),
  ];
  for (const raw of attrs) {
    const label = String(raw || '').trim().replace(/\s+/g, ' ');
    if (label) return label;
  }
  // A real Angular Material mat-icon may contain "call_end" but no aria-label on its parent.
  const icon = element.querySelector?.('mat-icon, .material-icons, .material-symbols-outlined, .material-symbols-rounded');
  const iconName = String(icon?.textContent || '').trim().toLowerCase();
  if (MINI_CALL_ICON_NAMES[iconName]) return MINI_CALL_ICON_NAMES[iconName];
  // The icon alone can also be the button's content.
  const value = String(element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 85);
  return MINI_CALL_ICON_NAMES[value.toLowerCase()] || value;
}

function miniCallButtons(root = document) {
  return [...root.querySelectorAll('button, [role="button"]')].filter(miniCallVisible);
}

function miniCallFindButton(buttons, action) {
  return buttons.find((button) => {
    if (MINI_CALL_ACTION_LABELS[action].test(miniCallLabel(button))) return true;
    // An outer Material control may have a generic tooltip but the nested icon still
    // identifies its action (e.g. an aria-label of "Call controls" + icon call_end).
    const icon = button.querySelector?.('mat-icon, .material-icons, .material-symbols-outlined, .material-symbols-rounded');
    const iconLabel = MINI_CALL_ICON_NAMES[String(icon?.textContent || '').trim().toLowerCase()];
    return !!iconLabel && MINI_CALL_ACTION_LABELS[action].test(iconLabel);
  });
}

/**
 * Restrict metadata and controls to the nearest live call surface, not the global Messages/Calls
 * navigation. Use a dialog first, followed by Google-specific call containers.
 */
function miniCallSurface(button) {
  const root = button.closest(MINI_CALL_ROOT_SELECTOR);
  if (root) return root;
  // No explicit call widget? Look for a compact parent with multiple call-specific controls.
  let parent = button.parentElement;
  for (let i = 0; parent && i < 6; i++, parent = parent.parentElement) {
    const bounds = parent.getBoundingClientRect();
    if (bounds.height > 30 && bounds.height < 700 && bounds.width < 960) {
      const labels = miniCallButtons(parent).map(miniCallLabel);
      const isActiveCall = labels.some((label) => MINI_CALL_ACTION_LABELS.keypad.test(label)) &&
        labels.some((label) => MINI_CALL_ACTION_LABELS.hangup.test(label));
      const isIncomingCall = labels.some((label) => MINI_CALL_ACTION_LABELS.answer.test(label)) &&
        labels.some((label) => MINI_CALL_ACTION_LABELS.decline.test(label));
      if (labels.length >= 2 && (isActiveCall || isIncomingCall)) return parent;
    }
  }
  return button.parentElement;
}

function miniCallGetParty(root, phase) {
  if (!root) return '';
  // Prefer explicit caller fields. Do not use the app header, conversation list, or document title.
  const known = root.querySelectorAll('[data-caller-name], [data-caller-number], [class*="caller-name" i], [class*="contact-name" i], [class*="phone-number" i]');
  for (const node of known) {
    const value = String(node.getAttribute('data-caller-name') || node.getAttribute('data-caller-number') || node.textContent || '').trim();
    if (value.length >= 2 && value.length <= 75) return value;
  }
  const title = root.querySelector('h1,h2,h3,[role="heading"]');
  if (title) {
    const value = String(title.textContent || '').trim();
    if (value.length > 1 && value.length < 65 && !/^(?:calling|incoming|outgoing|call|screening|active call)$/i.test(value)) return value;
  }
  // Don't guess which contact to display if Google exposes only broad page markup.
  return phase === 'incoming' ? 'Incoming Google Voice call' : 'Google Voice call';
}

/**
 * Only a genuine in-call surface (pickup/hangup/call-specific dialog) is eligible to summon the
 * widget. Merely visiting the Calls tab or opening the ordinary dialer cannot trigger a popup.
 */
function miniCallReadSnapshot() {
  if (window.location.origin !== 'https://voice.google.com') return { phase: 'idle' };
  const buttons = miniCallButtons();
  const answer = miniCallFindButton(buttons, 'answer');
  const hangup = miniCallFindButton(buttons, 'hangup');
  // The initial Answer button disappears while Google Voice moves to its audio screening prompt.
  // Keep the already-observed incoming call alive even when neither Answer nor Hang Up exists yet.
  // This is a bounded post-answer hold, NEVER a new call detected from the idle dialer.
  if (!answer && !hangup) {
    if (!miniCallIsPostAnswerPending()) return { phase: 'idle' };
    const surface = miniCallFindPostAnswerSurface();
    // A bounded screening timer is NOT evidence that a call still exists.
    // If the original call surface disappears, let the regular 2s debounce close
    // the mini window, including when the user hangs up inside Google Voice.
    if (!surface) {
      // Google can unmount the panel for a moment immediately after Answer.
      // Allow a short transition window, but never hold a disconnected call for 75s.
      if (!miniCallPostAnswerMissingSince) miniCallPostAnswerMissingSince = Date.now();
      if (Date.now() - miniCallPostAnswerMissingSince >= 4000) return { phase: 'idle' };
      return { phase: miniCallPostAnswerStage === 'screening' ? 'screening' : 'active',
        direction: 'incoming', party: miniCallPostAnswerParty || 'Google Voice call',
        canAnswer: false, canDecline: false, canHangup: false, canMute: false,
        muted: false, canKeypad: false,
        awaitingScreening: miniCallPostAnswerStage === 'screening' };
    }
    miniCallPostAnswerMissingSince = 0;
    const local = miniCallButtons(surface);
    const keypad = miniCallFindButton(local, 'keypad');
    return {
      phase: miniCallPostAnswerStage === 'screening' ? 'screening' : 'active',
      direction: 'incoming', party: miniCallPostAnswerParty || 'Incoming Google Voice call',
      canAnswer: false, canDecline: false, canHangup: false, canMute: false, muted: false,
      canKeypad: !!(keypad || (surface && miniCallFindKeypadDigits(surface))),
      awaitingScreening: miniCallPostAnswerStage === 'screening',
    };
  }
  const root = miniCallSurface(answer || hangup);
  const localButtons = miniCallButtons(root);
  const callAnswer = miniCallFindButton(localButtons, 'answer') || answer;
  const callDecline = miniCallFindButton(localButtons, 'decline');
  const callHangup = miniCallFindButton(localButtons, 'hangup') || hangup;
  const callMute = miniCallFindButton(localButtons, 'mute');
  const callKeypad = miniCallFindButton(localButtons, 'keypad');
  const context = String(root?.innerText || '').slice(0, 1800);
  const callContext = /\b(?:incoming\s+call|call\s+from|calling|dialing|ringing|screen(?:ing)?\s+call)\b/i.test(context);
  // Never treat an unrelated "Answer" button as a ringing call.
  if (callAnswer && !callDecline && !callContext && !/gv-call|in-call|call-widget|call-dialog/i.test(root?.tagName || root?.className || '')) {
    return { phase: 'idle' };
  }
  let phase = callAnswer ? 'incoming' : 'active';
  if (!callAnswer && /\b(?:calling|dialing|ringing|connecting|outgoing call)\b/i.test(context)) phase = 'outgoing';
  if (!callAnswer && /\b(?:press\s*1|press\s*2|screen(?:ing)?\s+call)\b/i.test(context)) phase = 'screening';
  // The screening instructions can be AUDIO ONLY; do not rely on visible "press 1" text.
  if (!callAnswer && miniCallIsPostAnswerPending()) {
    phase = miniCallPostAnswerStage === 'screening' ? 'screening' : 'active';
  }
  const canKeypad = !!(callKeypad || miniCallFindKeypadDigits(root));
  return {
    phase,
    party: (miniCallIsPostAnswerPending() && !callAnswer &&
      miniCallGetParty(root, phase) === 'Google Voice call')
      ? miniCallPostAnswerParty : miniCallGetParty(root, phase),
    canAnswer: !!callAnswer,
    canDecline: !!callDecline,
    canHangup: !!callHangup,
    canMute: !!callMute,
    muted: !!(callMute && /^unmute/i.test(miniCallLabel(callMute))),
    canKeypad,
    awaitingScreening: miniCallIsPostAnswerPending() && miniCallPostAnswerStage === 'screening',
  };
}

/**
 * Google Voice has used button, role=button and div-based DTMF keys across UI revisions.
 * Read ONLY an individual key's accessible name / numeric attribute: never parse a phone
 * number from the ordinary dialer input or manufacture keypad events.
 */
function miniCallKeyDigit(element) {
  if (!element) return null;
  const sources = [
    element.getAttribute?.('data-digit'), element.getAttribute?.('data-key'),
    element.getAttribute?.('data-dtmf'), element.getAttribute?.('data-value'),
    element.getAttribute?.('data-number'), element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'), element.getAttribute?.('value'),
    element.textContent,
  ];
  const words = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9' };
  for (const raw of sources) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    // Reject large containers, phone numbers and unrelated page copy. This function only
    // recognizes labels of individual digits, not arbitrary text containing a number.
    if (!value || value.length > 28) continue;
    const normalized = value.replace(/^(?:(?:press|tap|send)\s+)?(?:dialpad|keypad|dtmf|digit|number|key)\s*[:#-]?\s*/, '');
    if (/^[0-9]$/.test(normalized)) return normalized;
    if (words[normalized]) return words[normalized];
    const match = normalized.match(/^([0-9])(?:[\s,.:)\]-]|[a-z]{2,5}$)/);
    if (match) return match[1];
    // Some versions name keys "one (1)" rather than "digit 1".
    const named = normalized.match(/^(zero|one|two|three|four|five|six|seven|eight|nine)\s*\([0-9]\)$/);
    if (named && words[named[1]] === named[2]) return named[2];
  }
  return null;
}

// The active keypad is often a material-looking custom div with child labels. Ascend
// to the real clickable key, not an SVG/text span; never climb up to the entire dialpad.
function miniCallKeyControl(node, digit) {
  const recognized = node.closest?.('button, [role="button"], [data-digit], [data-key], [data-dtmf], [data-number], [class*="digit-button" i], [class*="keypad-key" i], [class*="dialpad-key" i], gv-keypad-button, gv-dialpad-button, gv-dialpad-key');
  if (recognized && miniCallKeyDigit(recognized) === digit) return recognized;
  let parent = node.parentElement;
  for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
    const tag = String(parent.tagName || '').toLowerCase();
    const name = String(parent.className || '');
    if ((/\b(?:key|digit|number|dtmf|dialpad)[-\s_]/i.test(name) || /^(?:gv-)?(?:dtmf|dialpad|keypad)[-]/i.test(tag)) &&
      miniCallKeyDigit(parent) === digit) return parent;
  }
  // An exact child digit is preferable to clicking a large ancestor containing many digits.
  return node;
}

/**
 * Search within an active call, not just the light DOM of one Angular component.
 * Voice occasionally portals the dialpad outside gv-in-call, and some builds wrap
 * the actual controls in an open shadow root or same-origin iframe.
 * Never try to read cross-origin iframe contents or use unofficial Voice endpoints.
 */
function miniCallDomScopes(root, maxScopes = 36) {
  const scopes = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length && scopes.length < maxScopes) {
    const current = queue.shift();
    if (!current || seen.has(current) || typeof current.querySelectorAll !== 'function') continue;
    seen.add(current);
    scopes.push(current);
    // Open shadow roots are public DOM; closed roots remain intentionally inaccessible.
    for (const element of current.querySelectorAll('*')) {
      if (element.shadowRoot && !seen.has(element.shadowRoot)) queue.push(element.shadowRoot);
    }
    // Only same-origin, accessible frames can be inspected from the Voice preload.
    for (const frame of current.querySelectorAll('iframe')) {
      try {
        if (miniCallVisible(frame) && frame.contentDocument &&
            frame.contentWindow?.location?.origin === window.location.origin) queue.push(frame.contentDocument);
      } catch {
        // Cross-origin content must never be accessed by this integration.
      }
    }
  }
  return scopes;
}

/**
 * Sidebar exclusions are conditional: some Voice versions mount the LIVE call
 * inside gv-call-sidebar! The previous unconditional closest('gv-call-sidebar')
 * excluded the genuine DTMF keys as well as the unrelated idle dialer.
 */
function miniCallIsIdleDialerDigit(node) {
  // Critical: Voice nests its ordinary gv-make-call-panel INSIDE gv-in-call, even
  // when the page has already returned to idle. The outer tag is not DTMF evidence.
  // Do this exclusion BEFORE testing for gv-in-call ancestry.
  if (node?.closest?.('gv-make-call-panel, gv-make-call-panel-ng2, gv-recipient-picker')) return true;
  const inCall = node?.closest?.('gv-in-call, gv-active-call, gv-call-panel, gv-in-call-status, gv-call-dialog, gv-call-widget, gv-call-screen');
  if (inCall) return false;
  return !!node?.closest?.('gv-call-sidebar');
}

/**
 * Google Voice's November 2026 in-call UI exposes a genuine telephone grid as
 * gv-in-call > ... > section.dialpad-container with twelve visible <button>s.
 * Its buttons are not consistently labelled (the user's diagnostics recognized
 * only "1"), so our old 3+ labelled-digit rule rejected a real working pad.
 *
 * This probe is deliberately narrow: never infer digits from the ordinary
 * gv-make-call-panel and never use unrelated numeric content as a DTMF target.
 */
const MINI_CALL_TEL_GRID = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/**
 * Limit DTMF discovery to the REAL native in-call dialpad. The live v7 trace
 * showed that Google mounts <gv-dialpad> inside section.dialpad-container with
 * 12 clickable buttons, but only a fraction of them expose useful text labels.
 * Never use the separate <gv-make-call-panel> dialer, even though it also nests
 * under gv-in-call after a call has ended.
 */
function miniCallLivePadButtons(pad) {
  if (!pad || !miniCallVisible(pad) || miniCallIsIdleDialerDigit(pad)) return null;
  const live = pad.closest?.('gv-in-call, gv-in-call-status, gv-active-call, gv-call-panel');
  if (!live || !miniCallVisible(live)) return null;
  // Only operate during a detected answered call. An empty gv-in-call host is not evidence.
  const phase = miniCallReadSnapshot().phase;
  if (phase === 'idle' || phase === 'incoming') return null;
  const buttons = [...pad.querySelectorAll('button')].filter(miniCallVisible);
  if (buttons.length !== 12 || buttons.some((button) => button.disabled ||
      button.getAttribute?.('aria-disabled') === 'true')) return null;
  return buttons;
}

/**
 * The real user clicked a working 1 under gv-dialpad. If other digit labels
 * are absent, infer its immediate right-hand neighbor ONLY when the three
 * sibling cells share one row and each contains precisely one native button.
 * This is narrower and safer than assuming all 12 buttons are in DOM order.
 */
function miniCallSiblingTwoFromOne(one, buttons) {
  if (!one || !buttons.includes(one)) return null;
  const cell = one.parentElement;
  const row = cell?.parentElement;
  if (!row || !cell || !row.children || row.children.length !== 3 || row.children[0] !== cell) return null;
  const cells = [...row.children];
  const rowKeys = cells.map((node) => [...node.querySelectorAll('button')]);
  if (rowKeys.some((keys) => keys.length !== 1 || !buttons.includes(keys[0]))) return null;
  const candidate = rowKeys[1][0];
  const label = miniCallKeyDigit(candidate);
  return label && label !== '2' ? null : candidate;
}

/**
 * Prefer actual button labels over the previous strict 12-button index rule.
 * A single readable 1 inside a verified native pad is actionable; unlabelled
 * 2 is resolved from the three-cell row containing 1 when possible.
 */
function miniCallFindNativeInCallGrid(digit, scope = document) {
  if (!['1', '2'].includes(digit)) return null;
  const pads = [...scope.querySelectorAll('gv-dialpad, section.dialpad-container, gv-in-call-keypad, gv-in-call-dialpad')];
  // Prefer the innermost native component; outer section may contain extra UI buttons.
  pads.sort((a, b) => Number(String(b.tagName).toLowerCase() === 'gv-dialpad') -
    Number(String(a.tagName).toLowerCase() === 'gv-dialpad'));
  for (const pad of pads) {
    const keys = miniCallLivePadButtons(pad);
    if (!keys) continue;
    const matching = keys.filter((button) => miniCallKeyDigit(button) === digit);
    let target = matching.length === 1 ? matching[0] : null;
    let method = 'native-explicit-label';
    if (!target && digit === '2') {
      const labelledOnes = keys.filter((button) => miniCallKeyDigit(button) === '1');
      const learnedOne = miniCallFindLearnedKey('1');
      const one = learnedOne && keys.includes(learnedOne) ? learnedOne
        : labelledOnes.length === 1 ? labelledOnes[0] : null;
      target = miniCallSiblingTwoFromOne(one, keys);
      method = 'native-sibling-of-confirmed-one';
    }
    // Fallback only if geometry proves a real 4x3 telephone keypad, rather
    // than relying on the raw querySelectorAll order of Angular's DOM.
    if (!target) {
      const ordered = miniCallGridGeometry(keys);
      if (ordered) {
        const index = MINI_CALL_TEL_GRID.indexOf(digit);
        const key = ordered[index];
        const label = miniCallKeyDigit(key);
        if (!label || label === digit) {
          target = key;
          method = 'native-geometric-grid';
        }
      }
    }
    if (target) {
      miniCallTrace('dtmf.nativeDiscovery', `digit=${digit} method=${method} pad=${String(pad.tagName).toLowerCase()}`);
      return { target, pad, keys, recognized: keys.filter(miniCallKeyDigit).length,
        index: keys.indexOf(target), method };
    }
  }
  return null;
}

/**
 * Establish row/column order from actual positions, not DOM order. Return an
 * ordered twelve-key array only for a geometrically regular telephone grid.
 */
function miniCallGridGeometry(buttons) {
  const points = buttons.map((node) => {
    const r = node.getBoundingClientRect?.();
    return r && r.width >= 12 && r.height >= 12 ? { node, x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (points.some((point) => !point)) return null;
  const sorted = points.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const point of sorted) {
    const row = rows.find((item) => Math.abs(item[0].y - point.y) < 12);
    if (row) row.push(point);
    else rows.push([point]);
  }
  if (rows.length !== 4 || rows.some((row) => row.length !== 3)) return null;
  rows.sort((a, b) => a[0].y - b[0].y);
  rows.forEach((row) => row.sort((a, b) => a.x - b.x));
  if (rows.some((row) => row[1].x - row[0].x < 12 || row[2].x - row[1].x < 12)) return null;
  const ordered = rows.flat().map((point) => point.node);
  const labels = ordered.map(miniCallKeyDigit);
  // Reject a pad with contradictory explicit numbers even when geometry matches.
  if (labels.some((label, index) => label && label !== MINI_CALL_TEL_GRID[index])) return null;
  return ordered;
}

/** Trusted manual 1/2 clicks are recorded without requiring grid verification. */
function miniCallGridClickedDigit(button) {
  const pad = button.closest?.('gv-dialpad, section.dialpad-container, gv-in-call-keypad, gv-in-call-dialpad');
  const keys = miniCallLivePadButtons(pad);
  if (!keys || !keys.includes(button)) return null;
  const labelledOnes = keys.filter((key) => miniCallKeyDigit(key) === '1');
  if (labelledOnes.length === 1) {
    if (button === labelledOnes[0]) return '1';
    if (button === miniCallSiblingTwoFromOne(labelledOnes[0], keys)) return '2';
  }
  const ordered = miniCallGridGeometry(keys);
  if (!ordered) return null;
  const index = ordered.indexOf(button);
  return index === 0 ? '1' : index === 1 ? '2' : null;
}

function miniCallDigitCandidates(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const selector = [
    'button', '[role="button"]', '[data-digit]', '[data-key]', '[data-dtmf]', '[data-number]',
    '[data-value]', '[tabindex="0"]', '[role="gridcell"]',
    'gv-keypad-button', 'gv-dialpad-button', 'gv-dialpad-key',
    '[class*="digit-button" i]', '[class*="number-button" i]',
    '[class*="dialpad-key" i]', '[class*="keypad-key" i]',
    '[class*="dialpad-digit" i]', '[class*="dtmf" i]',
    '[class*="dialpad-button" i]', '[class*="keypad-button" i]',
    // Some Angular components render an unlabelled div containing an SVG or text digit.
    'span', 'div', 'mat-icon', 'svg[role="button"]', 'g[role="button"]', 'svg text',
  ].join(',');
  const controls = [];
  for (const scope of miniCallDomScopes(root)) {
    const nodes = [...new Set([...miniCallButtons(scope), ...scope.querySelectorAll(selector)])];
    for (const node of nodes) {
      const digit = miniCallKeyDigit(node);
      if (digit === null || !miniCallVisible(node) || miniCallIsIdleDialerDigit(node)) continue;
      const control = miniCallKeyControl(node, digit);
      if (!miniCallVisible(control) || control.disabled || control.getAttribute?.('aria-disabled') === 'true') continue;
      controls.push(control);
    }
  }
  return [...new Set(controls)];
}

/**
 * A numeric label alone is NOT an in-call DTMF key. Google Voice may show a
 * number preview and the idle dialer while the actual tone pad is open.
 * Validate a group of related, explicitly labelled keypad controls instead.
 */
function miniCallHasExplicitDigitLabel(node, digit) {
  if (!node) return false;
  const label = [node.getAttribute?.('aria-label'), node.getAttribute?.('data-digit'),
    node.getAttribute?.('data-dtmf'), node.getAttribute?.('data-key'),
    node.getAttribute?.('title')].filter(Boolean).map((value) => String(value).toLowerCase());
  return label.some((value) => /^(?:digit|key|dtmf|keypad|dialpad|number)\s*[:#-]?\s*[0-9]$/.test(value.trim()) &&
    miniCallKeyDigit(node) === digit);
}

function miniCallInLiveKeypad(node) {
  if (!node || miniCallIsIdleDialerDigit(node)) return false;
  const callRoot = node.closest?.('gv-in-call, gv-in-call-status, gv-active-call, gv-call-panel, gv-call-dialog, gv-call-widget, gv-call-screen, [role="dialog"]');
  if (callRoot && miniCallVisible(callRoot) &&
      (String(callRoot.tagName || '').toLowerCase() !== 'div' ||
        miniCallButtons(callRoot).some((button) => MINI_CALL_ACTION_LABELS.keypad.test(miniCallLabel(button)) ||
          MINI_CALL_ACTION_LABELS.hangup.test(miniCallLabel(button))))) return true;
  // A portalled keypad is eligible only if its own semantic markup says it's
  // a keypad AND a real in-call Hide keypad toggle is present elsewhere.
  const keypad = node.closest?.('[class*="keypad" i], [class*="dialpad" i], [class*="dtmf" i], gv-keypad, gv-dialpad');
  return !!(keypad && miniCallVisible(keypad) &&
    [...document.querySelectorAll('gv-in-call, gv-in-call-status, gv-call-panel, gv-active-call')].some((root) =>
      miniCallVisible(root) && miniCallButtons(root).some((button) => MINI_CALL_ACTION_LABELS.keypad.test(miniCallLabel(button)))));
}

/**
 * Only key-shaped groups containing BOTH 1 and 2 are eligible. The prior
 * diagnostic showed numericLeaves=8 but keypadDigits=0,1; those must NEVER
 * be mistaken for an operational keypad. A label such as `Digit 1` is stronger
 * than an incidental <div>1</div>.
 */
function miniCallVerifiedActionKeys(root, requestedDigit) {
  const eligible = miniCallDigitCandidates(root).filter((node) => miniCallInLiveKeypad(node));
  const keyCandidates = eligible.filter((node) => {
    const digit = miniCallKeyDigit(node);
    if (digit === null) return false;
    const semantic = node.matches?.('button, [role="button"], [data-digit], [data-dtmf], [data-key]') ||
      node.closest?.('[class*="keypad" i], [class*="dialpad" i], [class*="dtmf" i]');
    const nativeAttribute = ['data-digit', 'data-dtmf', 'data-key'].some((attr) =>
      node.getAttribute?.(attr) === digit);
    const accessibleLabel = String(node.getAttribute?.('aria-label') || '').trim();
    // Screen-reader names like '2ABC' or 'Digit 2' identify actual keys. A bare
    // '1' label remains insufficient on its own until the whole group verifies.
    return !!(semantic && (nativeAttribute || miniCallHasExplicitDigitLabel(node, digit) ||
      /^[0-9]$/.test(String(node.textContent || '').trim()) ||
      (accessibleLabel.length <= 20 && miniCallKeyDigit(node) === digit &&
        /^(?:[0-9](?:[a-z]{2,5})?|(?:digit|key|number)\s*[0-9])$/i.test(accessibleLabel))));
  });
  // A fully exposed native pad may contain up to twelve keys; two isolated
  // numeric leaves are insufficient evidence, especially without labels.
  const digits = new Set(keyCandidates.map(miniCallKeyDigit));
  const explicit = keyCandidates.filter((node) => miniCallHasExplicitDigitLabel(node, miniCallKeyDigit(node)));
  const strongKey = keyCandidates.find((node) => miniCallKeyDigit(node) === requestedDigit &&
    ['data-digit', 'data-dtmf', 'data-key'].some((attr) => node.getAttribute?.(attr) === requestedDigit));
  if (strongKey && miniCallInLiveKeypad(strongKey)) return keyCandidates;
  if (!digits.has('1') || !digits.has('2') || !digits.has(requestedDigit)) return null;
  if (digits.size < 3 && explicit.length < 2) return null;
  return keyCandidates;
}

// A manual click on Google's actual keypad can teach us its DOM route. Store
// only tag names and child indices, never labels, contacts, or phone numbers.
let miniCallLearnedDigitPaths = {};
function miniCallRelativeRoute(node) {
  // Anchor to the smallest stable keypad component. Generated Angular ng-tns classes
  // and DOM-wide positional selectors are deliberately not stored.
  const root = node?.closest?.('gv-dialpad, gv-keypad, gv-in-call-keypad, gv-in-call-dialpad, gv-in-call, gv-in-call-status, gv-active-call, gv-call-panel, gv-call-dialog, gv-call-widget, gv-call-screen');
  if (!root) return null;
  const route = [];
  for (let current = node; current && current !== root; current = current.parentElement) {
    const parent = current.parentElement;
    if (!parent) return null;
    const index = [...parent.children].indexOf(current);
    if (index < 0 || index > 95 || route.length >= 25) return null;
    route.unshift({ tag: String(current.tagName || '').toLowerCase(), index });
  }
  return { rootTag: String(root.tagName || '').toLowerCase(), route };
}

function miniCallFindLearnedKey(digit) {
  const hint = miniCallLearnedDigitPaths[digit];
  if (!hint || !/^gv-(?:dialpad|keypad|in-call-keypad|in-call-dialpad|in-call|in-call-status|active-call|call-panel|call-dialog|call-widget|call-screen)$/.test(hint.rootTag)) return null;
  const roots = [...document.querySelectorAll(hint.rootTag)].filter(miniCallVisible);
  for (const root of roots) {
    // The same gv-dialpad tag also exists in the ordinary idle dialing UI.
    // A saved path alone must NEVER make that dialer eligible for DTMF.
    if (miniCallIsIdleDialerDigit(root) || !root.closest?.('gv-in-call, gv-in-call-status, gv-active-call, gv-call-panel')) continue;
    let target = root;
    for (const step of hint.route) {
      target = target?.children?.[step.index];
      if (!target || String(target.tagName || '').toLowerCase() !== step.tag) break;
    }
    if (!target || !target.matches?.('button, [role="button"]') ||
        !miniCallVisible(target) || miniCallIsIdleDialerDigit(target)) continue;
    const nativePad = target.closest?.('gv-dialpad, gv-keypad, gv-in-call-keypad, gv-in-call-dialpad');
    if (!nativePad || !miniCallVisible(nativePad)) continue;
    // Real v7 diagnostic: manual 1 WAS captured, but the strict full-grid
    // validation excluded the same native button. A trusted recorded path may
    // be reused even with no label, provided it has not become a different digit.
    const reported = miniCallKeyDigit(target);
    if (reported && reported !== digit) continue;
    const buttons = [...nativePad.querySelectorAll('button')].filter(miniCallVisible);
    if (buttons.length < 2 || !buttons.includes(target)) continue;
    miniCallTrace('dtmf.trustedPath', `digit=${digit} root=${hint.rootTag} keys=${buttons.length}`);
    return target;
  }
  return null;
}

let miniCallLastManualKey = 'none';
function miniCallNativeDigitEvent(event) {
  // Observe the real user's click during CAPTURE, before Voice dismantles the
  // screening UI. Events sent by our controller must never train the selector.
  if (!event.isTrusted || miniCallActionBusy || !miniCallIsPostAnswerPending()) return;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  const button = path.find((node) => node?.nodeType === 1 &&
    node.matches?.('button, [role="button"]'));
  if (!button) return;
  const digit = miniCallGridClickedDigit(button) || miniCallKeyDigit(button) ||
    path.map((node) => node?.nodeType === 1 ? miniCallKeyDigit(node) : null).find((value) => value === '1' || value === '2');
  if (!['1', '2'].includes(digit)) return;

  // A user click proves what *they* selected, unlike incidental page digits.
  // Record any rejected control as well, so post-call diagnostics explain why
  // the learning process did not run.
  if (miniCallIsIdleDialerDigit(button)) {
    miniCallLastManualKey = `${digit}: excluded ordinary make-call dialer`;
    miniCallTrace('native.manualSkip', miniCallLastManualKey);
    return;
  }
  const nativePad = button.closest?.('gv-dialpad, gv-keypad, gv-in-call-keypad, gv-in-call-dialpad, [class*="in-call-keypad" i], [class*="dtmf" i], [class*="dialpad" i]');
  const callPanel = button.closest?.('gv-in-call, gv-in-call-status, gv-active-call, gv-call-panel, gv-call-dialog, gv-call-widget, gv-call-screen');
  if (!nativePad || !callPanel) {
    miniCallLastManualKey = `${digit}: clicked control not inside native in-call pad`;
    miniCallTrace('native.manualSkip', `${miniCallLastManualKey} path=${miniCallNodePath(button)}`);
    return;
  }
  const learned = miniCallRelativeRoute(button);
  if (!learned) {
    miniCallLastManualKey = `${digit}: could not create stable keypad route`;
    miniCallTrace('native.manualSkip', miniCallLastManualKey);
    return;
  }
  miniCallLearnedDigitPaths[digit] = { digit, ...learned };
  // Manual native-key presses must update the floating UI too, not only controller clicks.
  if (digit === '1' && miniCallPostAnswerStage === 'screening') {
    miniCallSetPostAnswerHold('active', miniCallLastSnapshot, callPanel);
    miniCallScheduleRefresh();
  }
  miniCallLastManualKey = `${digit}: learned ${learned.rootTag} depth=${learned.route.length}`;
  miniCallTrace('native.manualKey', `${miniCallLastManualKey} path=${miniCallNodePath(button)}`);
  ipcRenderer.send('mini-call-learned-native-digit', { digit, ...learned });
}

// Restore confirmed native routes from the application's own preferences.
ipcRenderer.invoke('mini-call-get-learned-digits').then((hints) => {
  if (hints && typeof hints === 'object') miniCallLearnedDigitPaths = { ...hints, ...miniCallLearnedDigitPaths };
}).catch(() => {});

function miniCallVerifiedKeys(candidates) {
  const keys = candidates.filter((node) => miniCallVisible(node));
  return new Set(keys.map(miniCallKeyDigit).filter(Boolean)).size >= 5 ? keys : null;
}

function miniCallFindKeypadDigits(root) {
  return miniCallVerifiedKeys(miniCallDigitCandidates(root || document));
}

/**
 * The diagnostic showed 4 identifiable digits: a native pad can have fewer keys with
 * accessible labels than the full 10. A partial keypad is safe only when this is the
 * verified live call, and the keypad was just opened or visibly says "Hide keypad".
 */
function miniCallPartialKey(root, digit, visibleBefore = null) {
  const candidates = miniCallDigitCandidates(root);
  const unique = new Set(candidates.map(miniCallKeyDigit).filter(Boolean));
  const button = candidates.find((candidate) => miniCallKeyDigit(candidate) === digit &&
    (!visibleBefore || !visibleBefore.has(candidate)));
  return button && (unique.size >= 2 || visibleBefore) ? candidates : null;
}

/**
 * Google's in-call keypad can be rendered inside the panel OR in a newly opened Angular
 * overlay. When we have just clicked the verified call's keypad toggle, new keys are
 * strong evidence even if Google has only exposed 1/2 as recognizable DOM labels.
 */
function miniCallFindRevealedKeys(root, visibleBefore, digit) {
  const scoped = root && root.isConnected ? miniCallFindKeypadDigits(root) : null;
  if (scoped) return scoped;
  if (root && root.isConnected) {
    const partial = miniCallPartialKey(root, digit, visibleBefore);
    if (partial) return partial;
  }
  // Angular CDK overlays can be siblings of the call panel rather than children.
  // Only accept NEW controls that appear after opening the verified in-call keypad.
  const revealed = miniCallDigitCandidates(document).filter((node) => !visibleBefore.has(node));
  return miniCallVerifiedKeys(revealed) ||
    (revealed.find((node) => miniCallKeyDigit(node) === digit) ? revealed : null);
}

// Search only Google Voice ACTIVE call surfaces, not the idle dialer or message composer.
// The call's keypad toggle may move from gv-in-call to gv-in-call-status / an overlay.
function miniCallFindActiveKeypadToggle(root) {
  const roots = [root, miniCallFindPostAnswerSurface()];
  const hangup = miniCallFindButton(miniCallButtons(), 'hangup');
  if (hangup) roots.push(miniCallSurface(hangup));
  for (const node of document.querySelectorAll('gv-in-call, gv-in-call-status, gv-active-call, gv-call-panel, gv-call-dialog, gv-call-widget, gv-call-screen')) {
    if (miniCallVisible(node)) roots.push(node);
  }
  const seen = new Set();
  for (const surface of roots) {
    if (!surface || seen.has(surface) || !miniCallVisible(surface)) continue;
    seen.add(surface);
    const toggles = miniCallButtons(surface).filter((node) => MINI_CALL_ACTION_LABELS.keypad.test(miniCallLabel(node)));
    if (toggles.length) {
      // A visible Hide keypad control means the keypad is already displayed.
      const hide = toggles.find((node) => /^(?:hide|close)\s/i.test(miniCallLabel(node)));
      const open = toggles.find((node) => /^(?:open|show)\s/i.test(miniCallLabel(node)));
      return { surface, toggle: hide || open || toggles[0], openToggle: open, alreadyOpen: !!hide };
    }
  }
  return null;
}

async function miniCallWaitForActiveKeypadToggle(root, timeoutMs = 1600) {
  const started = Date.now();
  do {
    const result = miniCallFindActiveKeypadToggle(root);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 110));
  } while (Date.now() - started < timeoutMs);
  return null;
}

async function miniCallWaitForKeys(root, visibleBefore, digit, timeoutMs = 3400) {
  const deadline = Date.now() + timeoutMs;
  do {
    const keys = miniCallFindRevealedKeys(root, visibleBefore, digit);
    if (keys) return keys;
    await new Promise((resolve) => setTimeout(resolve, 70));
  } while (Date.now() < deadline);
  return null;
}

/**
 * Invoke the actual native in-call <button>, which is wired to Google's Angular
 * DTMF click handler. Avoid dispatching a coordinate click at an unrelated
 * numeric leaf or behind the floating window. A click still is not proof that
 * the remote IVR has acknowledged the tone.
 */
async function miniCallClickRealGridButton(button, digit) {
  if (!button?.isConnected || !miniCallVisible(button) ||
      miniCallFindNativeInCallGrid(digit)?.target !== button) {
    throw new Error('The Google Voice in-call keypad changed before the digit was sent.');
  }
  miniCallTrace('dtmf.target', `digit=${digit} nativePad=true path=${miniCallNodePath(button)}`);
  // A trusted Chromium pointer click may be necessary for Voice's live DTMF
  // handling. The DOM .click() fallback is used only if native input fails.
  return await miniCallClickDigit(button, digit);
}

/** A disconnected call no longer exposes a visible native end-call control. */
function miniCallCurrentEndButton(root) {
  if (!root?.isConnected || !miniCallVisible(root)) return null;
  return miniCallFindButton(miniCallButtons(root), 'hangup');
}

async function miniCallWaitForEnd(root, durationMs) {
  const until = Date.now() + durationMs;
  let absentSince = 0;
  do {
    // A temporary Angular re-render must not be mistaken for call termination.
    const stillPresent = !!miniCallCurrentEndButton(root);
    if (stillPresent) absentSince = 0;
    else if (!absentSince) absentSince = Date.now();
    else if (Date.now() - absentSince >= 250) return true;
    await new Promise((resolve) => setTimeout(resolve, 85));
  } while (Date.now() < until);
  return false;
}

let miniCallLastHangupAttempt = 'none';
/** Some versions of Voice collapse the keypad on the first Hang Up interaction. */
async function miniCallEndVerifiedCall(button, root) {
  if (!miniCallCurrentEndButton(root)) throw new Error('Google Voice’s End Call control is no longer available.');
  const original = button;
  original.click();
  miniCallTrace('hangup.first', `path=${miniCallNodePath(original)}`);
  miniCallLastHangupAttempt = 'first native End Call click dispatched';
  if (await miniCallWaitForEnd(root, 1150)) {
    miniCallLastHangupAttempt = 'call controls disappeared after first click';
    miniCallClearPostAnswerHold();
    miniCallPublish({ phase: 'idle' }); // Close the floating controller only after native controls disappear.
    miniCallScheduleRefresh();
    return { ok: true, message: 'Google Voice call controls closed.' };
  }
  // Never re-target an unrelated new call; retry ONLY the same call surface.
  const retryButton = miniCallCurrentEndButton(root);
  if (!retryButton || miniCallReadSnapshot().phase === 'incoming') {
    throw new Error('Google Voice changed call state during Hang Up. Check the main call window.');
  }
  miniCallTrace('hangup.retry', `path=${miniCallNodePath(retryButton)} sameNode=${retryButton === original}`);
  miniCallLastHangupAttempt = 'first click did not end call; second native End Call click dispatched';
  retryButton.click();
  if (await miniCallWaitForEnd(root, 1650)) {
    miniCallLastHangupAttempt = 'call controls disappeared after retry';
    miniCallClearPostAnswerHold();
    miniCallPublish({ phase: 'idle' }); // One-click close even when Voice needed two native interactions.
    miniCallScheduleRefresh();
    return { ok: true, message: 'Google Voice call ended after retry.' };
  }
  miniCallLastHangupAttempt = 'End Call dispatched twice but call controls remain visible';
  miniCallTrace('hangup.unconfirmed', miniCallLastHangupAttempt);
  throw new Error('End Call was pressed twice but Google Voice still reports an active call. Use its native End Call button.');
}

/**
 * Try Chromium's trusted pointer path so a key that requires pointer events can work
 * without activating the full Google Voice window. Fall back to a native DOM click if
 * the debugging connection is unavailable or the page has no reliable coordinates.
 */
/** Convert iframe-local button rectangles to coordinates in the TOP Voice webContents. */
function miniCallTopViewportPoint(control) {
  const rect = control.getBoundingClientRect?.();
  if (!rect || rect.width <= 6 || rect.height <= 6 || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  let x = rect.x + rect.width / 2;
  let y = rect.y + rect.height / 2;
  let view = control.ownerDocument?.defaultView;
  let depth = 0;
  // Same-origin frameElement is readable; cross-origin frames are deliberately skipped.
  while (view && view !== window && depth++ < 8) {
    let frame;
    try { frame = view.frameElement; } catch { return null; }
    if (!frame) break;
    const frameRect = frame.getBoundingClientRect();
    const scaleX = frame.clientWidth ? frameRect.width / frame.clientWidth : 1;
    const scaleY = frame.clientHeight ? frameRect.height / frame.clientHeight : 1;
    x = frameRect.x + (frame.clientLeft || 0) + x * scaleX;
    y = frameRect.y + (frame.clientTop || 0) + y * scaleY;
    view = frame.ownerDocument?.defaultView;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * A successful Chromium mouse dispatch is NOT confirmation of a DTMF response.
 * We return an explicitly unconfirmed input method for the caller to report.
 */
let miniCallLastInputContext = 'not checked';
let miniCallLastInputTransport = 'none';
let miniCallLastDeliveryMode = 'unknown';
let miniCallLastPageVisibility = 'not checked';
// The v11 live trace showed the verified DTMF key behind an unexpected hit-test
// surface while the main Voice window was translucently rendered. Preserve the
// distinction between locating the button and actually activating it.
let miniCallLastHitTest = 'not checked';
let miniCallPaintedDomFallbacks = 0;

async function miniCallClickDigit(control, digit) {
  // Determine window visibility from Electron, not document.visibilityState:
  // Chromium visibility can lag during a tray/minimize transition.
  let inputContext = null;
  try {
    inputContext = await ipcRenderer.invoke('mini-call-input-context');
  } catch (error) {
    miniCallTrace('dtmf.inputContextError', String(error?.message || error).slice(0, 110).replace(/[0-9]{3,}/g, '[numeric]'));
  }
  miniCallLastInputContext = inputContext
    ? `visible=${inputContext.visible} minimized=${inputContext.minimized} focused=${inputContext.focused}`
    : 'unavailable';
  // Useful if the remote web app itself changes behavior when backgrounded.
  miniCallLastPageVisibility = String(document.visibilityState || 'unavailable').slice(0, 24);
  miniCallTrace('dtmf.inputContext', miniCallLastInputContext);

  // Critical background-call fix: a CDP pointer event can be accepted by
  // Chromium while the minimized/hidden Voice window has no painted hit-test
  // surface. In that situation dispatch the SAME verified native button's
  // Angular click handler directly in the Voice renderer. We never click
  // arbitrary numeric text or the ordinary outbound dialer.
  if (inputContext?.interactive === false && inputContext.reason !== 'untrusted-or-closed') {
    if (!control?.isConnected || control.disabled || control.getAttribute?.('aria-disabled') === 'true') {
      throw new Error('The native in-call keypad key is no longer connected.');
    }
    control.click();
    miniCallLastInputTransport = 'background DOM click';
    miniCallTrace('dtmf.backgroundDomClick', `digit=${digit} verifiedNativeButton=true (DTMF unconfirmed)`);
    return 'background DOM click dispatched';
  }
  if (inputContext?.reason === 'untrusted-or-closed') {
    throw new Error('Google Voice is no longer available for this call.');
  }

  const point = miniCallTopViewportPoint(control);
  miniCallTrace('dtmf.target', `digit=${digit} path=${miniCallNodePath(control)} point=${point ? 'valid' : 'missing'}`);

  // IMPORTANT: elementFromPoint takes coordinates relative to the control's OWN
  // document. miniCallTopViewportPoint, conversely, returns top-frame coordinates
  // for Chromium input. Do not mix the two coordinate spaces.
  const localRect = control.getBoundingClientRect?.();
  const hitX = Number(localRect?.x) + Number(localRect?.width) / 2;
  const hitY = Number(localRect?.y) + Number(localRect?.height) / 2;
  const hitDoc = control.ownerDocument || document;
  const readHit = () => Number.isFinite(hitX) && Number.isFinite(hitY) &&
    typeof hitDoc.elementFromPoint === 'function' ? hitDoc.elementFromPoint(hitX, hitY) : null;
  const hitIsDigit = (hit) => hit === control || !!control.contains?.(hit);
  let hit = point ? readHit() : null;

  // On Windows the low-opacity Voice window may not have a finished compositor
  // hit-test surface immediately after showInactive() or after keypad animation.
  // Give the native target a short opportunity to become hit-testable before
  // falling back. Never send a pointer to a DIFFERENT visible element.
  if (point && miniCallLastDeliveryMode === 'onscreen-translucent' && !hitIsDigit(hit)) {
    const deadline = Date.now() + 700;
    while (Date.now() < deadline && control.isConnected && !hitIsDigit(hit)) {
      await new Promise((resolve) => setTimeout(resolve, 85));
      hit = readHit();
    }
  }
  miniCallLastHitTest = !point ? 'missing-position' : !hit ? 'no-hit' :
    hitIsDigit(hit) ? 'verified-native-key' : `blocked-by-${String(hit.tagName || 'element').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 28)}`;
  miniCallTrace('dtmf.hitTest', `digit=${digit} result=${miniCallLastHitTest} mode=${miniCallLastDeliveryMode}`);

  // v12: A painted background window can expose the CORRECT Angular DTMF
  // <button> in the DOM while elementFromPoint returns a neighboring keypad
  // section. v11 aborted here without calling the button at all. Since this
  // button was already verified as a native IN-CALL control, invoke its own
  // click handler inside the live Voice renderer; never click the hit-test
  // surface or the ordinary dialer. This is not proof of remote DTMF delivery.
  if (miniCallLastDeliveryMode === 'onscreen-translucent' && (!point || !hitIsDigit(hit))) {
    if (!control.isConnected || !miniCallVisible(control) ||
        control.disabled || control.getAttribute?.('aria-disabled') === 'true' ||
        miniCallIsIdleDialerDigit(control) ||
        miniCallFindNativeInCallGrid(digit)?.target !== control) {
      throw new Error('The native in-call keypad changed while preparing background input.');
    }
    control.click();
    miniCallPaintedDomFallbacks += 1;
    miniCallLastInputTransport = 'painted native in-page click';
    miniCallTrace('dtmf.paintedFallback', `digit=${digit} trustedPad=true hit=${miniCallLastHitTest} (DTMF unconfirmed)`);
    return 'painted native in-page click dispatched';
  }

  if (point && hit && !hitIsDigit(hit)) {
    miniCallTrace('dtmf.hitMismatch', `digit=${digit} target=${miniCallNodePath(control)} hit=${miniCallNodePath(hit)}`);
    throw new Error('A different on-screen element obscures Google Voice’s keypad. Open the native keypad or copy diagnostics.');
  }
  if (point && hitIsDigit(hit)) {
    try {
      const result = await ipcRenderer.invoke('mini-call-native-key-click', { digit, ...point });
      miniCallTrace('dtmf.pointer', result?.ok ? 'event dispatched (NOT DTMF confirmation)' : 'unavailable');
      if (result?.ok) {
        miniCallLastInputTransport = 'visible Chromium pointer';
        return 'native pointer dispatched';
      }
      if (result?.reason === 'background-window') {
        miniCallTrace('dtmf.pointerRace', 'window hid during pointer dispatch; falling back to native click');
      }
    } catch (error) {
      // DevTools may already be attached or Electron may be headless.
      miniCallTrace('dtmf.pointerError', String(error?.message || 'pointer unavailable').slice(0, 80));
    }
  }
  // Fallback remains bound to the VERIFIED in-call button, never a dialer key.
  if (!control.isConnected || miniCallIsIdleDialerDigit(control)) {
    throw new Error('The native in-call keypad key disappeared before activation.');
  }
  control.click();
  miniCallLastInputTransport = 'in-page DOM click fallback';
  miniCallTrace('dtmf.domClick', 'event dispatched (NOT DTMF confirmation)');
  return 'Google Voice DOM click dispatched';
}

// Google Voice can unmount ALL detectable call buttons between the first Answer click and its
// spoken "press 1 / press 2" prompt. Keep the verified call alive during that bounded gap.
const MINI_CALL_POST_ANSWER_SCREENING_MS = 75000;
const MINI_CALL_POST_ANSWER_CONNECTING_MS = 15000;
let miniCallPostAnswerUntil = 0;
let miniCallPostAnswerMissingSince = 0;
let miniCallPostAnswerStage = '';
let miniCallPostAnswerParty = '';
let miniCallPostAnswerSurface = null;

function miniCallIsPostAnswerPending() {
  if (miniCallPostAnswerUntil <= Date.now()) {
    miniCallPostAnswerUntil = 0;
    miniCallPostAnswerStage = '';
    miniCallPostAnswerSurface = null;
    return false;
  }
  return true;
}

function miniCallSetPostAnswerHold(stage, snapshot, surface) {
  miniCallPostAnswerMissingSince = 0;
  miniCallPostAnswerStage = stage;
  miniCallPostAnswerUntil = Date.now() + (stage === 'screening'
    ? MINI_CALL_POST_ANSWER_SCREENING_MS : MINI_CALL_POST_ANSWER_CONNECTING_MS);
  miniCallPostAnswerParty = snapshot?.party || miniCallPostAnswerParty || 'Incoming Google Voice call';
  if (surface) miniCallPostAnswerSurface = surface;
}

function miniCallClearPostAnswerHold() {
  miniCallPostAnswerMissingSince = 0;
  miniCallPostAnswerUntil = 0;
  miniCallPostAnswerStage = '';
  miniCallPostAnswerSurface = null;
  miniCallPostAnswerParty = '';
}

/**
 * Use only a previous authenticated incoming-call surface or a Google Voice call-specific
 * panel to locate keypad controls. Never fall back to the separate idle phone dialer.
 */
function miniCallFindPostAnswerSurface() {
  if (!miniCallIsPostAnswerPending()) return null;
  if (miniCallPostAnswerSurface?.isConnected && miniCallVisible(miniCallPostAnswerSurface)) {
    // The call controls may be present but Google's Keypad label can be icon-only or temporarily missing.
    // The previously verified ANSWERED call panel is still a valid target for Hang Up.
    const buttons = miniCallButtons(miniCallPostAnswerSurface);
    if (miniCallFindButton(buttons, 'keypad') || miniCallFindButton(buttons, 'hangup') ||
        miniCallFindKeypadDigits(miniCallPostAnswerSurface)) return miniCallPostAnswerSurface;
  }
  const panels = [...document.querySelectorAll(MINI_CALL_ROOT_SELECTOR)];
  for (const panel of panels) {
    if (!miniCallVisible(panel)) continue;
    const controls = miniCallButtons(panel);
    const identity = String(panel.tagName || '') + ' ' + String(panel.className || '');
    // A generic dialog could be the idle dialing UI, not the active screening call.
    // It must carry a call-specific tag/class or an unmistakable in-call prompt.
    const callPanel = /gv-(?:call|in-call)|call-widget|call-dialog|in-call/i.test(identity) ||
      /(?:call screening|press\s*[12]|incoming call|on a call|call connected)/i.test(String(panel.innerText || '').slice(0, 450));
    if (callPanel && (miniCallFindButton(controls, 'keypad') || miniCallFindButton(controls, 'hangup') || miniCallFindKeypadDigits(panel))) return panel;
  }
  return null;
}

let miniCallLastSnapshot = { phase: 'idle' };
let miniCallLastSignature = '';
let miniCallDisappearTimer = null;
let miniCallObserveTimer = null;
let miniCallSessionStart = 0;
let miniCallActionBusy = false;
let miniCallLastDigitAttempt = 'none'; // Only digit/method metadata; never caller information.
// Keep a rolling history across Angular transitions, rather than inspecting only the final DOM.
// Entries are deliberately allowlisted: never collect caller names, numbers, page text or URLs.
const miniCallTraceStart = Date.now();
const miniCallTraceEntries = [];
let miniCallLastControlSignature = '';
function miniCallTrace(event, detail = '') {
  const safeEvent = String(event).replace(/[^a-z0-9_.:-]/gi, '').slice(0, 36);
  const safeDetail = String(detail).slice(0, 230).replace(/[\r\n]/g, ' ');
  miniCallTraceEntries.push(`+${Date.now() - miniCallTraceStart}ms ${safeEvent}${safeDetail ? ': ' + safeDetail : ''}`);
  if (miniCallTraceEntries.length > 90) miniCallTraceEntries.shift();
}

// Human-readable CSS ancestry with ONLY technical class tokens. Arbitrary IDs, attribute
// values and all page text are intentionally excluded, including for overlay containers.
function miniCallNodePath(node) {
  if (!node) return 'none';
  const parts = [];
  for (let current = node, depth = 0; current && depth < 9; current = current.parentElement || current.host, depth++) {
    const tag = String(current.tagName || (current.host ? '#shadow-root' : 'node')).toLowerCase().replace(/[^a-z0-9#-]/g, '').slice(0, 38);
    const classes = String(typeof current.className === 'string' ? current.className : '').split(/\s+/)
      .filter((part) => /^(?:gv-|mat-|mdc-|cdk-|ng-|keypad|dialpad|call-|in-call|screening|button|btn|icon|active|open|visible)/i.test(part))
      .map((part) => part.replace(/[^a-z0-9_-]/gi, '').slice(0, 40)).slice(0, 2);
    parts.push(tag + classes.map((part) => '.' + part).join(''));
    if (tag === 'body' || tag === 'html') break;
  }
  return parts.reverse().join(' > ').slice(0, 260);
}

// A compact count of verified controls, used to watch changes without recording sensitive DOM.
function miniCallControlFingerprint() {
  const buttons = miniCallButtons();
  const actionCounts = Object.fromEntries(Object.keys(MINI_CALL_ACTION_LABELS).map((key) => [key, 0]));
  for (const button of buttons) {
    const label = miniCallLabel(button);
    for (const [action, rx] of Object.entries(MINI_CALL_ACTION_LABELS)) {
      if (rx.test(label)) actionCounts[action]++;
    }
  }
  const digits = [...new Set(miniCallDigitCandidates(document).map(miniCallKeyDigit).filter(Boolean))].sort().join('');
  return { actionCounts, digits };
}

function miniCallRecordControlTransition(reason) {
  if (miniCallLastSnapshot.phase === 'idle' && !miniCallIsPostAnswerPending()) return;
  const fingerprint = miniCallControlFingerprint();
  const signature = JSON.stringify(fingerprint);
  if (signature === miniCallLastControlSignature) return;
  miniCallLastControlSignature = signature;
  miniCallTrace('dom.change', `${reason} controls=${JSON.stringify(fingerprint.actionCounts)} digits=${fingerprint.digits || 'none'}`);
}
let miniCallDirection = 'unknown'; // Retain the original direction after ringing/dialing becomes active.

function miniCallPublish(snapshot) {
  const signature = JSON.stringify(snapshot);
  if (signature === miniCallLastSignature) return;
  miniCallLastSignature = signature;
  miniCallLastSnapshot = snapshot;
  miniCallTrace('call.phase', snapshot.phase + ' keypad=' + !!snapshot.canKeypad + ' hangup=' + !!snapshot.canHangup);
  ipcRenderer.send('mini-call-observed', snapshot);
}

function miniCallRefresh() {
  const snapshot = miniCallReadSnapshot();
  if (snapshot.phase === 'idle' && miniCallLastSnapshot.phase !== 'idle') {
    // Angular temporarily unmounts the call panel when switching between keypad and status.
    // Require the call to disappear for 2 seconds before closing the mini window.
    if (!miniCallDisappearTimer) {
      miniCallDisappearTimer = setTimeout(() => {
        miniCallDisappearTimer = null;
        if (miniCallReadSnapshot().phase === 'idle') {
          miniCallSessionStart = 0;
          miniCallDirection = 'unknown';
          miniCallClearPostAnswerHold();
          miniCallPublish({ phase: 'idle' });
        }
      }, 2000);
    }
    return;
  }
  if (miniCallDisappearTimer) { clearTimeout(miniCallDisappearTimer); miniCallDisappearTimer = null; }
  if (snapshot.phase !== 'idle' && !miniCallSessionStart) {
    miniCallSessionStart = Date.now();
    miniCallDirection = snapshot.phase === 'incoming' || snapshot.phase === 'screening' ? 'incoming'
      : snapshot.phase === 'outgoing' ? 'outgoing' : 'unknown';
  }
  if (snapshot.phase !== 'idle') snapshot.direction = miniCallDirection;
  miniCallPublish(snapshot);
  miniCallRecordControlTransition('refresh');
}

function miniCallScheduleRefresh() {
  if (miniCallObserveTimer) return;
  miniCallObserveTimer = setTimeout(() => { miniCallObserveTimer = null; miniCallRefresh(); }, 180);
}

/**
 * Click native Google Voice controls. For digits, reveal the native call keypad only when required,
 * click the actual 1/2 key and restore its previous visibility. This preserves real DTMF signaling.
 * No keyboard event is faked and no undocumented Google Voice transport is called.
 */
async function miniCallPerformAction(action) {
  const snapshot = miniCallReadSnapshot();
  if (snapshot.phase === 'idle') throw new Error('No live Google Voice call was detected.');
  if (miniCallActionBusy) throw new Error('The previous call action is still running.');
  miniCallActionBusy = true;
  miniCallTrace('action.start', `${action} phase=${snapshot.phase}`);
  miniCallRecordControlTransition('action-start');
  try {
    const buttons = miniCallButtons();
    const answerButton = miniCallFindButton(buttons, 'answer');
    const hangupButton = miniCallFindButton(buttons, 'hangup');
    // A verified post-answer call panel outranks other "End" buttons elsewhere on the page.
    // Do not use an ordinary idle dialer, which may contain a different numeric keypad.
    const heldPanel = miniCallFindPostAnswerSurface();
    const anchor = action === 'answer' ? answerButton : hangupButton || answerButton;
    const root = action === 'answer' ? (anchor && miniCallSurface(anchor))
      : (heldPanel || (anchor && miniCallSurface(anchor)));
    miniCallTrace('action.root', miniCallNodePath(root));
    if (!root) throw new Error('Could not locate Google Voice’s active call panel. Open the main window and use its native controls.');
    const local = miniCallButtons(root);
    const key = ({ answer: 'answer', decline: 'decline', hangup: 'hangup', mute: 'mute', 'show-keypad': 'keypad' })[action];
    if (key) {
      const button = miniCallFindButton(local, key);
      if (!button) throw new Error(`Could not find Google Voice’s ${key} button in the active call panel. Open the native controls or copy diagnostics.`);
      // Arm the transition BEFORE clicking: Google may synchronously remove its Answer button.
      if (action === 'answer') miniCallSetPostAnswerHold('screening', snapshot, root);
      if (action === 'decline') miniCallClearPostAnswerHold();
      // Hang Up must not clear the screening hold merely because click() was called.
      // We verify the call is gone (and retry once if it persists) below.
      miniCallTrace('action.target', `${key} path=${miniCallNodePath(button)}`);
      if (action === 'hangup') return await miniCallEndVerifiedCall(button, root);
      button.click();
      miniCallTrace('action.dispatched', key);
      miniCallScheduleRefresh();
      return { ok: true, message: action === 'answer'
        ? 'Answered. The mini controller will stay open for the screening prompt.'
        : `Requested Google Voice’s ${key} control.` };
    }
    if (action !== 'tone-1' && action !== 'tone-2') throw new Error('Unknown call action.');
    if (snapshot.phase === 'incoming') throw new Error('Click Answer first, then use 1 or 2 when Google Voice requests a screening choice.');
    const digit = action === 'tone-1' ? '1' : '2';
    const nativeToggle = miniCallFindActiveKeypadToggle(root);
    let nativeGrid = miniCallFindNativeInCallGrid(digit);
    let keypad = nativeGrid ? [nativeGrid.target] : miniCallVerifiedActionKeys(root, digit) ||
      miniCallVerifiedActionKeys(document, digit);
    let learned = miniCallFindLearnedKey(digit);
    miniCallTrace('dtmf.lookup', `digit=${digit} nativeGrid=${!!nativeGrid} verified=${!!keypad} learned=${!!learned}`);
    let foundKeypad = nativeToggle;
    if (!foundKeypad && !keypad && !learned) {
      miniCallTrace('dtmf.waitToggle', 'waiting for active call keypad');
      foundKeypad = await miniCallWaitForActiveKeypadToggle(root);
    }
    const keypadAlreadyOpen = !!foundKeypad?.alreadyOpen;
    miniCallTrace('dtmf.toggle', foundKeypad
      ? `${keypadAlreadyOpen ? 'already-open' : 'closed'} path=${miniCallNodePath(foundKeypad.toggle)}`
      : 'not found');
    let openedKeypad = false;
    if (!keypad && !learned && !keypadAlreadyOpen) {
      const openToggle = foundKeypad?.openToggle || foundKeypad?.toggle;
      if (!openToggle) {
        miniCallLastDigitAttempt = `${digit}: no active call keypad toggle`;
        miniCallTrace('dtmf.failure', miniCallLastDigitAttempt);
        throw new Error('In-call keypad is not available yet. Open Google Voice’s native keypad.');
      }
      miniCallTrace('dtmf.open', miniCallNodePath(openToggle));
      openToggle.click();
      openedKeypad = true;
    }
    // Google dynamically mounts the keypad after the opening animation.
    // Wait for real in-call keys and never select incidental number displays.
    const deadline = Date.now() + 4200;
    while (!keypad && !learned && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 90));
      learned = miniCallFindLearnedKey(digit);
      nativeGrid = miniCallFindNativeInCallGrid(digit);
      keypad = nativeGrid ? [nativeGrid.target] : miniCallVerifiedActionKeys(foundKeypad?.surface || root, digit) ||
        miniCallVerifiedActionKeys(document, digit);
    }
    // A BUTTON inside the in-call keypad outranks a numeric div/span whose click
    // may merely update the ordinary dialer input without transmitting DTMF.
    const matched = keypad?.filter((node) => miniCallKeyDigit(node) === digit) || [];
    const digitButton = learned || nativeGrid?.target || matched.find((node) => node.matches?.('button, [role="button"]') &&
      !miniCallIsIdleDialerDigit(node) && node.closest?.('gv-dialpad, gv-keypad, gv-in-call-keypad, gv-in-call-dialpad')) ||
      matched.find((node) => node.matches?.('button, [role="button"]') && !miniCallIsIdleDialerDigit(node)) ||
      // Some verified in-call keypads expose custom div keys rather than buttons.
      // Only accept their explicit data-digit/data-key/data-dtmf attribute.
      matched.find((node) => !miniCallIsIdleDialerDigit(node) &&
        ['data-digit', 'data-key', 'data-dtmf'].some((attr) => node.getAttribute?.(attr) === digit));
    if (!digitButton) {
      const candidates = miniCallDigitCandidates(document);
      const found = [...new Set(candidates.map(miniCallKeyDigit).filter(Boolean))].sort().join(',') || 'none';
      miniCallLastDigitAttempt = `${digit}: rejected unverified numeric controls [${found}]`;
      miniCallTrace('dtmf.failure', miniCallLastDigitAttempt);
      throw new Error(`The visible numbers are not verified as Google Voice’s in-call keypad. Press ${digit} manually once; the controller can learn its native control for future calls.`);
    }
    miniCallTrace('dtmf.selected', `mode=${learned === digitButton ? 'learned-native-route' : nativeGrid?.method || 'verified-keypad'} digit=${digit} index=${nativeGrid?.index ?? 'label'} path=${miniCallNodePath(digitButton)}`);
    const method = nativeGrid?.target === digitButton ? await miniCallClickRealGridButton(digitButton, digit) : await miniCallClickDigit(digitButton, digit);
    // Pointer dispatch and DOM click aren't proof the remote call received DTMF.
    miniCallLastDigitAttempt = `${digit}: ${method} (unconfirmed)`;
    miniCallTrace('dtmf.dispatched', miniCallLastDigitAttempt);
    // Record delayed changes even when the UI swaps out the entire active-call component.
    for (const delay of [200, 900, 2400]) {
      setTimeout(() => {
        miniCallRecordControlTransition(`post-digit-${delay}ms`);
        miniCallTrace('dtmf.followup', `${delay}ms phase=${miniCallReadSnapshot().phase} keypad=${!!miniCallReadSnapshot().canKeypad}`);
      }, delay);
    }
    // Crucial: DO NOT collapse Google's keypad after a fixed 480 ms. The old timer
    // could hide it while Google was still processing the click/DTMF and erased the
    // evidence we needed. Leave it open unless Google itself transitions the call.
    if (openedKeypad) miniCallTrace('dtmf.keypad', 'left visible until Google changes it');
    if (digit === '1' && miniCallIsPostAnswerPending() && miniCallPostAnswerStage === 'screening') {
      // The user has activated the same native key that answers screening calls.
      // Move away from the screening-only controls; the call UI still decides when
      // the session actually ends. A dispatched click alone isn't server proof.
      miniCallSetPostAnswerHold('active', snapshot, root);
      miniCallTrace('call.screeningSelection', 'digit=1 active after native key');
    }
    miniCallScheduleRefresh();
    return { ok: true, message: `Activated Google Voice’s native ${digit} key (${method}; DTMF not confirmed). Check the screening prompt.` };
  } catch (error) {
    miniCallTrace('action.error', String(error?.message || 'failed').replace(/\d{3,}/g, '[numeric]').slice(0, 130));
    throw error;
  } finally {
    miniCallActionBusy = false;
  }
}

/**
 * Legacy keyboard preparation helper, kept for regression tests only. The mini call
 * controller no longer uses this route because key dispatch does not prove DTMF.
 * Prepare Google Voice for a real Chromium keyboard event without opening its keypad.
 * The main process uses Chrome's trusted Input.dispatchKeyEvent on this webContents.
 * We intentionally do not fake KeyboardEvent: many sites discard untrusted events.
 */
function miniCallPrepareKeyboardTone() {
  const snap = miniCallReadSnapshot();
  if (snap.phase === 'idle' || snap.phase === 'incoming') {
    throw new Error('Answer the incoming Google Voice call before sending a digit.');
  }
  const root = miniCallFindPostAnswerSurface() ||
    (miniCallFindButton(miniCallButtons(), 'hangup') &&
      miniCallSurface(miniCallFindButton(miniCallButtons(), 'hangup')));
  // A verified Answer transition can briefly remove its call controls while
  // the spoken screening prompt is playing. The bounded 75s hold is sufficient
  // proof for the keyboard route, provided no message input retains focus.
  if (!root && !miniCallIsPostAnswerPending()) {
    throw new Error('The active Google Voice call panel is not available.');
  }

  // Focus the call panel rather than a message input or the sidebar phone dialer.
  // A real DevTools keyboard event otherwise might type into a draft message.
  const active = document.activeElement;
  if (active?.matches?.('input,textarea,[contenteditable="true"],[role="textbox"]')) active.blur?.();
  if (typeof root?.focus === 'function') {
    if (!root.hasAttribute?.('tabindex')) root.setAttribute?.('tabindex', '-1');
    root.focus({ preventScroll: true });
  } else if (typeof document.body?.focus === 'function') {
    document.body.focus({ preventScroll: true });
  }
  return { ok: true, message: 'Active call verified for keyboard DTMF.' };
}

/**
 * Targeted, privacy-safe keypad introspection. Do not copy phone numbers, text,
 * iframe URLs, credentials or message contents. Only output counts and node tags.
 */
function miniCallKeypadProbe() {
  const scopes = miniCallDomScopes(document);
  const scopeInfo = scopes.map((scope) => scope.nodeType === 9 ? 'document' :
    scope.host ? 'shadow-root' : 'other');
  const buttons = miniCallButtons();
  const toggleInfo = buttons.filter((node) => MINI_CALL_ACTION_LABELS.keypad.test(miniCallLabel(node)))
    .slice(0, 5).map((node) => {
      const owner = node.closest?.('gv-in-call, gv-in-call-status, gv-call-sidebar, [role="dialog"]');
      return `${String(owner?.tagName || 'none').toLowerCase()}:${miniCallLabel(node).slice(0, 25)}`;
    });
  // These are *counts* only: do not collect keypad ancestor text or arbitrary labels.
  let numericLeaves = 0;
  let numericInSidebar = 0;
  for (const scope of scopes) {
    for (const node of scope.querySelectorAll('button, [role="button"], span, div')) {
      if (!miniCallVisible(node) || miniCallKeyDigit(node) === null) continue;
      numericLeaves++;
      if (miniCallIsIdleDialerDigit(node)) numericInSidebar++;
    }
  }
  const frames = [...document.querySelectorAll('iframe')];
  const accessible = frames.filter((frame) => {
    try { return !!frame.contentDocument && frame.contentWindow?.location?.origin === window.location.origin; }
    catch { return false; }
  });
  return [
    `keypadScopeTypes=${scopeInfo.join(',') || 'none'}`,
    `keypadToggles=${toggleInfo.join(' | ') || 'none'}`,
    `numericLeaves=${numericLeaves}`,
    `numericExcludedIdleDialer=${numericInSidebar}`,
    `sameOriginFrames=${accessible.length}/${frames.length}`,
  ];
}

/** Show why tiny digit-looking DOM leaves were rejected; never inspect number strings. */
function miniCallNumericLeafProbe() {
  const result = [];
  for (const scope of miniCallDomScopes(document)) {
    for (const node of scope.querySelectorAll('button, [role="button"], span, div')) {
      const digit = miniCallKeyDigit(node);
      if (!['0', '1', '2'].includes(digit) || !miniCallVisible(node)) continue;
      const control = miniCallKeyControl(node, digit);
      const visible = miniCallVisible(control);
      const excluded = miniCallIsIdleDialerDigit(node);
      if (result.length < 12) result.push(`numericLeaf: digit=${digit} candidate=${miniCallNodePath(node)} clickable=${miniCallNodePath(control)} enabled=${visible} idleDialer=${excluded}`);
    }
  }
  return result.length ? result : ['numericLeaf: none for 0/1/2'];
}

/** A per-control selector route through the Google Voice DOM, with sensitive text stripped. */
function miniCallDetailedControlPaths() {
  const lines = [];
  const roots = [...document.querySelectorAll(
    'gv-in-call, gv-in-call-status, gv-call-sidebar, gv-call-panel, gv-active-call, gv-call-dialog, gv-call-widget, [class*="keypad" i], [class*="dialpad" i], [class*="call-controls" i], [role="dialog"]'
  )].slice(0, 80);
  const visibleRoots = roots.filter(miniCallVisible);
  lines.push(`callSurfaceNodes=${roots.length} visible=${visibleRoots.length}`);
  lines.push(...visibleRoots.slice(0, 15).map((node) => `surface: ${miniCallNodePath(node)}`));

  // Inspect even hidden candidate controls to diagnose CSS vs DOM unmounting.
  const controls = [...document.querySelectorAll('button, [role="button"]')];
  let hiddenKeypadCount = 0;
  const relevant = [];
  for (const control of controls) {
    const label = miniCallLabel(control);
    const action = Object.entries(MINI_CALL_ACTION_LABELS).find(([, pattern]) => pattern.test(label))?.[0];
    if (!action) continue;
    if (action === 'keypad' && !miniCallVisible(control)) hiddenKeypadCount++;
    if (relevant.length < 20) relevant.push(`${action} ${miniCallVisible(control) ? 'visible' : 'hidden'} ariaDisabled=${control.getAttribute?.('aria-disabled') === 'true'} path=${miniCallNodePath(control)}`);
  }
  lines.push(`keypadTogglesHidden=${hiddenKeypadCount} totalButtons=${controls.length}`);
  lines.push(...relevant.map((line) => `control: ${line}`));

  // Only 0/1/2 are relevant to screening. Nothing else from page content is copied.
  const digits = miniCallDigitCandidates(document).filter((node) => ['0', '1', '2'].includes(miniCallKeyDigit(node)));
  lines.push(...digits.slice(0, 12).map((node) => `screeningDigit: ${miniCallKeyDigit(node)} path=${miniCallNodePath(node)}`));
  lines.push(...miniCallNumericLeafProbe());
  const allFrames = [...document.querySelectorAll('iframe')];
  const frameKinds = allFrames.slice(0, 12).map((frame) => {
    let access = 'cross-origin/inaccessible';
    try { if (frame.contentDocument && frame.contentWindow?.location?.origin === window.location.origin) access = 'same-origin'; } catch { /* Deliberately omit frame URL. */ }
    return `${access} visible=${miniCallVisible(frame)}`;
  });
  lines.push(`frameAccess=${frameKinds.join(' | ') || 'none'}`);
  return lines;
}

/** Copy only control/icon metadata, never caller names, phone numbers, page text or credentials. */
/**
 * Report keypad component ancestry, not page content. This exposes whether
 * Google's ordinary make-call dialer was accidentally found instead of DTMF.
 */
function miniCallKeypadComponentProbe() {
  const pads = [...document.querySelectorAll('section.dialpad-container, gv-dialpad, gv-keypad, gv-in-call-keypad, gv-in-call-dialpad, [class*="in-call-keypad" i]')].slice(0, 14);
  const lines = [`dialpadComponents=${pads.length}`];
  for (const pad of pads) {
    const buttons = [...pad.querySelectorAll('button, [role="button"]')];
    const visible = buttons.filter(miniCallVisible);
    const digits = [...new Set(visible.map(miniCallKeyDigit).filter((digit) => ['1', '2'].includes(digit)))].sort().join('') || 'none';
    const verifiedGrid = ['1','2'].some((digit) => miniCallFindNativeInCallGrid(digit)?.pad === pad);
    const kind = pad.closest?.('gv-make-call-panel, gv-make-call-panel-ng2') ? 'ordinary-make-call'
      : pad.closest?.('gv-in-call, gv-in-call-status, gv-active-call, gv-call-panel') ? 'in-call'
        : 'unclassified';
    // Only individual single-digit labels/indices are reported; never copy
    // full keypad text, caller details, dialed telephone numbers, or chat data.
    const labels = visible.map((button, index) => ({ index, digit: miniCallKeyDigit(button) }))
      .filter((item) => item.digit && ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(item.digit))
      .slice(0, 12).map((item) => `${item.index}:${item.digit}`).join(',') || 'none';
    lines.push(`dialpad: kind=${kind} visible=${miniCallVisible(pad)} buttons=${buttons.length} visibleButtons=${visible.length} keys12=${digits} verified12Grid=${verifiedGrid} knownKeyIndexes=${labels} path=${miniCallNodePath(pad)}`);
  }
  return lines;
}

function miniCallControlDiagnostics() {
  const snap = miniCallReadSnapshot();
  const buttons = miniCallButtons().map((el) => {
    const label = miniCallLabel(el);
    // Do not copy arbitrary contact data: only recognizable action/icon names.
    return Object.keys(MINI_CALL_ACTION_LABELS).find((name) => MINI_CALL_ACTION_LABELS[name].test(label))
      ? `${el.tagName.toLowerCase()}: ${label.slice(0, 50)}` : null;
  }).filter(Boolean).slice(0, 28);
  const panels = [...document.querySelectorAll(MINI_CALL_ROOT_SELECTOR)]
    .filter(miniCallVisible).slice(0, 12).map((node) => node.tagName.toLowerCase());
  // Limit icon inspection strictly to actual material-icon controls, not ordinary page text.
  const iconNames = [...document.querySelectorAll('button mat-icon, [role="button"] mat-icon')]
    .filter(miniCallVisible).map((node) => String(node.textContent || '').trim().toLowerCase())
    .filter((name) => /^[a-z_]{2,28}$/.test(name)).slice(0, 25);
  const postAnswer = miniCallIsPostAnswerPending();
  return [
    `Voice Desktop mini call diagnostics v12`,
    `controllerBuild=2026-11-09-v12-paint-hit-fallback`,
    `lastDeliveryMode=${miniCallLastDeliveryMode}`,
    `lastHitTest=${miniCallLastHitTest}`,
    `paintedNativeClickFallbacks=${miniCallPaintedDomFallbacks}`,
    `NOTE=main-process attempt history appears first in copied v12 report`,
    `nativeGrid1=${!!miniCallFindNativeInCallGrid('1')}`,
    `nativeGrid2=${!!miniCallFindNativeInCallGrid('2')}`,
    `learnedRouteResolved1=${!!miniCallFindLearnedKey('1')}`,
    `learnedRouteResolved2=${!!miniCallFindLearnedKey('2')}`,
    `nativePadSelector=gv-dialpad (within active gv-in-call, never gv-make-call-panel)`,
    `lastHangupAttempt=${miniCallLastHangupAttempt}`,
    `manualKeyCapture=${miniCallLastManualKey}`,
    `phase=${snap.phase}`,
    `postAnswer=${postAnswer}`, `keypadAvailable=${!!snap.canKeypad}`,
    `hangupAvailable=${!!snap.canHangup}`, `panelTags=${panels.join(', ') || 'none'}`,
    `matchingControls=${buttons.join(' | ') || 'none'}`,
    `materialIcons=${iconNames.join(', ') || 'none'}`,
    `keypadDigitCount=${miniCallDigitCandidates(miniCallFindPostAnswerSurface() || document).length}`,
    `keypadDigits=${[...new Set(miniCallDigitCandidates(miniCallFindPostAnswerSurface() || document).map(miniCallKeyDigit).filter(Boolean))].sort().join(',') || 'none'}`,
    `keypadToggle=${miniCallLabel(miniCallFindButton(miniCallButtons(miniCallFindPostAnswerSurface() || document), 'keypad') || { getAttribute: () => null, textContent: '' }).slice(0, 36) || 'none'}`,
    `candidateTags=${[...new Set(miniCallDigitCandidates(miniCallFindPostAnswerSurface() || document).map((node) => String(node.tagName || '').toLowerCase()))].join(',') || 'none'}`,
    `lastDigitAttempt=${miniCallLastDigitAttempt}`,
    `mainWindowAtLastDigit=${miniCallLastInputContext}`,
    `inputTransport=${miniCallLastInputTransport}`,
    `voicePageVisibilityAtLastDigit=${miniCallLastPageVisibility}`,
    `learnedNativeDigits=${Object.keys(miniCallLearnedDigitPaths).sort().join(',') || 'none'}`,
    ...['1', '2'].filter((digit) => !!miniCallLearnedDigitPaths[digit]).map((digit) => {
      const hint = miniCallLearnedDigitPaths[digit];
      return `learnedNativeRoute${digit}=${hint.rootTag}>${hint.route.map((step) => `${step.tag}[${step.index}]`).join('>')}`;
    }),
    `verifiedKeypad1=${!!miniCallVerifiedActionKeys(document, '1')}`,
    `verifiedKeypad2=${!!miniCallVerifiedActionKeys(document, '2')}`,
    `nativeKeypadSelection=trusted manual route / native labelled button / sibling of verified 1 / geometric grid`,
    ...miniCallKeypadComponentProbe(),
    ...miniCallKeypadProbe(),
    `iframeCount=${document.querySelectorAll('iframe').length}`,
    '', 'Control paths (structural metadata only):',
    ...miniCallDetailedControlPaths(),
    '', 'Recent call-control timeline (oldest first):',
    ...miniCallTraceEntries.slice(-38),
  ].join('\n').slice(0, 19000);
}

ipcRenderer.on('mini-call-perform-action', async (_event, request) => {
  if (!request || !Number.isInteger(request.id) || !/^(?:answer|decline|hangup|mute|tone-[12]|prepare-tone|show-keypad|copy-diagnostics)$/.test(request.action)) return;
  try {
    if (request.action !== 'copy-diagnostics') {
      // Transport metadata is supplied by the trusted Electron main process.
      // Keep it across UI transitions for diagnostics after the call.
      miniCallLastDeliveryMode = ['direct', 'offscreen-rendered', 'onscreen-translucent'].includes(request.deliveryMode)
        ? request.deliveryMode : 'unknown';
      miniCallTrace('action.deliveryMode', miniCallLastDeliveryMode);
    }
    const result = request.action === 'copy-diagnostics'
      ? { ok: true, diagnostics: miniCallControlDiagnostics() }
      : request.action === 'prepare-tone' ? miniCallPrepareKeyboardTone()
      : await miniCallPerformAction(request.action);
    ipcRenderer.send('mini-call-action-result', { id: request.id, ...result });
  } catch (error) {
    ipcRenderer.send('mini-call-action-result', { id: request.id, ok: false, message: String(error?.message || error).slice(0, 210) });
  }
});

function miniCallInstallObserver() {
  if (!document.documentElement || window.location.origin !== 'https://voice.google.com') return;
  // Also honor Answer clicks made in Google Voice itself, not just the mini window.
  document.addEventListener('click', (event) => {
    miniCallNativeDigitEvent(event);
    const target = event.target?.closest?.('button, [role="button"]');
    if (!target) return;
    const label = miniCallLabel(target);
    if (miniCallIsPostAnswerPending()) {
      const digit = miniCallKeyDigit(target);
      if (digit !== null && !miniCallIsIdleDialerDigit(target)) {
        miniCallTrace('voice.clickDigit', `digit=${digit} path=${miniCallNodePath(target)}`);
      } else {
        const action = Object.entries(MINI_CALL_ACTION_LABELS).find(([, pattern]) => pattern.test(label))?.[0];
        if (action) miniCallTrace('voice.clickControl', `${action} path=${miniCallNodePath(target)}`);
      }
    }
    // Explicitly ending or declining the native call should release the hold immediately.
    if (miniCallIsPostAnswerPending() &&
        (MINI_CALL_ACTION_LABELS.decline.test(label) || MINI_CALL_ACTION_LABELS.hangup.test(label))) {
      miniCallClearPostAnswerHold();
      miniCallScheduleRefresh();
      return;
    }
    if (!MINI_CALL_ACTION_LABELS.answer.test(label)) return;
    const snapshot = miniCallReadSnapshot();
    if (snapshot.phase === 'incoming') miniCallSetPostAnswerHold('screening', snapshot, miniCallSurface(target));
  }, { capture: true });
  const observer = new MutationObserver(miniCallScheduleRefresh);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true,
    attributeFilter: ['aria-label', 'aria-hidden', 'class', 'style', 'title', 'hidden', 'disabled'] });
  miniCallInstallLauncher();
  miniCallRefresh();
  // A periodic scan catches call transitions that don't create DOM mutations (e.g. canvas or audio).
  setInterval(() => { miniCallInstallLauncher(); miniCallRefresh(); }, 1600);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', miniCallInstallObserver, { once: true });
} else {
  miniCallInstallObserver();
}
