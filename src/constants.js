/**********************************************************************************************************************
 * This module contains constants that are meant to be used throughout the entire application.
 **********************************************************************************************************************/

// Strings
const APPLICATION_NAME = "Voice Desktop";

// Windows application identity. Keep this identical to build.appId.
const APPLICATION_ID = "com.jerrkawz.voiceDesktop";

// Images
const APPLICATION_ICON_LARGE = "1024px-Google_Voice_icon_(2020).png";
const APPLICATION_ICON_MEDIUM = "64px-Google_Voice_icon_(2020).png";
const APPLICATION_ICON_SMALL = "tray-Google_Voice_icon_(2020).png";
const APPLICATION_ICON_SMALL_WITH_INDICATOR =
  "tray-dirty-Google_Voice_icon_(2020).png";

// URLs
const URL_GOOGLE_VOICE = "https://voice.google.com";

// Keep GitHub links aligned with package.json's current repository instead of the original upstream repository.
const URL_GITHUB_REPOSITORY =
  "https://github.com/Masheen88/google-voice-desktop-app";
const URL_GITHUB_README = `${URL_GITHUB_REPOSITORY}/blob/master/README.md`;
const URL_GITHUB_SECURITY_POLICY = `${URL_GITHUB_REPOSITORY}/blob/master/SECURITY.md`;
const URL_GITHUB_VIEW_ISSUES = `${URL_GITHUB_REPOSITORY}/issues`;
const URL_GITHUB_REPORT_BUG = `${URL_GITHUB_REPOSITORY}/issues/new?labels=bug`;
const URL_GITHUB_FEATURE_REQUEST = `${URL_GITHUB_REPOSITORY}/issues/new?labels=enhancement`;
const URL_GITHUB_ASK_QUESTION = `${URL_GITHUB_REPOSITORY}/issues/new?labels=question`;
const URL_GITHUB_RELEASES = `${URL_GITHUB_REPOSITORY}/releases`;

// Remote origins intentionally allowed to stay inside the Electron BrowserWindow.
const GOOGLE_VOICE_HOSTNAME = "voice.google.com";
const GOOGLE_ACCOUNTS_HOSTNAME = "accounts.google.com";

// Default Settings
const DEFAULT_SETTING_SHOW_MENU_BAR = true;
const DEFAULT_SETTING_THEME = "default";
const DEFAULT_SETTING_START_MINIMIZED = false;
const DEFAULT_SETTING_EXIT_ON_CLOSE = false;
const DEFAULT_HIDE_DIALER_SIDEBAR = false;

// Supported themes.  Keep this list synchronized with the options in pages/customize.html.
const SUPPORTED_THEMES = [
  "default",
  "dracula",
  "solar",
  "minty",
  "cerulean",
  "darkplus",
];

module.exports = {
  // Strings
  APPLICATION_NAME, // Application name (displayed in various places)
  APPLICATION_ID, // Windows application identity. Keep this identical to build.appId.

  // Images
  APPLICATION_ICON_LARGE, // Main application icon (large)  --sufficient size for MacOS Doc
  APPLICATION_ICON_MEDIUM, // Main application icon (medium) --sufficient size for Windows Taskbar
  APPLICATION_ICON_SMALL, // Main application icon (small)  --sufficient size for system notification area
  APPLICATION_ICON_SMALL_WITH_INDICATOR, // Main application icon (small, with "notifications" indicator)

  // URLs
  URL_GOOGLE_VOICE, // Google Voice homepage
  URL_GITHUB_REPOSITORY, // Current Voice Desktop GitHub repository
  URL_GITHUB_README, // The "README.md" file on GitHub
  URL_GITHUB_SECURITY_POLICY, // The "SECURITY.md" file on GitHub
  URL_GITHUB_VIEW_ISSUES, // List of currently logged issues on GitHub
  URL_GITHUB_REPORT_BUG, // Link to open a new bug on GitHub
  URL_GITHUB_FEATURE_REQUEST, // Link to request a feature on GitHub
  URL_GITHUB_ASK_QUESTION, // Link to ask a question on GitHub
  URL_GITHUB_RELEASES, // Link to published releases on GitHub

  // Remote origins
  GOOGLE_VOICE_HOSTNAME, // Google Voice application origin
  GOOGLE_ACCOUNTS_HOSTNAME, // Google Accounts login origin

  // Default Settings
  DEFAULT_SETTING_SHOW_MENU_BAR, // Whether the MenuBar of the main application window should be visible
  DEFAULT_SETTING_THEME, // Default theme to apply
  DEFAULT_SETTING_START_MINIMIZED, // Whether the application should start minimized to the system notification area
  DEFAULT_SETTING_EXIT_ON_CLOSE, // Whether the application should terminate when the user closes the main application window
  DEFAULT_HIDE_DIALER_SIDEBAR, // Whether the dialer sidebar should be hidden or not

  // Theme metadata
  SUPPORTED_THEMES, // Themes accepted by Settings IPC and exposed in the Settings UI
};
