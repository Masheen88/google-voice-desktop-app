//main.js

// Requires
const {
  app,
  nativeImage,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  powerMonitor,
  systemPreferences,
  screen,
  dialog,
  clipboard,
} = require("electron");
const constants = require("./constants");
const BadgeGenerator = require("./badge_generator");
const path = require("node:path");
const fs = require("node:fs");
const { downloadGif, normalizeGif, normalizeSavedGifs } = require("./utils/gifService");
const { withRenderedCallWindow } = require("./utils/renderedCallWindow");
const CSSInjector = require("./utils/cssInjector");
const PreferencesStore = require("./utils/preferencesStore");
const AutoLaunch = require("./utils/autoLaunch");
const configureContextMenu = require("./utils/contextMenu");
const { pathToFileURL } = require("node:url");

// Constants
const store = new PreferencesStore(app);
const appPath = app.getAppPath();
const icon = path.join(appPath, "images", constants.APPLICATION_ICON_MEDIUM);
const iconTray = path.join(appPath, "images", constants.APPLICATION_ICON_SMALL);
const iconTrayDirty = path.join(
  appPath,
  "images",
  constants.APPLICATION_ICON_SMALL_WITH_INDICATOR,
);
const dockIcon = nativeImage.createFromPath(
  path.join(appPath, "images", constants.APPLICATION_ICON_LARGE),
);
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 900;

// Globals
let lastNotification = 0;
let badgeGenerator;
let cssInjector;
let tray;
let win; // The main application window
let settingsWindow; // When not null, the "Settings" window, which is currently open
let miniCallWindow; // Native always-on-top controller for incoming and outgoing calls
let miniCallState = { phase: "idle" };
let miniCallStartedAt = 0;
let miniCallHiddenForCurrentCall = false;
let miniCallPreview = false;
let miniCallFileMenuItem = null; // Keep the main File menu in sync with the floating controller.
let miniCallMenuSignature = ""; // Avoid rebuilding the tray menu on every DOM observation.
let miniCallNextActionId = 0;
const miniCallPendingActions = new Map();
// Retain sender-validated main-process delivery diagnostics even if Google Voice
// re-renders its call UI before the user copies the report.
let miniCallParkingActive = false;
const miniCallRenderTimeline = [];
const miniCallDeliveryAttempts = []; // Per-request history survives page re-renders.
let miniCallDeliverySequence = 0;
function miniCallRenderTrace(stage, detail) {
  // Only transport labels and coarse window states are recorded; never call data.
  const label = String(stage).replace(/[^a-z-]/g, '').slice(0, 32);
  // The values passed here are only window-state flags and fixed control outcomes;
  // keep digits and punctuation so the diagnostics remain useful.
  const info = String(detail).replace(/[^a-zA-Z0-9 =:_.,-]/g, '').slice(0, 130);
  miniCallRenderTimeline.push(`${new Date().toISOString()} ${label} ${info}`);
  if (miniCallRenderTimeline.length > 64) miniCallRenderTimeline.shift();
}
let gifPickerWindow; // Local, frameless in-app picker (not a Google Voice web page)
let gifPickerStyleKey = null;
let gifPickerDialogOpen = false;
let gifAttachmentInProgress = false;
let nextGifAttachmentId = 0;
const pendingGifAttachments = new Map();
let saveWindowSizeTimer = null; // Debounces rapid resize events before persisting bounds

// Only one instance of the app should run
if (!app.requestSingleInstanceLock()) {
  exitApplication();
}

app.on("second-instance", () => {
  showMainWindow();
});

// Track all quit paths, including operating-system quits and auto-updater installation quits.
app.on("before-quit", () => {
  app.isQuiting = true;
});

// Enforce Chromium's OS-level sandbox for renderer processes.
// Both the Google Voice window and local Settings window use sandbox-compatible preload scripts.
app.enableSandbox();

// If we're running on Windows, set our Application User Model ID to our application name.
// This will be displayed in all system Toasts that get generated to display notifications
// to the user.  If we don't do this, "electron.app.Electron" will be displayed instead.
if (isWindows()) {
  app.setAppUserModelId(constants.APPLICATION_ID);
}

// Setup notification shim to focus window.
// Validate the sender because Electron recommends validating IPC messages before acting on them.
ipcMain.on("notification-clicked", (event) => {
  if (!isMainWindowSender(event)) return;
  showMainWindow();
});

// Receive notification counts observed by the sandboxed preload script.  This replaces the
// old 3-second executeJavaScript polling loop and keeps DOM observation out of the main process.
ipcMain.on("notification-count-changed", (event, count) => {
  if (!isMainWindowSender(event)) return;

  const numericCount = Number(count);
  const safeCount = Number.isFinite(numericCount)
    ? Math.max(0, Math.min(9999, Math.trunc(numericCount)))
    : 0;

  processNotificationCount(app, safeCount);
});

// The preload script watches for an unexpectedly empty document body.  If the page remains
// empty long enough to be considered broken, reload Google Voice using the existing workaround.
ipcMain.on("blank-page-detected", (event) => {
  if (!isMainWindowSender(event)) return;
  loadGoogleVoice();
});

// Show window when clicking on macosx dock icon
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }

  // Unhide on mac if dock icon is clicked
  if (win && !win.isVisible()) {
    showMainWindow();
  }
});

app
  .whenReady()
  .then(async () => {
    // If the computer is shutting down or restarting then close
    powerMonitor.on("shutdown", () => {
      exitApplication();
    });

    // Ask for permission to use the microphone if the OS requires it.
    // macOS system media permission prompts should only be requested after Electron is ready.
    if (isMac()) {
      try {
        console.log("asking for microphone access");
        await systemPreferences.askForMediaAccess("microphone");
      } catch (error) {
        console.error("Unable to request microphone access:", error);
      }
    }

    app.dock?.setIcon(dockIcon);

    createWindow();

    // electron-builder generates the update metadata consumed by electron-updater.
    // Draft GitHub releases are ignored until they are actually published, which fits
    // the current build.publish.releaseType configuration.
    if (app.isPackaged) {
      // Load the updater only in packaged builds so development startup stays lean.
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      // Keep NSIS Web releases compatible with future electron-updater defaults.
      autoUpdater.disableWebInstaller = false;

      try {
        await autoUpdater.checkForUpdatesAndNotify();
      } catch (error) {
        console.error("Automatic update check failed:", error);
      }
    }
  })
  .catch((error) => {
    console.error("Application initialization failed:", error);
  });

