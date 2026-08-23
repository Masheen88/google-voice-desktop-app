//settings-preload.js

/**********************************************************************************************************************
 * Preload script for the local Settings window.
 *
 * The Settings renderer intentionally has no direct Node.js or ipcRenderer access.  Only the exact settings operations
 * required by customize.js are exposed through contextBridge.  The main process also validates the sender and values.
 **********************************************************************************************************************/

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceDesktopSettings", {
  // Read-only settings APIs.
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  getUserPrefs: () => ipcRenderer.invoke("get-user-prefs"),
  getStartAutomatically: () => ipcRenderer.invoke("get-start-automatically"),
  getZoomLevel: () => ipcRenderer.invoke("get-zoom-level"),

  // Narrow write APIs.  Do not expose ipcRenderer itself to the renderer.
  setTheme: (theme) => ipcRenderer.send("pref-change-theme", theme),
  setZoom: (zoomLevel) => ipcRenderer.send("pref-change-zoom", zoomLevel),
  setShowMenuBar: (showMenuBar) =>
    ipcRenderer.send("pref-change-show-menubar", showMenuBar),
  setStartAutomatically: (startAutomatically) =>
    ipcRenderer.send("pref-change-start-automatically", startAutomatically),
  setStartMinimized: (startMinimized) =>
    ipcRenderer.send("pref-change-start-minimized", startMinimized),
  setExitOnClose: (exitOnClose) =>
    ipcRenderer.send("pref-change-exit-on-close", exitOnClose),
  setHideDialerSidebar: (hideDialerSidebar) =>
    ipcRenderer.send("pref-change-hide-dialer-sidebar", hideDialerSidebar),
});
