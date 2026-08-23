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
} = require("electron");
const constants = require("./constants");
const AutoLaunch = require("auto-launch");

const contextMenuModule = require("electron-context-menu");
// electron-context-menu is ESM-exported now, so grab default if present.
const contextMenu = contextMenuModule.default ?? contextMenuModule;

const BadgeGenerator = require("./badge_generator");
const path = require("node:path");
const CSSInjector = require("./utils/cssInjector");

const StoreModule = require("electron-store");
const Store = StoreModule.default ?? StoreModule;

const { pathToFileURL } = require("node:url");
const { autoUpdater } = require("electron-updater");

// Constants
const store = new Store();
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

app.whenReady().then(async () => {
  // If the computer is shutting down or restarting then close
  powerMonitor.on("shutdown", () => {
    exitApplication();
  });

  // Setup context menu.  Inspect Element is useful during development but should not be
  // exposed in packaged builds that display remote Google Voice content.
  contextMenu({
    showSaveImage: true,
    showInspectElement: !app.isPackaged,
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

  app.dock && app.dock.setIcon(dockIcon);

  createWindow();

  // electron-builder generates the update metadata consumed by electron-updater.
  // Draft GitHub releases are ignored until they are actually published, which fits
  // the current build.publish.releaseType configuration.
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.error("Automatic update check failed:", error);
    });
  }
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
    },
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
            loadGoogleVoice(true);
          },
        }, // Open Google Voice externally in the user's browser
        { type: "separator" },
        {
          label: "&Settings",
          click: () => {
            showSettingsWindow();
          },
        }, // Open/display our Settings window
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

  badgeGenerator = new BadgeGenerator(win);
  cssInjector = new CSSInjector(app, win);

  // Navigate the window to Google Voice.  When it finishes loading, modify Google's markup as needed
  // to support user customizations that we allow the user to make from within our application UI.
  loadGoogleVoice();
  win.webContents.on("did-finish-load", () => {
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
    win.show();
  });

  win.on("resize", saveWindowSize);

  win.on("closed", () => {
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

// Loads Google Voice.  The "loadExternal" parameter specifies whether the load should
// take place inside this application's main browser window.  If set to false, Google
// Voice will be opened in the user's default external browser instead.  During the
// load, Google Voice itself takes care of asking the user to log in when necessary.
function loadGoogleVoice(loadExternal = false) {
  if (loadExternal) {
    openExternalSafe(constants.URL_GOOGLE_VOICE);
  } else if (win && !win.isDestroyed()) {
    win.loadURL(constants.URL_GOOGLE_VOICE).catch((error) => {
      console.error("Unable to load Google Voice:", error);
    });
  }
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
      tray && tray.setImage(iconTrayDirty);
    } else {
      tray && tray.setImage(iconTray);
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

  // Construct the icon's context menu.  This is done using an array of MenuItem objects.
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
          showSettingsWindow();
        },
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
function showSettingsWindow() {
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

    // Settings are exposed through a narrow preload/contextBridge API instead of attaching
    // privileged objects directly to the renderer window.

    // Load our settings page into the window.
    settingsWindow.loadFile(
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
  // so electron-store is not updated on every individual resize event.
  clearTimeout(saveWindowSizeTimer);

  saveWindowSizeTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;

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
    console.warn(`Blocked invalid external URL: ${value}`);
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

  const autoLaunch = new AutoLaunch({
    name: constants.APPLICATION_NAME,
    path: app.getPath("exe"),
  });

  try {
    return await autoLaunch.isEnabled();
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
    const autoLaunch = new AutoLaunch({
      name: constants.APPLICATION_NAME,
      path: app.getPath("exe"),
    });

    try {
      if (startAutomatically) {
        await autoLaunch.enable();
      } else {
        await autoLaunch.disable();
      }
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