// Creates and returns this application's main BrowserWindow, navigated to Google Voice.
function createWindow() {
  // Create the window, making it hidden initially.  If we have
  // it on record, re-apply the window size last set by the user.
  const prefs = store.get("prefs") || {};
  win = new BrowserWindow({
    width: prefs.windowWidth || DEFAULT_WIDTH,
    height: prefs.windowHeight || DEFAULT_HEIGHT,
    icon,
    show: false,
    webPreferences: {
      spellcheck: true,
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      // Incoming calls and their DOM transitions must keep working while the Voice window is in the tray.
      backgroundThrottling: false,
    },
  });

  // Provide the small context menu feature set we actually use without shipping
  // the electron-context-menu dependency tree in production builds.
  configureContextMenu(win, {
    allowInspect: !app.isPackaged,
    allowSaveImage: true,
  });

  //win.webContents.openDevTools();

  // Create the window's menu bar.
  let menuBar = Menu.buildFromTemplate([
    {
      label: "&File",
      submenu: [
        {
          label: "&Reload",
          click: () => {
            loadGoogleVoice();
          },
        }, // Reload Google Voice within our main window
        {
          label: "Go to &website",
          click: () => {
            openGoogleVoiceExternal();
          },
        }, // Open Google Voice externally in the user's browser
        { type: "separator" },
        {
          label: "&Settings",
          click: () => {
            void showSettingsWindow();
          },
        }, // Open/display our Settings window
        {
          id: "mini-call-toggle",
          label: "Show mini &call controller",
          accelerator: "CommandOrControl+Shift+M",
          click: () => { void toggleMiniCallController(); },
        }, // Manually reopen the floating controller, or preview the idle state.
        {
          label: "&GIF picker",
          accelerator: "CommandOrControl+Shift+G",
          click: () => {
            if (store.get("prefs.gifEnabled", true) !== false) {
              const bounds = win?.getContentBounds();
              if (bounds) void showGifPicker({ x: bounds.width - 80, y: bounds.height - 58 });
            }
          },
        }, // Keyboard fallback if Google's toolbar markup changes.
        { type: "separator" },
        {
          label: "&Close", // Close the window
          accelerator: isMac() ? "Command+W" : "Ctrl+W",
          click: () => {
            win.close();
          },
        },
        {
          label: "&Exit", // Exit the application
          accelerator: isMac() ? "Command+Q" : "Ctrl+Shift+W",
          click: () => {
            exitApplication();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", selector: "undo:" },
        { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", selector: "redo:" },
        { type: "separator" },
        { label: "Cut", accelerator: "CmdOrCtrl+X", selector: "cut:" },
        { label: "Copy", accelerator: "CmdOrCtrl+C", selector: "copy:" },
        { label: "Paste", accelerator: "CmdOrCtrl+V", selector: "paste:" },
        {
          label: "Select All",
          accelerator: "CmdOrCtrl+A",
          selector: "selectAll:",
        },
      ],
    },
    {
      label: "&View",
      submenu: [
        { role: "zoomIn", visible: false }, // Zoom in (Ctrl+Shift++)
        { role: "zoomIn", accelerator: "CommandOrControl+=" }, // Zoom in (Ctrl+=)
        { role: "zoomOut" }, // Zoom out (Ctrl+-)
        {
          role: "zoomOut",
          visible: false,
          accelerator: "CommandOrControl+Shift+_",
        }, // Zoom out (Ctrl+Shift+_)
        { role: "resetZoom" }, // Reset zoom (Ctrl+0)
        { type: "separator" },
        { role: "toggleFullScreen" }, // Toggle full screen (F11)
        { type: "separator" },
        {
          label: "&Hide menu bar",
          visible: !isMac(),
          click: () => {
            win.setMenuBarVisibility(false);
          },
        }, // Hide the menu bar (not supported for Mac)
      ],
    },
    {
      label: "&Help",
      submenu: [
        {
          label: "Report a &bug",
          click: () => {
            openExternalSafe(constants.URL_GITHUB_REPORT_BUG);
          },
        },
        {
          label: "Request a &feature",
          click: () => {
            openExternalSafe(constants.URL_GITHUB_FEATURE_REQUEST);
          },
        },
        {
          label: "Ask a &question",
          click: () => {
            openExternalSafe(constants.URL_GITHUB_ASK_QUESTION);
          },
        },
        {
          label: "View &issues",
          click: () => {
            openExternalSafe(constants.URL_GITHUB_VIEW_ISSUES);
          },
        },
        { type: "separator" },
        {
          label: "&Security Policy",
          click: () => {
            openExternalSafe(constants.URL_GITHUB_SECURITY_POLICY);
          },
        },
        { type: "separator" },
        {
          label: "View &releases",
          click: () => {
            openExternalSafe(constants.URL_GITHUB_RELEASES);
          },
        },
        {
          label: `&About (v${app.getVersion()})`,
          click: () => {
            openExternalSafe(constants.URL_GITHUB_README);
          },
        },
      ],
    },
  ]);

  miniCallFileMenuItem = menuBar.getMenuItemById('mini-call-toggle');
  // Set the menu bar's visibility.
  if (isMac()) {
    Menu.setApplicationMenu(menuBar); // On Mac, we always show the menu bar
  } else {
    // On Windows/Linux, we give the user a setting for hiding the menu bar.  Add the menu bar to
    // the window (which ensures that its keyboard shortcuts will work regardless of the menu bar's
    // visibility), but make the menu bar visible only if the user hasn't asked us to hide it.
    win.setMenu(menuBar);
    if (
      (prefs.showMenuBar != undefined && !prefs.showMenuBar) ||
      !constants.DEFAULT_SETTING_SHOW_MENU_BAR
    ) {
      win.setMenuBarVisibility(false);
    }
  }

  // Set explicit permission handlers for the session that loads remote Google Voice content.
  // Electron otherwise permits many web permissions by default, so this keeps the app limited to
  // permissions that Google Voice reasonably needs for calling and normal web-app behavior.
  configureRemoteContentPermissions(win.webContents.session);

  // Create our system notification area icon before navigation so that notification-count messages
  // from the preload script can immediately update the tray icon on a fast page load.
  if (tray) {
    tray.destroy();
  }
  tray = createTray(iconTray, constants.APPLICATION_NAME);
  miniCallMenuSignature = ''; // New tray instance always receives the latest controller state.
  miniCallSyncControls();

  badgeGenerator = new BadgeGenerator(win);
  cssInjector = new CSSInjector(app, win);

  // Navigate the window to Google Voice.  When it finishes loading, modify Google's markup as needed
  // to support user customizations that we allow the user to make from within our application UI.
  loadGoogleVoice();
  win.webContents.on("did-finish-load", () => {
    miniCallSyncControls();
    // Keep the GIF launcher's styling outside Google's page CSP. The launcher itself is
    // installed in the already-isolated preload and never exposes native app APIs.
    if (isGoogleVoiceUrl(win.webContents.getURL())) {
      const stylesheet = fs.readFileSync(path.join(__dirname, "gif-voice.css"), "utf8");
      win.webContents.insertCSS(stylesheet).then((key) => {
        gifPickerStyleKey = key;
      }).catch((error) => console.error("GIF button stylesheet error:", error));
    }

    // Only apply Google Voice-specific custom CSS on the actual Voice application page.
    // This prevents a custom theme from accidentally restyling the Google Account login page.
    if (!isGoogleVoiceUrl(win.webContents.getURL())) return;

    // Re-apply the theme last selected by the user.
    const theme = store.get("prefs.theme") ?? constants.DEFAULT_SETTING_THEME;
    const hideDialerSidebar =
      store.get("prefs.hideDialerSidebar") ??
      constants.DEFAULT_HIDE_DIALER_SIDEBAR;

    cssInjector.injectTheme(theme);
    cssInjector.showHideDialerSidebar(hideDialerSidebar);
  });

  // Modern Electron uses setWindowOpenHandler instead of the legacy "new-window" event.
  // If the target URL is a Google Voice URL, have our main window navigate to it instead of opening
  // it in a new window.  This supports the ability to add additional accounts and switch between
  // them on-demand.  Otherwise, for all other URLs, have the system open them using the default type
  // handler.  This is done to force URLs to open in the user's browser, where they are likely already
  // signed into services that need authentication (e.g. Spotify).  Note that if the user ever gets
  // stuck navigated somewhere that isn't the main Google Voice page, they can always use the "Reload"
  // item in the notification area icon context menu to get back to the Google Voice home page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedInternalUrl(url)) {
      if (win && !win.isDestroyed()) {
        win.loadURL(url).catch((error) => {
          console.error(`Unable to load internal Google URL: ${url}`, error);
        });
      }
    } else {
      openExternalSafe(url);
    }

    return { action: "deny" };
  });

  // Prevent the current renderer from silently navigating away from the two origins intentionally
  // hosted inside the Electron window.  External links are handed to the operating system browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedInternalUrl(url)) return;

    event.preventDefault();
    openExternalSafe(url);
  });

  // If Chromium's renderer process crashes, reload the known-safe Google Voice entry point instead
  // of leaving the user with a dead window.
  win.webContents.on('did-start-navigation', (_event, navigationInfo) => {
    // A full navigation/reload invalidates the previous call controls; let the new preload rediscover them.
    if (navigationInfo?.isMainFrame !== false) miniCallSetState({ phase: 'idle' });
  });

  win.webContents.on("render-process-gone", (event, details) => {
    console.error("Google Voice renderer process exited:", details);

    if (!app.isQuiting) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          loadGoogleVoice();
        }
      }, 500);
    }
  });

  // Whenever a request is made for the window to be closed, determine whether we should allow the close to
  // happen and terminate the application, or just hide the window and keep running in the notification area.
  win.on("close", function (event) {
    // Proceed based on the reason why the window is being closed.
    if (app.isQuiting) {
      // The window is being closed as a result of us calling app.quit() due to the
      // user's invocation of one of our "Exit" menu items.  In this case, we'll
      // allow the close to happen.  This will lead to termination of the application.
    } else {
      // The window is being closed as a result of the user explicitly trying to close
      // it.  If the user has enabled the "exit on close" setting, allow the close and
      // subsequent termination of the application to proceed.  Otherwise, cancel the
      // close and hide the window instead; we'll keep running in the notification area.
      const exitOnClose =
        store.get("prefs.exitOnClose") ??
        constants.DEFAULT_SETTING_EXIT_ON_CLOSE;
      if (!exitOnClose) {
        event.preventDefault();
        win.hide();
      } else {
        // "Exit on close" should actually terminate the tray application, not merely destroy
        // the BrowserWindow and leave the process running in the background.
        event.preventDefault();
        exitApplication();
      }
    }
  });

  win.on("restore", function () {
    // Do not focus/show the full Voice window when temporarily restoring it
    // offscreen for a mini-controller keypad action.
    if (!miniCallParkingActive) win.show();
  });

  win.on("resize", saveWindowSize);

  win.on("closed", () => {
    // Closing the authenticated Voice window also invalidates any floating call controls.
    miniCallState = { phase: "idle" };
    miniCallStartedAt = 0;
    miniCallFileMenuItem = null;
    if (miniCallWindow && !miniCallWindow.isDestroyed()) miniCallWindow.close();
    if (gifPickerWindow && !gifPickerWindow.isDestroyed()) gifPickerWindow.close();
    gifPickerStyleKey = null;
    win = null;
    cssInjector = null;
    badgeGenerator = null;
  });

  // Now that we've finished creating and initializing the window, show
  // it (unless the user has enabled the "start minimized" setting).
  if (!prefs.startMinimized) {
    console.log("Window is showing...");

    win.show();
  }

  return win;
}

