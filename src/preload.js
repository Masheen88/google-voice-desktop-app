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
  const style = window.getComputedStyle(element);
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
    const local = surface ? miniCallButtons(surface) : [];
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
    element.getAttribute('data-digit'), element.getAttribute('data-key'),
    element.getAttribute('data-value'), element.getAttribute('data-number'),
    element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent,
  ];
  // Some keypad controls display number + letters without whitespace ("2ABC") or spell the digit.
  const words = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9' };
  for (const raw of sources) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().replace(/\s+/g, ' ');
    const normalized = value.toLowerCase().replace(/^(?:dialpad|keypad|digit|number|key)\s*/, '');
    if (/^[0-9]$/.test(normalized)) return normalized;
    if (words[normalized]) return words[normalized];
    // Exclude phone numbers / text inputs. These are labels for an individual native digit only.
    const match = normalized.match(/^([0-9])(?:[\s,:.)-]|[a-z]{2,4}$)/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * Require a complete-looking keypad (five or more unique digits). This guards against
 * unrelated "1" / "2" buttons and prevents the idle dialer from being used as DTMF.
 * The caller chooses a verified in-call root before calling this helper.
 */
function miniCallDigitCandidates(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const nativeControls = miniCallButtons(root);
  const otherControls = [...root.querySelectorAll([
    '[data-digit]', '[data-key]', '[data-number]', '[tabindex="0"]', 'gv-keypad-button',
    'gv-dialpad-button', '[role="gridcell"]', '[class*="digit-button" i]',
    '[class*="dialpad-key" i]', '[class*="keypad-key" i]',
    '[class*="dialpad-button" i]', '[class*="keypad-button" i]',
    'gv-dialpad-key', 'gv-dialpad-button', '[class*="dialpad-digit" i]',
  ].join(','))];
  return [...new Set([...nativeControls, ...otherControls])]
    .filter((node) => miniCallVisible(node) && miniCallKeyDigit(node) !== null);
}

function miniCallVerifiedKeys(candidates) {
  const keys = candidates.filter((node) => miniCallVisible(node));
  return new Set(keys.map(miniCallKeyDigit)).size >= 5 ? keys : null;
}

function miniCallFindKeypadDigits(root) {
  return miniCallVerifiedKeys(miniCallDigitCandidates(root || document));
}

/**
 * The in-call keypad sometimes renders in an Angular CDK overlay OUTSIDE the call panel.
 * For that case, only use new/revealed digit controls after we clicked the *verified*
 * call's own Keypad button. Ignore any digits that were already visible on the page.
 */
function miniCallFindRevealedKeys(root, visibleBefore) {
  const scoped = root && root.isConnected ? miniCallFindKeypadDigits(root) : null;
  if (scoped) return scoped;
  const revealed = miniCallDigitCandidates(document).filter((node) =>
    !visibleBefore.has(node) &&
    !node.closest('gv-call-sidebar, gv-make-call-panel-ng2, gv-recipient-picker')
  );
  return miniCallVerifiedKeys(revealed);
}

async function miniCallWaitForKeys(root, visibleBefore, timeoutMs = 2100) {
  // A fixed 170 ms wait was too short for Angular's lazy keypad rendering/animations.
  const deadline = Date.now() + timeoutMs;
  do {
    const keys = miniCallFindRevealedKeys(root, visibleBefore);
    if (keys) return keys;
    await new Promise((resolve) => setTimeout(resolve, 70));
  } while (Date.now() < deadline);
  return null;
}

// Google Voice can unmount ALL detectable call buttons between the first Answer click and its
// spoken "press 1 / press 2" prompt. Keep the verified call alive during that bounded gap.
const MINI_CALL_POST_ANSWER_SCREENING_MS = 75000;
const MINI_CALL_POST_ANSWER_CONNECTING_MS = 15000;
let miniCallPostAnswerUntil = 0;
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
  miniCallPostAnswerStage = stage;
  miniCallPostAnswerUntil = Date.now() + (stage === 'screening'
    ? MINI_CALL_POST_ANSWER_SCREENING_MS : MINI_CALL_POST_ANSWER_CONNECTING_MS);
  miniCallPostAnswerParty = snapshot?.party || miniCallPostAnswerParty || 'Incoming Google Voice call';
  if (surface) miniCallPostAnswerSurface = surface;
}

