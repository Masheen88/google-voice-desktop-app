void (async function () {
  // Settings are exposed by settings-preload.js through a narrow contextBridge API.
  // The renderer intentionally does not have direct access to Node.js or ipcRenderer.
  const settingsApi = window.voiceDesktopSettings;

  if (!settingsApi) {
    throw new Error("Voice Desktop settings API is unavailable.");
  }

  // =====================================================================
  // Theme Helpers
  // =====================================================================
  /**
   * Applies the selected theme to the Settings window by setting a data-theme
   * attribute on <html>. customize.css uses this to swap CSS variables.
   */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme || "default";
  }

  /**
   * Converts Electron's logarithmic zoom level to the percentage users expect to see.
   * Electron uses a 1.2 scale factor between integer zoom levels.
   */
  function zoomLevelToPercent(zoomLevel) {
    const numericZoomLevel = Number(zoomLevel) || 0;
    return Math.round(Math.pow(1.2, numericZoomLevel) * 100);
  }

  /**
   * Keeps the visible zoom percentage synchronized with the range slider.
   */
  function updateZoomValue(zoomLevel) {
    zoomValue.textContent = `${zoomLevelToPercent(zoomLevel)}%`;
  }

  // Allow the user to hit the Escape key to close the window.
  window.addEventListener(
    "keyup",
    (event) => {
      if (event.code === "Escape") {
        window.close();
      }
    },
    true,
  );

  // Retrieve the user's settings store from the main process.
  const prefs = await settingsApi.getUserPrefs();

  // Populate the "theme" dropdown with the user's currently selected theme.
  // Notify the main process whenever the user selects a different theme.
  const themePicker = document.getElementById("theme");
  themePicker.value = prefs.theme || "default";

  // Apply initial theme to this Settings page.
  applyTheme(themePicker.value);

  themePicker.addEventListener("change", (event) => {
    const theme = event.target.value;

    // Live update the Settings page theme immediately.
    applyTheme(theme);

    // Keep existing behavior for the main window.
    settingsApi.setTheme(theme);
  });

  // Set the "zoom" slider to the main window's current zoom level.
  // Notify the main process whenever the user selects a new level.
  const zoomSlider = document.getElementById("zoom");
  const zoomValue = document.getElementById("zoom-value");
  zoomSlider.value = await settingsApi.getZoomLevel();
  updateZoomValue(zoomSlider.value);

  zoomSlider.addEventListener("input", (event) => {
    const zoomLevel = event.target.value;
    updateZoomValue(zoomLevel);
  });

  zoomSlider.addEventListener("change", (event) => {
    const zoomLevel = event.target.value;
    settingsApi.setZoom(zoomLevel);
  });

  // Whenever the user clicks the "reset zoom" button, set the "zoom"
  // slider back to 0 and notify the main process of this new value.
  const zoomResetButton = document.getElementById("reset-zoom");
  zoomResetButton.addEventListener("click", () => {
    zoomSlider.value = 0;
    updateZoomValue(0);
    settingsApi.setZoom(0);
  });

  // Set the "show menu bar" checkbox based on the user's currently selected preference.
  // Notify the main process whenever the user changes their preference.  If we're running
  // on Mac, just hide this setting instead since we don't support it for that platform.
  const menubarSettingDiv = document.getElementById("show-menubar-div");
  const isMac = (await settingsApi.getPlatform()) === "darwin";
  if (isMac) {
    menubarSettingDiv.remove();
  } else {
    const menubarSetting = document.getElementById("show-menubar");
    menubarSetting.checked =
      prefs.showMenuBar != undefined ? prefs.showMenuBar : true;
    menubarSetting.addEventListener("change", (event) => {
      const checked = event.target.checked;
      settingsApi.setShowMenuBar(checked);
    });
  }

  // Set the "start automatically" checkbox based on the user's currently selected
  // preference.  Notify the main process whenever the preference changes.
  const startAutomatically = document.getElementById("start-automatically");
  startAutomatically.checked = await settingsApi.getStartAutomatically();
  startAutomatically.addEventListener("change", (event) => {
    const checked = event.target.checked;
    settingsApi.setStartAutomatically(checked);
  });

  // Set the "start minimized" checkbox based on the user's currently selected
  // startup mode.  Notify the main process whenever the user changes the mode.
  const minimizedSetting = document.getElementById("start-minimized");
  minimizedSetting.checked =
    prefs.startMinimized != undefined ? prefs.startMinimized : false;
  minimizedSetting.addEventListener("change", (event) => {
    const checked = event.target.checked;
    settingsApi.setStartMinimized(checked);
  });

  // Set the "exit on close" checkbox based on the user's currently selected
  // preference.  Notify the main process whenever the preference changes.
  const exitOnCloseSetting = document.getElementById("exit-on-close");
  exitOnCloseSetting.checked =
    prefs.exitOnClose != undefined ? prefs.exitOnClose : false;
  exitOnCloseSetting.addEventListener("change", (event) => {
    const checked = event.target.checked;
    settingsApi.setExitOnClose(checked);
  });

  // Set the "hide dialer sidebar" checkbox based on the user's currently selected
  // preference.  Notify the main process whenever the preference changes.
  const hideDialerSidebar = document.getElementById("hide-dialer-sidebar");
  hideDialerSidebar.checked =
    prefs.hideDialerSidebar != undefined ? prefs.hideDialerSidebar : false;
  hideDialerSidebar.addEventListener("change", (event) => {
    const checked = event.target.checked;
    settingsApi.setHideDialerSidebar(checked);
  });

  // Optional floating call widget. Preview disables telecom actions (no test calls are placed).
  const miniCallEnabled = document.getElementById('mini-call-enabled');
  miniCallEnabled.checked = prefs.miniCallEnabled !== false;
  miniCallEnabled.addEventListener('change', () => settingsApi.setMiniCallEnabled(miniCallEnabled.checked));
  const miniCallTop = document.getElementById('mini-call-always-top');
  miniCallTop.checked = prefs.miniCallAlwaysOnTop !== false;
  miniCallTop.addEventListener('change', () => settingsApi.setMiniCallAlwaysOnTop(miniCallTop.checked));
  document.getElementById('mini-call-preview').addEventListener('click', () => settingsApi.previewMiniCall());

  // GIF settings are saved separately so typing a key never sends it to Google Voice.
  const gifEnabled = document.getElementById("gif-enabled");
  gifEnabled.checked = prefs.gifEnabled !== false;
  gifEnabled.addEventListener("change", () => settingsApi.setGifEnabled(gifEnabled.checked));

  const gifKey = document.getElementById("gif-key");
  const gifKeyStatus = document.getElementById("gif-key-status");
  gifKey.value = prefs.gifApiKey || "";
  const gifSave = document.getElementById("gif-key-save");
  gifSave.addEventListener("click", () => {
    const value = gifKey.value.trim();
    if (value.length > 150 || (value && !/^[a-zA-Z0-9_-]+$/.test(value))) {
      gifKeyStatus.textContent = "Invalid key. Check the key copied from GIPHY.";
      return;
    }
    settingsApi.setGifApiKey(value);
    gifKeyStatus.textContent = value ? "GIPHY API key saved locally." : "GIPHY API key removed.";
  });

  const gifRating = document.getElementById("gif-rating");
  gifRating.value = ["g", "pg", "pg-13", "r"].includes(prefs.gifRating) ? prefs.gifRating : "pg";
  gifRating.addEventListener("change", () => settingsApi.setGifRating(gifRating.value));

  // Close the window if the user clicks the "Close" button.
  const closeButton = document.getElementById("close-button");
  closeButton.addEventListener("click", () => {
    window.close();
  });
})();