// Terminates this application.
function exitApplication() {
  app.isQuiting = true;
  app.quit();
}

// Loads Google Voice inside this application's main browser window.  During the
// load, Google Voice itself takes care of asking the user to log in when necessary.
function loadGoogleVoice() {
  if (win && !win.isDestroyed()) {
    win.loadURL(constants.URL_GOOGLE_VOICE).catch((error) => {
      console.error("Unable to load Google Voice:", error);
    });
  }
}

// Opens Google Voice in the user's default external browser.
function openGoogleVoiceExternal() {
  openExternalSafe(constants.URL_GOOGLE_VOICE);
}

// Notification counts are now observed by src/preload.js using a MutationObserver.
// This avoids repeatedly running arbitrary JavaScript from the main process while still
// preserving the same processNotificationCount() operating-system behavior below.

// Displays a specified notification count to the user (if it isn't already
// being displayed), in a way that is appropriate for their Operating System.
function processNotificationCount(app, count) {
  if (count !== lastNotification) {
    // Update our record of what the new count is.  We update our record *before* proceeding to ensure we don't
    // enter a loop of continuously trying to update UI in the event that we experience some failure down below.
    let oldCount = lastNotification;
    lastNotification = count;

    // Perform OS-specific operations.
    if (isMac()) {
      processNotificationCount_MacOS(app, oldCount, count);
    } else if (isWindows()) {
      processNotificationCount_Windows(oldCount, count);
    }

    // Update our notification area icon based on the count.  If it's greater than 0,
    // display the icon with a red dot, otherwise display the icon without a red dot.
    if (count > 0) {
      tray?.setImage(iconTrayDirty);
    } else {
      tray?.setImage(iconTray);
    }
  }
}

// Updates this application's UI on Windows in a way that is appropriate for a specified notification count.
function processNotificationCount_Windows(oldCount, newCount) {
  if (win) {
    // If the specified new count is non-0, use our Badge Generator to dynamically generate an image representing it,
    // and then apply the image as an overlay icon on our main window's Taskbar button.  Note that if the user has
    // the "Use small Taskbar buttons" setting turned on, the overlay won't actually be rendered due to lack of space.
    if (newCount) {
      badgeGenerator
        .generate(newCount)
        .then((base64) => {
          const image = nativeImage.createFromDataURL(base64);
          win.setOverlayIcon(image, "You have new messages and/or calls");
        })
        .catch((error) => {
          console.error(
            "Unable to generate Windows notification badge:",
            error,
          );
        });
    } else {
      win.setOverlayIcon(null, "");
    }

    // If the notification count has gone up and our main window isn't currently
    // focused, also flash the window's Taskbar button to catch the user's attention.
    if (newCount > oldCount && !win.isFocused()) {
      win.flashFrame(true);
    }
  }
}

// Updates this application's UI on Mac OS in a way that is appropriate for a specified notification count.
function processNotificationCount_MacOS(app, oldCount, newCount) {
  // Overlay the specified new count on our Dock icon.  If the count has
  // increased, also bouce the icon the catch the user's attention.
  if (app.dock) {
    app.dock.setBadge(`${newCount || ""}`);
    if (newCount > oldCount) {
      app.dock.bounce();
    }
  }
}

// Creates this application's notification area icon.
function createTray(iconPath, tipText) {
  // Create the icon, assigning it our application icon and name.
  let appIcon = new Tray(iconPath);
  appIcon.setToolTip(tipText);

  // Construct the icon's context menu.  Rebuilt on phase/visibility changes only.
  appIcon.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "&Open",
        click: () => {
          showMainWindow();
        },
      },
      {
        label: "&Reload",
        click: () => {
          loadGoogleVoice();
        },
      },
      { type: "separator" },
      {
        label: "&Settings",
        click: () => {
          void showSettingsWindow();
        },
      },
      {
        label: "Show mini call controller",
        click: () => { void toggleMiniCallController(); },
      },
      { type: "separator" },
      {
        label: "&Exit",
        click: () => {
          exitApplication();
        },
      },
    ]),
  );

  appIcon.on("click", function (event) {
    showMainWindow();
  });

  return appIcon;
}

// Displays this application's main window to the user.
function showMainWindow() {
  if (!win || win.isDestroyed()) return;

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();
}

// Creates (if it doesn't already exist) this application's "Settings" window, and then displays it to the user.
async function showSettingsWindow() {
  if (gifPickerWindow && !gifPickerWindow.isDestroyed()) gifPickerWindow.hide();
  if (!settingsWindow) {
    // Create our Settings window, keeping a global reference to it.  This reference allows
    // us to know when the window is open, preventing the user from opening it a second time.
    settingsWindow = new BrowserWindow({
      width: 680,
      height: 720,
      minWidth: 560,
      minHeight: 560,
      title: "Settings",
      parent: win,
      modal: true,
      resizable: true,
      minimizable: false,
      webPreferences: {
        preload: path.join(__dirname, "settings-preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
      },
    });
    settingsWindow.removeMenu();
    configureContextMenu(settingsWindow, {
      allowInspect: !app.isPackaged,
      allowSaveImage: false,
    });

    // Settings are exposed through a narrow preload/contextBridge API instead of attaching
    // privileged objects directly to the renderer window.

    // Load our settings page into the window.
    await settingsWindow.loadFile(
      path.join(appPath, "src", "pages", "customize.html"),
    );
    //settingsWindow.webContents.openDevTools();

    // When the window gets closed, release its global reference.
    settingsWindow.on("closed", function () {
      settingsWindow = null;
    });
  } else {
    // Our Settings window is already open, just bring it back to the foreground.
    settingsWindow.show();
  }
}

function saveWindowSize() {
  // Resize can fire dozens of times while the user drags the window.  Debounce the disk write
  // so the preferences file is not rewritten on every individual resize event.
  clearTimeout(saveWindowSizeTimer);

  saveWindowSizeTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || miniCallParkingActive) return;

    const bounds = win.getBounds();
    store.set("prefs.windowWidth", bounds.width);
    store.set("prefs.windowHeight", bounds.height);
  }, 250);
}