function miniCallClearPostAnswerHold() {
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
let miniCallDirection = 'unknown'; // Retain the original direction after ringing/dialing becomes active.

function miniCallPublish(snapshot) {
  const signature = JSON.stringify(snapshot);
  if (signature === miniCallLastSignature) return;
  miniCallLastSignature = signature;
  miniCallLastSnapshot = snapshot;
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
    if (!root) throw new Error('Could not locate Google Voice’s active call panel. Open the main window and use its native controls.');
    const local = miniCallButtons(root);
    const key = ({ answer: 'answer', decline: 'decline', hangup: 'hangup', mute: 'mute', 'show-keypad': 'keypad' })[action];
    if (key) {
      const button = miniCallFindButton(local, key);
      if (!button) throw new Error(`Could not find Google Voice’s ${key} button in the active call panel. Open the native controls or copy diagnostics.`);
      // Arm the transition BEFORE clicking: Google may synchronously remove its Answer button.
      if (action === 'answer') miniCallSetPostAnswerHold('screening', snapshot, root);
      if (action === 'decline' || action === 'hangup') miniCallClearPostAnswerHold();
      button.click();
      miniCallScheduleRefresh();
      return { ok: true, message: action === 'answer'
        ? 'Answered. The mini controller will stay open for the screening prompt.'
        : `Requested Google Voice’s ${key} control.` };
    }
    if (action !== 'tone-1' && action !== 'tone-2') throw new Error('Unknown call action.');
    if (snapshot.phase === 'incoming') throw new Error('Click Answer first, then use 1 or 2 when Google Voice requests a screening choice.');
    const digit = action === 'tone-1' ? '1' : '2';
    let keys = miniCallFindKeypadDigits(root);
    // Snapshot visible digits BEFORE opening the verified in-call keypad. Any separate
    // sidebar dialer was already present and must never be mistaken for call DTMF.
    const previousPageDigits = new Set(miniCallDigitCandidates(document));
    let openedKeypad = false;
    let toggle = null;
    if (!keys) {
      toggle = miniCallFindButton(local, 'keypad');
      if (!toggle) throw new Error('In-call keypad is not available yet. Open Google Voice to enter 1 or 2.');
      toggle.click();
      openedKeypad = true;
      keys = await miniCallWaitForKeys(root, previousPageDigits);
    }
    const digitButton = keys?.find((button) => miniCallKeyDigit(button) === digit);
    if (!digitButton) {
      // Keep Google's own keypad visible rather than closing it on an unsuccessful try.
      throw new Error(`Could not identify the in-call ${digit} key. The native keypad is open; enter ${digit} there.`);
    }
    digitButton.click(); // Google's native DTMF handler, not a simulated keyboard event.
    // Press 1 proceeds to connecting; press 2 exits screening and lets the call close.
    if (miniCallIsPostAnswerPending()) {
      if (digit === '1') miniCallSetPostAnswerHold('connecting', snapshot, root);
      else miniCallClearPostAnswerHold();
    }
    // Do not immediately toggle the native keypad closed. Google Voice can re-render the entire
    // call panel after a tone, and a second click may hit a different control or lose call state.
    // The keypad can be closed manually in the main Google Voice window.
    miniCallScheduleRefresh();
    return { ok: true, message: `Clicked native keypad digit ${digit}. Confirm the call responds.` };
  } finally {
    miniCallActionBusy = false;
  }
}

/** Copy only control/icon metadata, never caller names, phone numbers, page text or credentials. */
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
    `Voice Desktop mini call diagnostics`, `phase=${snap.phase}`,
    `postAnswer=${postAnswer}`, `keypadAvailable=${!!snap.canKeypad}`,
    `hangupAvailable=${!!snap.canHangup}`, `panelTags=${panels.join(', ') || 'none'}`,
    `matchingControls=${buttons.join(' | ') || 'none'}`,
    `materialIcons=${iconNames.join(', ') || 'none'}`,
    `iframeCount=${document.querySelectorAll('iframe').length}`,
  ].join('\n').slice(0, 3000);
}

ipcRenderer.on('mini-call-perform-action', async (_event, request) => {
  if (!request || !Number.isInteger(request.id) || !/^(?:answer|decline|hangup|mute|tone-[12]|show-keypad|copy-diagnostics)$/.test(request.action)) return;
  try {
    const result = request.action === 'copy-diagnostics'
      ? { ok: true, diagnostics: miniCallControlDiagnostics() }
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
    const target = event.target?.closest?.('button, [role="button"]');
    if (!target) return;
    const label = miniCallLabel(target);
    // Explicitly ending or declining the native call should release the hold immediately.
    if (miniCallIsPostAnswerPending() &&
        (MINI_CALL_ACTION_LABELS.hangup.test(label) || MINI_CALL_ACTION_LABELS.decline.test(label))) {
      miniCallClearPostAnswerHold();
      return;
    }
    if (!MINI_CALL_ACTION_LABELS.answer.test(label)) return;
    const snapshot = miniCallReadSnapshot();
    if (snapshot.phase === 'incoming') miniCallSetPostAnswerHold('screening', snapshot, miniCallSurface(target));
  }, { capture: true });
  const observer = new MutationObserver(miniCallScheduleRefresh);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true,
    attributeFilter: ['aria-label', 'aria-hidden', 'class', 'style', 'title', 'hidden', 'disabled'] });
  miniCallRefresh();
  // A periodic scan catches call transitions that don't create DOM mutations (e.g. canvas or audio).
  setInterval(miniCallRefresh, 1600);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', miniCallInstallObserver, { once: true });
} else {
  miniCallInstallObserver();
}