// ====================================================================================================================
// Helper Functions
// ====================================================================================================================

// Returns true when an IPC message came from the main Google Voice BrowserWindow.
function isMainWindowSender(event) {
  return Boolean(
    win && !win.isDestroyed() && event && event.sender === win.webContents,
  );
}

// Returns true when an IPC message came from the local Settings BrowserWindow.
function isSettingsWindowSender(event) {
  return Boolean(
    settingsWindow &&
    !settingsWindow.isDestroyed() &&
    event &&
    event.sender === settingsWindow.webContents,
  );
}

// Throws when a privileged Settings IPC method is invoked by anything except the Settings window.
function assertSettingsWindowSender(event) {
  if (!isSettingsWindowSender(event)) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
}

// Returns true when the specified URL is the actual Google Voice application.
function isGoogleVoiceUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === constants.GOOGLE_VOICE_HOSTNAME
    );
  } catch (error) {
    console.error(`Invalid Google Voice URL: ${value}`, error);
    return false;
  }
}

// Returns true when a URL may remain inside the Electron BrowserWindow.
// Keep this allowlist intentionally small: Voice itself plus Google's account login origin.
function isAllowedInternalUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === constants.GOOGLE_VOICE_HOSTNAME ||
        parsed.hostname === constants.GOOGLE_ACCOUNTS_HOSTNAME)
    );
  } catch (error) {
    console.error(`Invalid allowed internal URL: ${value}`, error);
    return false;
  }
}

// Opens an external URL only when it uses a protocol that is reasonable to hand to the OS.
// This prevents renderer-controlled values from being passed to shell.openExternal with dangerous
// schemes such as file:, javascript:, data:, or custom executable handlers.
function openExternalSafe(value) {
  try {
    const parsed = new URL(value);
    const allowedProtocols = new Set(["https:", "http:", "mailto:", "tel:"]);

    if (!allowedProtocols.has(parsed.protocol)) {
      console.warn(`Blocked unsupported external URL: ${value}`);
      return;
    }

    shell.openExternal(value).catch((error) => {
      console.error(`Unable to open external URL: ${value}`, error);
    });
  } catch (error) {
    console.warn(`Blocked invalid external URL: ${value}`, error);
  }
}

// Configures an explicit permission allowlist for remote Google Voice content.
function configureRemoteContentPermissions(ses) {
  const voicePermissions = new Set([
    "media",
    "notifications",
    "speaker-selection",
    "clipboard-sanitized-write",
    "fullscreen",
    "storage-access",
    "top-level-storage-access",
  ]);

  const accountPermissions = new Set([
    "storage-access",
    "top-level-storage-access",
  ]);

  const isPermissionAllowed = (permission, originValue) => {
    // Electron/Chromium can perform permission checks before navigation has
    // established a requesting origin. An empty origin should simply be denied
    // rather than passed to URL(), which would generate a noisy Invalid URL error.
    if (typeof originValue !== "string" || originValue.trim().length === 0) {
      return false;
    }

    try {
      const parsed = new URL(originValue);

      if (parsed.protocol !== "https:") {
        return false;
      }

      if (parsed.hostname === constants.GOOGLE_VOICE_HOSTNAME) {
        return voicePermissions.has(permission);
      }

      if (parsed.hostname === constants.GOOGLE_ACCOUNTS_HOSTNAME) {
        return accountPermissions.has(permission);
      }

      return false;
    } catch (error) {
      console.warn(
        `Blocked invalid origin for permission check: ${originValue}`,
        error,
      );

      return false;
    }
  };

  ses.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      const origin =
        details?.requestingUrl ||
        details?.securityOrigin ||
        requestingOrigin ||
        webContents?.getURL() ||
        "";

      return isPermissionAllowed(permission, origin);
    },
  );

  ses.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const origin =
        details?.requestingUrl ||
        details?.securityOrigin ||
        webContents?.getURL() ||
        "";

      callback(isPermissionAllowed(permission, origin));
    },
  );
}

function isMac() {
  return process.platform === "darwin";
}
function isWindows() {
  return process.platform === "win32";
}

// ====================================================================================================================
// Invokable IPC Handlers
// ====================================================================================================================

// Returns the icon URL used by the main-window notification shim.
ipcMain.handle("get-notification-icon-url", (event) => {
  if (!isMainWindowSender(event)) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }

  return pathToFileURL(icon).href;
});

// Returns the platform that this application is running on.
ipcMain.handle("get-platform", (event) => {
  assertSettingsWindowSender(event);
  return process.platform;
});

// Returns an object representing the user's current settings store.
ipcMain.handle("get-user-prefs", (event) => {
  assertSettingsWindowSender(event);
  return store.get("prefs") || {};
});

// Returns a bool indicating whether this application is registered to start automatically at logon.
ipcMain.handle("get-start-automatically", async (event) => {
  assertSettingsWindowSender(event);

  try {
    return AutoLaunch.isEnabled(app, constants.APPLICATION_ID);
  } catch (error) {
    console.error("Unable to read auto-launch state:", error);
    return false;
  }
});

// Returns the current zoom level of this this application's main window.
ipcMain.handle("get-zoom-level", (event) => {
  assertSettingsWindowSender(event);
  return win && !win.isDestroyed() ? win.webContents.getZoomLevel() : 0;
});

// ====================================================================================================================
// Settings Window Event Handlers
// ====================================================================================================================

// Called when the theme has been changed.
ipcMain.on("pref-change-theme", (event, theme) => {
  if (!isSettingsWindowSender(event)) return;
  if (!constants.SUPPORTED_THEMES.includes(theme)) return;

  console.log(`Theme changed to: ${theme}`);

  // Apply the selected them and then save the selection to the user's settings store.
  if (cssInjector) {
    cssInjector.injectTheme(theme);
  }
  store.set("prefs.theme", theme);
});

// Called when the zoom level has been changed.
ipcMain.on("pref-change-zoom", (event, zoomLevel) => {
  if (!isSettingsWindowSender(event)) return;

  const parsedZoomLevel = Number.parseInt(zoomLevel, 10);
  if (!Number.isInteger(parsedZoomLevel)) return;

  const safeZoomLevel = Math.max(-8, Math.min(9, parsedZoomLevel));
  console.log(`Zoom level changed to: ${safeZoomLevel}`);

  // Apply the newly selected zoom level.  Note that there is no need to save this setting to
  // the user's settings store.  Electron handles remembering our main window's zoom level by
  // default, so it will automatically be restored the next time the application is launched.
  if (win && !win.isDestroyed()) {
    win.webContents.setZoomLevel(safeZoomLevel);
  }
});

// Called when the "show menu bar" checkbox has been checked/unchecked.
ipcMain.on("pref-change-show-menubar", (event, showMenuBar) => {
  if (!isSettingsWindowSender(event)) return;
  if (typeof showMenuBar !== "boolean") return;

  console.log(`"Show menu bar changed to: ${showMenuBar}`);

  // Apply the new value and then save it to the user's settings store.
  if (win && !win.isDestroyed()) {
    win.setMenuBarVisibility(showMenuBar);
  }
  store.set("prefs.showMenuBar", showMenuBar);
});

// Called when the "start automatically" checkbox has been checked/unchecked.
ipcMain.on(
  "pref-change-start-automatically",
  async (event, startAutomatically) => {
    if (!isSettingsWindowSender(event)) return;
    if (typeof startAutomatically !== "boolean") return;

    console.log(`"Start Automatically" changed to: ${startAutomatically}`);

    // Register/unregister this application to be automatically started at logon.
    // Electron handles Windows/macOS natively; our tiny helper writes the
    // freedesktop autostart entry on Linux.
    try {
      AutoLaunch.setEnabled(
        app,
        constants.APPLICATION_ID,
        constants.APPLICATION_NAME,
        startAutomatically,
      );
    } catch (error) {
      console.error("Unable to update auto-launch state:", error);
    }
  },
);

// Called when the "start minimized" checkbox has been checked/unchecked.
ipcMain.on("pref-change-start-minimized", (event, startMinimized) => {
  if (!isSettingsWindowSender(event)) return;
  if (typeof startMinimized !== "boolean") return;

  console.log(`"Start Minimized" changed to: ${startMinimized}`);

  // Apply the new value and then save it to the user's settings store.
  store.set("prefs.startMinimized", startMinimized);
});

// Called when the "exit on close" checkbox has been checked/unchecked.
ipcMain.on("pref-change-exit-on-close", (event, exitOnClose) => {
  if (!isSettingsWindowSender(event)) return;
  if (typeof exitOnClose !== "boolean") return;

  console.log(`"Exit on close" changed to: ${exitOnClose}`);

  // Apply the new value and then save it to the user's settings store.
  store.set("prefs.exitOnClose", exitOnClose);
});

// Called when the "hide dialer sidebar" checkbox has been checked/unchecked.
ipcMain.on("pref-change-hide-dialer-sidebar", (event, hideDialerSidebar) => {
  if (!isSettingsWindowSender(event)) return;
  if (typeof hideDialerSidebar !== "boolean") return;

  console.log(`Hide dialer sidebar changed to: ${hideDialerSidebar}`);

  // Apply the new value and then save it to the user's settings store.
  if (cssInjector) {
    cssInjector.showHideDialerSidebar(hideDialerSidebar);
  }
  store.set("prefs.hideDialerSidebar", hideDialerSidebar);
});

// ====================================================================================================================
// Floating mini call controller. All live actions go through Google's existing UI in the main preload.
// ====================================================================================================================

/** Validate the sender of every action. The Google Voice renderer never receives the controller bridge. */
function isMiniCallWindowSender(event) {
  return !!(miniCallWindow && !miniCallWindow.isDestroyed() && event.sender === miniCallWindow.webContents);
}

/** Store a small, primitive-only snapshot; do not pass arbitrary remote page HTML to local pages. */
function sanitizeMiniCallSnapshot(value) {
  if (!value || typeof value !== 'object' || !['incoming', 'outgoing', 'screening', 'active', 'idle'].includes(value.phase)) return null;
  if (value.phase === 'idle') return { phase: 'idle' };
  const party = typeof value.party === 'string' ? value.party.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 85) : '';
  const clean = { phase: value.phase, party,
    direction: ['incoming', 'outgoing'].includes(value.direction) ? value.direction : 'unknown' };
  for (const key of ['canAnswer', 'canDecline', 'canHangup', 'canMute', 'muted', 'canKeypad', 'awaitingScreening']) clean[key] = value[key] === true;
  return clean;
}

function miniCallSendState() {
  if (!miniCallWindow || miniCallWindow.isDestroyed() || miniCallWindow.webContents.isLoadingMainFrame()) return;
  const preview = miniCallPreview && miniCallState.phase === 'idle';
  miniCallWindow.webContents.send('mini-call-update', preview
    ? { phase: 'incoming', party: 'Test incoming call', preview: true, canAnswer: true, canDecline: true, canKeypad: false }
    : { ...miniCallState, since: miniCallStartedAt });
}

/** Choose a visible work area and keep user-customized positions on-screen after monitor changes. */
function miniCallInitialBounds(height = 224) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const work = display.workArea;
  const width = 320;
  const saved = store.get('prefs.miniCallPosition', null);
  const fits = saved && Number.isInteger(saved.x) && Number.isInteger(saved.y) &&
    saved.x >= work.x && saved.x + width <= work.x + work.width &&
    saved.y >= work.y && saved.y + height <= work.y + work.height;
  return { x: fits ? saved.x : work.x + work.width - width - 16,
    y: fits ? saved.y : work.y + 22, width, height };
}

function miniCallDesiredHeight() {
  // The screening buttons disappear on connected and outgoing calls.
  if (miniCallState.phase === 'screening') return 274;
  if (miniCallState.phase === 'incoming' || miniCallPreview) return 232;
  return 202;
}

function miniCallResizeForPhase() {
  if (!miniCallWindow || miniCallWindow.isDestroyed()) return;
  const height = miniCallDesiredHeight();
  if (miniCallWindow.getBounds().height !== height) {
    const bounds = miniCallWindow.getBounds();
    const nearest = screen.getDisplayMatching(bounds).workArea;
    miniCallWindow.setBounds({ ...bounds, y: Math.min(bounds.y, nearest.y + nearest.height - height), height });
  }
}

/** A hidden mini controller is "minimized" to the tray, not closed or removed from call tracking. */
function miniCallIsVisible() {
  return !!(miniCallWindow && !miniCallWindow.isDestroyed() && miniCallWindow.isVisible());
}

function miniCallUiStatus() {
  return {
    visible: miniCallIsVisible(),
    enabled: store.get('prefs.miniCallEnabled', true) !== false,
    phase: miniCallState.phase,
  };
}

/** Keep the Google Voice launcher and both native menus synchronized with the same state. */
function miniCallSyncControls() {
  const status = miniCallUiStatus();
  const label = status.visible ? 'Hide mini call controller' : 'Show mini call controller';
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send('mini-call-visibility', status);
  }
  if (miniCallFileMenuItem) {
    miniCallFileMenuItem.label = label;
    miniCallFileMenuItem.enabled = status.enabled;
  }
  const signature = `${status.visible}:${status.enabled}:${status.phase}`;
  if (tray && !tray.isDestroyed() && signature !== miniCallMenuSignature) {
    miniCallMenuSignature = signature;
    const phaseText = ({ incoming: 'Ringing', screening: 'Screening',
      outgoing: 'Calling', active: 'In call' })[status.phase];
    tray.setContextMenu(Menu.buildFromTemplate([
      ...(phaseText ? [{ label: `Call: ${phaseText}`, enabled: false }] : []),
      { label: '&Open Google Voice', click: () => showMainWindow() },
      { label, enabled: status.enabled, click: () => { void toggleMiniCallController(); } },
      { type: 'separator' },
      { label: '&Reload', click: () => loadGoogleVoice() },
      { label: '&Settings', click: () => { void showSettingsWindow(); } },
      { type: 'separator' },
      { label: '&Exit', click: () => exitApplication() },
    ]));
  }
}

function hideMiniCallController() {
  // Hiding must not stop detecting call changes or stop the call itself.
  miniCallHiddenForCurrentCall = true;
  miniCallPreview = false;
  if (miniCallIsVisible()) miniCallWindow.hide();
  miniCallSyncControls();
}

async function toggleMiniCallController() {
  if (miniCallIsVisible()) {
    hideMiniCallController();
    return;
  }
  await showMiniCallController({ manual: true });
}

// Only the authenticated Google Voice renderer can request the mini controller visibility.
ipcMain.on('mini-call-toggle-from-voice', (event) => {
  if (!isMainWindowSender(event) || !isGoogleVoiceUrl(event.sender.getURL())) return;
  void toggleMiniCallController();
});
ipcMain.on('mini-call-request-ui-state', (event) => {
  if (!isMainWindowSender(event) || !isGoogleVoiceUrl(event.sender.getURL())) return;
  event.sender.send('mini-call-visibility', miniCallUiStatus());
});

async function showMiniCallController({ manual = false, preview = false } = {}) {
  if (store.get('prefs.miniCallEnabled', true) === false) return;
  if (preview && miniCallState.phase === 'idle') miniCallPreview = true;
  if (manual) miniCallHiddenForCurrentCall = false;
  if (!miniCallWindow || miniCallWindow.isDestroyed()) {
    const bounds = miniCallInitialBounds(miniCallDesiredHeight());
    miniCallWindow = new BrowserWindow({
      ...bounds,
      title: 'Voice Desktop · Mini Call',
      icon,
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true, // A call controller must always be above other windows while visible.
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'mini-call-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
      },
    });
    miniCallWindow.setMenu(null);
    // Do not allow a saved preference from an older version to defeat call visibility.
    miniCallWindow.setAlwaysOnTop(true, 'floating');
    miniCallWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    miniCallWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    miniCallWindow.on('moved', () => {
      if (miniCallWindow && !miniCallWindow.isDestroyed()) {
        const { x, y } = miniCallWindow.getBounds();
        store.set('prefs.miniCallPosition', { x, y });
      }
    });
    miniCallWindow.on('show', miniCallSyncControls);
    miniCallWindow.on('hide', miniCallSyncControls);
    miniCallWindow.on('closed', () => { miniCallWindow = null; miniCallSyncControls(); });
    await miniCallWindow.loadFile(path.join(__dirname, 'pages', 'mini-call.html'));
  }
  if (!miniCallWindow || miniCallWindow.isDestroyed()) return;
  miniCallResizeForPhase();
  miniCallSendState();
  // Reinstate the z-order after display changes or another application steals focus.
  miniCallWindow.setAlwaysOnTop(true, 'floating');
  miniCallWindow.showInactive(); // Keep focus in VS Code, REAPER, or the active desktop app.
  miniCallSyncControls();
}

function miniCallSetState(nextState) {
  const previous = miniCallState;
  const wasLive = previous.phase !== 'idle';
  const isLive = nextState.phase !== 'idle';
  const changed = JSON.stringify(previous) !== JSON.stringify(nextState);
  miniCallState = nextState;
  if (!wasLive && isLive) {
    miniCallStartedAt = Date.now();
    miniCallHiddenForCurrentCall = false;
    miniCallPreview = false;
  }
  if (!isLive) {
    miniCallStartedAt = 0;
    miniCallHiddenForCurrentCall = false;
    miniCallPreview = false;
    if (miniCallIsVisible()) miniCallWindow.hide();
    if (changed) miniCallSendState();
    miniCallSyncControls();
    return;
  }
  // Repaint the mini UI whenever Google Voice changes phase or mute/keypad status.
  // Do not reshow/re-focus an existing controller on every 1.6-second DOM scan.
  if (changed) {
    miniCallResizeForPhase();
    miniCallSendState();
    miniCallSyncControls();
  }
  if (store.get('prefs.miniCallEnabled', true) !== false &&
      !miniCallHiddenForCurrentCall && !miniCallIsVisible()) {
    void showMiniCallController().catch((error) => console.error('Mini call controller failed to open:', error));
  }
}

ipcMain.on('mini-call-observed', (event, snapshot) => {
  if (!isMainWindowSender(event) || !isGoogleVoiceUrl(event.sender.getURL())) return;
  const clean = sanitizeMiniCallSnapshot(snapshot);
  if (clean) miniCallSetState(clean);
});

ipcMain.handle('mini-call-ready', (event) => {
  if (!isMiniCallWindowSender(event)) throw new Error('Untrusted mini call controller.');
  const preview = miniCallPreview && miniCallState.phase === 'idle';
  return preview ? { phase: 'incoming', party: 'Test incoming call', preview: true, canAnswer: true, canDecline: true }
    : { ...miniCallState, since: miniCallStartedAt };
});

/**
 * Forward one allowlisted action into the authenticated Google Voice preload.
 * The matching response is correlated by ID; the renderer is never given Node APIs.
 */
function miniCallWindowFlags() {
  if (!win || win.isDestroyed()) return 'closed';
  return `visible=${win.isVisible()} minimized=${win.isMinimized()} focused=${win.isFocused()}`;
}

/** Main-process diagnostic record, not cleared by Angular re-render or navigation. */
function miniCallSaveDeliveryAttempt(attempt) {
  miniCallDeliveryAttempts.push(attempt);
  if (miniCallDeliveryAttempts.length > 20) miniCallDeliveryAttempts.shift();
}

function miniCallForwardAction(action, deliveryMode = 'direct') {
  return new Promise((resolve) => {
    const id = ++miniCallNextActionId;
    const timeout = setTimeout(() => {
      miniCallPendingActions.delete(id);
      resolve({ ok: false, message: 'Google Voice did not respond to the call-control request.' });
    }, 10500);
    miniCallPendingActions.set(id, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
    win.webContents.send('mini-call-perform-action', { id, action, deliveryMode });
  });
}

ipcMain.handle('mini-call-action', async (event, action) => {
  if (!isMiniCallWindowSender(event)) throw new Error('Untrusted mini call controller.');
  if (action === 'open-main') { showMainWindow(); return { ok: true }; }
  if (action === 'hide') {
    hideMiniCallController();
    return { ok: true };
  }
  if (!['answer', 'decline', 'hangup', 'mute', 'tone-1', 'tone-2', 'show-keypad', 'copy-diagnostics'].includes(action)) {
    return { ok: false, message: 'Unsupported mini call action.' };
  }
  if (miniCallState.phase === 'idle' || !win || win.isDestroyed() || !isGoogleVoiceUrl(win.webContents.getURL())) {
    return { ok: false, message: 'No active Google Voice call to control.' };
  }
  if (action.startsWith('tone-') && miniCallState.phase === 'incoming') {
    return { ok: false, message: 'Answer the incoming call before pressing a screening digit.' };
  }
  if (action === 'answer' && miniCallState.phase !== 'incoming') {
    return { ok: false, message: 'The call is no longer at the initial answer step.' };
  }

  if (action === 'tone-1' || action === 'tone-2') {
    // The pointer must reach Google's real, authenticated in-call keypad.
    // Track every attempt in main, not only the last one reported by the page.
    const sequence = ++miniCallDeliverySequence;
    const startedAt = Date.now();
    const initial = miniCallWindowFlags();
    let transport = 'not-invoked';
    miniCallRenderTrace('tone-start', `request=${sequence} digit=${action.slice(-1)} ${initial}`);
    try {
      const result = await withRenderedCallWindow({
        window: win,
        displays: screen.getAllDisplays(),
        platform: process.platform,
        trace: miniCallRenderTrace,
        onParkingChanged: (parking) => { miniCallParkingActive = parking; },
        action: ({ mode }) => {
          transport = mode;
          miniCallRenderTrace('tone-dispatch', `request=${sequence} mode=${mode} ${miniCallWindowFlags()}`);
          return miniCallForwardAction(action, mode);
        },
      });
      miniCallSaveDeliveryAttempt({ sequence, digit: action.slice(-1), initial,
        transport, outcome: result?.ok ? 'dispatched-unconfirmed' : 'failed',
        elapsedMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      miniCallRenderTrace('transport-failed', `request=${sequence} mode=${transport}`);
      miniCallSaveDeliveryAttempt({ sequence, digit: action.slice(-1), initial,
        transport, outcome: 'transport-error', elapsedMs: Date.now() - startedAt });
      return { ok: false, message: `Could not activate Google's background keypad: ${String(error?.message || error).slice(0, 125)}` };
    }
  }

  const result = await miniCallForwardAction(action);
  if (action === 'copy-diagnostics' && result.ok && typeof result.diagnostics === 'string') {
    // Preserve a separate account of delivery attempts when the diagnostic
    // snapshot is captured after the main window has been shown again.
    const deliveryHistory = miniCallRenderTimeline.length
      ? miniCallRenderTimeline.join('\n') : 'No call-control transport events yet.';
    const attempts = miniCallDeliveryAttempts.length
      ? miniCallDeliveryAttempts.map((item) =>
        `request=${item.sequence} digit=${item.digit} start=${item.initial} mode=${item.transport} outcome=${item.outcome} elapsedMs=${item.elapsedMs}`).join('\n')
      : 'No 1/2 keypad actions received by Electron main yet.';
    // Put decisive evidence FIRST, so long DOM paths cannot truncate it away.
    const mainReport = `Voice Desktop main-process call delivery v12\ncurrentWindow=${miniCallWindowFlags()}\n` +
      `Recent 1/2 attempts (oldest first):\n${attempts}\n\n` +
      `Main-process window delivery timeline (newest last):\n${deliveryHistory}\n\n`;
    clipboard.writeText((mainReport + result.diagnostics).slice(0, 24500));
    return { ok: true, message: 'v12 delivery attempts and detailed diagnostics copied.' };
  }
  if (action === 'show-keypad' && !result.ok) {
    showMainWindow();
    return { ok: false, message: 'Opened Google Voice; use its native keypad.' };
  }
  return { ok: result.ok === true, message: String(result.message || '').slice(0, 220) };
});

/**
 * Dispatch a trusted mouse click to the real, previously identified Google Voice key.
 * Coordinates originate inside the sandboxed preload, never from the mini UI or page.
 * If Chrome debugging is in use, preload falls back to .click() without interrupting it.
 */
/**
 * Learn only the DOM structure of a REAL manually clicked Google Voice digit.
 * No contact identifiers, phone numbers, arbitrary selectors or page text are
 * passed across IPC or saved. A future call still revalidates the live target.
 */
function isSafeLearnedDigitRoute(hint) {
  return !!hint && ['1', '2'].includes(hint.digit) &&
    /^gv-(?:dialpad|keypad|in-call-keypad|in-call-dialpad|in-call|in-call-status|active-call|call-panel|call-dialog|call-widget|call-screen)$/.test(hint.rootTag) &&
    Array.isArray(hint.route) && hint.route.length > 0 && hint.route.length <= 25 &&
    hint.route.every((step) => step && Number.isInteger(step.index) &&
      step.index >= 0 && step.index <= 95 &&
      typeof step.tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(step.tag));
}

ipcMain.handle('mini-call-get-learned-digits', (event) => {
  if (!isMainWindowSender(event) || !isGoogleVoiceUrl(event.sender.getURL())) return {};
  const saved = store.get('prefs.miniCallLearnedDigits', {});
  if (!saved || typeof saved !== 'object') return {};
  return Object.fromEntries(['1', '2'].filter((digit) =>
    isSafeLearnedDigitRoute(saved[digit]) && saved[digit].digit === digit)
    .map((digit) => [digit, saved[digit]]));
});

ipcMain.on('mini-call-learned-native-digit', (event, hint) => {
  if (!isMainWindowSender(event) || !isGoogleVoiceUrl(event.sender.getURL()) ||
      !isSafeLearnedDigitRoute(hint)) return;
  const previous = store.get('prefs.miniCallLearnedDigits', {});
  store.set('prefs.miniCallLearnedDigits', {
    ...(previous && typeof previous === 'object' ? previous : {}),
    [hint.digit]: { digit: hint.digit, rootTag: hint.rootTag, route: hint.route },
  });
  if (miniCallWindow && !miniCallWindow.isDestroyed()) {
    miniCallWindow.webContents.send('mini-call-feedback', {
      ok: true, message: `Google Voice native ${hint.digit} key learned for future calls.`,
    });
  }
});

/**
 * Report whether Chromium's actual Voice window can receive compositor pointer
 * events. The tray/minimized window still runs its preload, but a CDP mouse
 * dispatch against an unpainted window can report success without a click.
 * Only coarse window-state flags are exposed; never expose native handles.
 */
ipcMain.handle('mini-call-input-context', (event) => {
  if (!isMainWindowSender(event) || !isGoogleVoiceUrl(event.sender.getURL()) ||
      !win || win.isDestroyed()) {
    return { interactive: false, reason: 'untrusted-or-closed' };
  }
  const minimized = win.isMinimized();
  const visible = win.isVisible();
  return {
    interactive: visible && !minimized,
    visible,
    minimized,
    focused: win.isFocused(),
  };
});

ipcMain.handle('mini-call-native-key-click', async (event, request) => {
  if (!isMainWindowSender(event) || !isGoogleVoiceUrl(event.sender.getURL())) {
    return { ok: false, message: 'Only the Google Voice renderer can request native key input.' };
  }
  if (!request || !['1', '2'].includes(request.digit) ||
    miniCallState.phase === 'idle' || miniCallState.phase === 'incoming') {
    return { ok: false, message: 'No answered call is available for keypad input.' };
  }
  const { x, y } = request;
  const bounds = win.webContents.getOwnerBrowserWindow()?.getContentBounds();
  if (!bounds || !Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
    return { ok: false, message: 'Key position is outside the Voice window.' };
  }
  // Chromium may silently discard mouse events for a minimized or tray-hidden window.
  // Let the Google Voice preload activate the same verified button in-page instead.
  if (!win.isVisible() || win.isMinimized()) {
    return { ok: false, reason: 'background-window', message: 'Native pointer unavailable while Google Voice is hidden.' };
  }
  const debuggerClient = win.webContents.debugger;
  if (!debuggerClient || debuggerClient.isAttached()) {
    return { ok: false, message: 'Chromium pointer input is unavailable.' };
  }
  let attached = false;
  try {
    debuggerClient.attach('1.3');
    attached = true;
    await debuggerClient.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await debuggerClient.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message || error).slice(0, 120) };
  } finally {
    if (attached && debuggerClient.isAttached()) {
      try { debuggerClient.detach(); } catch { /* Window may close during call teardown. */ }
    }
  }
});

ipcMain.on('mini-call-action-result', (event, result) => {
  if (!isMainWindowSender(event) || !Number.isInteger(result?.id)) return;
  const callback = miniCallPendingActions.get(result.id);
  if (!callback) return;
  miniCallPendingActions.delete(result.id);
  callback({ ok: result.ok === true, message: String(result.message || '').slice(0, 220),
    diagnostics: typeof result.diagnostics === 'string' ? result.diagnostics.slice(0, 20000) : undefined });
});

ipcMain.on('pref-change-mini-call-enabled', (event, enabled) => {
  if (!isSettingsWindowSender(event) || typeof enabled !== 'boolean') return;
  store.set('prefs.miniCallEnabled', enabled);
  if (!enabled && miniCallWindow && !miniCallWindow.isDestroyed()) miniCallWindow.hide();
  if (enabled && miniCallState.phase !== 'idle') void showMiniCallController();
  miniCallSyncControls();
});

// The mini controller is always on top while open. An older toggle is intentionally removed.

ipcMain.on('mini-call-preview', (event) => {
  if (!isSettingsWindowSender(event)) return;
  void showMiniCallController({ preview: true, manual: true });
});

// ====================================================================================================================
// GIF picker: isolated local UI, validated remote-media downloads, no unofficial Google Voice send API.
// ====================================================================================================================

/** Only the currently navigated Google Voice page may control its GIF launcher. */
function isVoiceGifSender(event) {
  return isMainWindowSender(event) && isGoogleVoiceUrl(event.sender.getURL());
}

/** Only the actual local picker window may request searches/favorites/attachments. */
function assertGifPickerSender(event) {
  if (!gifPickerWindow || gifPickerWindow.isDestroyed() || event.sender !== gifPickerWindow.webContents) {
    throw new Error("Rejected GIF request from an untrusted window.");
  }
}

/** Keep settings in a small, serializable subset for the trusted picker UI. */
function getGifPickerSettings() {
  return {
    apiKey: store.get("prefs.gifApiKey", ""),
    rating: store.get("prefs.gifRating", "pg"),
    favorites: normalizeSavedGifs(store.get("prefs.gifFavorites", [])),
    recent: normalizeSavedGifs(store.get("prefs.gifRecent", [])),
    theme: store.get("prefs.theme", "default"),
  };
}

/** Toggle the picker near the message composer without leaving the current conversation. */
ipcMain.on("gif-toggle-picker", (event, rect) => {
  if (!isVoiceGifSender(event) || store.get("prefs.gifEnabled", true) === false) return;
  if (gifPickerWindow && !gifPickerWindow.isDestroyed() && gifPickerWindow.isVisible()) {
    gifPickerWindow.hide();
    return;
  }
  void showGifPicker(rect);
});

/** Send the small launcher preference only; do not reveal the API key to Google Voice. */
ipcMain.handle("gif-is-enabled", (event) => {
  if (!isVoiceGifSender(event)) throw new Error("Untrusted GIF preference request.");
  return store.get("prefs.gifEnabled", true) !== false;
});

async function showGifPicker(rect) {
  if (!win || win.isDestroyed()) return;
  const width = 410;
  const height = 510;
  const content = win.getContentBounds();
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
  // The DOM rect is a suggestion, never trusted as a screen-sized position.
  const xInPage = Number.isFinite(rect?.x) ? Math.max(0, Math.min(content.width, rect.x)) : content.width - 70;
  const yInPage = Number.isFinite(rect?.y) ? Math.max(0, Math.min(content.height, rect.y)) : content.height - 60;
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, Math.round(content.x + xInPage - 15)));
  let y = content.y + yInPage - height - 10;
  if (y < workArea.y) y = content.y + yInPage + 38;
  y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, Math.round(y)));

  if (!gifPickerWindow || gifPickerWindow.isDestroyed()) {
    gifPickerWindow = new BrowserWindow({
      width, height, x, y,
      parent: win,
      frame: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: "#171923",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "gif-picker-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    gifPickerWindow.setMenu(null);
    gifPickerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    gifPickerWindow.webContents.on("will-navigate", (navigationEvent) => navigationEvent.preventDefault());
    gifPickerWindow.on("blur", () => {
      if (!gifPickerDialogOpen && !gifAttachmentInProgress && gifPickerWindow && !gifPickerWindow.isDestroyed()) gifPickerWindow.hide();
    });
    gifPickerWindow.on("closed", () => { gifPickerWindow = null; });
    await gifPickerWindow.loadFile(path.join(__dirname, "pages", "gif-picker.html"));
  } else {
    gifPickerWindow.setBounds({ x, y, width, height });
    // Reload to refresh key, favorites and trending results each time it opens.
    await gifPickerWindow.reload();
  }
  if (gifPickerWindow && !gifPickerWindow.isDestroyed()) gifPickerWindow.show();
}

ipcMain.handle("gif-picker-settings", (event) => {
  assertGifPickerSender(event);
  return getGifPickerSettings();
});

ipcMain.on("gif-picker-close", (event) => {
  assertGifPickerSender(event);
  gifPickerWindow.hide();
});

ipcMain.on("gif-picker-open-giphy", (event) => {
  assertGifPickerSender(event);
  openExternalSafe("https://giphy.com/");
});

ipcMain.handle("gif-save-favorite", (event, rawGif) => {
  assertGifPickerSender(event);
  const gif = normalizeGif(rawGif);
  if (!gif) throw new Error("Invalid GIPHY result.");
  const items = normalizeSavedGifs(store.get("prefs.gifFavorites", []));
  const next = [gif, ...items.filter((item) => item.id !== gif.id)].slice(0, 50);
  store.set("prefs.gifFavorites", next);
  return next;
});

ipcMain.handle("gif-remove-favorite", (event, id) => {
  assertGifPickerSender(event);
  if (typeof id !== "string") throw new Error("Invalid GIF identifier.");
  const next = normalizeSavedGifs(store.get("prefs.gifFavorites", []))
    .filter((item) => item.id !== id);
  store.set("prefs.gifFavorites", next);
  return next;
});

/**
 * Wait for the isolated Google Voice preload to dispatch the GIF to the normal attachment widget.
 * The preload reports that dispatch occurred, NOT that Google Voice uploaded or delivered the MMS.
 */
function requestVoiceGifAttachment(file) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || !isGoogleVoiceUrl(win.webContents.getURL())) {
      resolve({ ok: false, error: "Open a Google Voice conversation first." });
      return;
    }
    const id = ++nextGifAttachmentId;
    const timer = setTimeout(() => {
      pendingGifAttachments.delete(id);
      resolve({ ok: false, error: "Google Voice did not respond to the attachment request." });
    }, 8000);
    pendingGifAttachments.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    win.webContents.send("gif-attach-request", {
      id,
      filename: file.filename,
      // Uint8Array is supported by Electron's structured-clone IPC serialization.
      bytes: Uint8Array.from(file.bytes),
    });
  });
}

ipcMain.on("gif-attach-result", (event, result) => {
  if (!isVoiceGifSender(event) || !Number.isInteger(result?.id)) return;
  const resolve = pendingGifAttachments.get(result.id);
  if (!resolve) return;
  pendingGifAttachments.delete(result.id);
  resolve({
    ok: result.ok === true,
    error: typeof result.error === "string" ? result.error.slice(0, 300) : undefined,
  });
});

/** Only valid and under-limit GIF bytes are transferred to Google Voice. Never auto-send. */
ipcMain.handle("gif-select", async (event, rawGif) => {
  assertGifPickerSender(event);
  if (gifAttachmentInProgress) return { ok: false, error: "Another GIF is being prepared." };
  gifAttachmentInProgress = true;
  try {
    const file = await downloadGif(rawGif);
    const result = await requestVoiceGifAttachment(file);
    if (result.ok) {
      const items = normalizeSavedGifs(store.get("prefs.gifRecent", []));
      store.set("prefs.gifRecent", [file.gif, ...items.filter((item) => item.id !== file.gif.id)].slice(0, 24));
    }
    return result;
  } catch (error) {
    return { ok: false, error: error?.message || "Could not download GIF." };
  } finally {
    gifAttachmentInProgress = false;
  }
});

/** Fallback when Google changes the attachment DOM: save a GIF for manual use. */
ipcMain.handle("gif-save-file", async (event, rawGif) => {
  assertGifPickerSender(event);
  try {
    const file = await downloadGif(rawGif);
    gifPickerDialogOpen = true;
    let result;
    try {
      result = await dialog.showSaveDialog(gifPickerWindow, {
        defaultPath: path.join(app.getPath("downloads"), file.filename),
        filters: [{ name: "Animated GIF", extensions: ["gif"] }],
      });
    } finally {
      gifPickerDialogOpen = false;
    }
    if (result.canceled || !result.filePath) return { ok: false, error: "Save canceled." };
    await fs.promises.writeFile(result.filePath, file.bytes);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not save GIF." };
  }
});

// GIF controls in Settings can update the launcher without a Google Voice reload.
ipcMain.on("pref-change-gif-enabled", (event, enabled) => {
  if (!isSettingsWindowSender(event) || typeof enabled !== "boolean") return;
  store.set("prefs.gifEnabled", enabled);
  if (!enabled && gifPickerWindow && !gifPickerWindow.isDestroyed()) gifPickerWindow.hide();
  if (win && !win.isDestroyed() && isGoogleVoiceUrl(win.webContents.getURL())) {
    win.webContents.send("gif-enabled-changed", enabled);
  }
});

ipcMain.on("pref-change-gif-key", (event, key) => {
  if (!isSettingsWindowSender(event) || typeof key !== "string") return;
  const candidate = key.trim();
  if (candidate.length > 150 || (candidate && !/^[a-zA-Z0-9_-]+$/.test(candidate))) return;
  store.set("prefs.gifApiKey", candidate);
});

ipcMain.on("pref-change-gif-rating", (event, rating) => {
  if (!isSettingsWindowSender(event) || !["g", "pg", "pg-13", "r"].includes(rating)) return;
  store.set("prefs.gifRating", rating);
});
