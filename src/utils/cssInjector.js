const sass = require("sass");
const fs = require("fs");
const path = require("path");

const BASE = `base.scss`;
const MAPPINGS = `mappings.scss`;
const HIDE_DIALER_SIDEBAR_CSS = `gv-call-sidebar { display: none !important; }`;

module.exports = class Injector {
  constructor(app, win) {
    this.win = win;
    this.app = app;

    // Keep track of the CSS keys returned by Electron so previous injected styles can be removed cleanly.
    this.styleKey = null;
    this.sidebarStyleKey = null;

    // Request counters prevent an older asynchronous insertCSS() call from winning after a newer setting change.
    this.themeRequestId = 0;
    this.sidebarRequestId = 0;
  }

  /**
   * Shows or hides Google Voice's dialer sidebar.
   *
   * The previous implementation could race if the checkbox was toggled quickly because insertCSS() is asynchronous.
   * This version always removes the previous style first and discards stale insert results.
   */
  async showHideDialerSidebar(hide) {
    if (!this.win || this.win.isDestroyed()) return;

    const requestId = ++this.sidebarRequestId;

    if (this.sidebarStyleKey) {
      const existingKey = this.sidebarStyleKey;
      this.sidebarStyleKey = null;

      try {
        await this.win.webContents.removeInsertedCSS(existingKey);
      } catch (error) {
        // Navigations can invalidate old style keys.  There is nothing else to clean up in that case.
      }
    }

    if (!hide || requestId !== this.sidebarRequestId) {
      return;
    }

    try {
      const key = await this.win.webContents.insertCSS(HIDE_DIALER_SIDEBAR_CSS);

      if (requestId === this.sidebarRequestId) {
        this.sidebarStyleKey = key;
      } else {
        // A newer request arrived while this CSS was being inserted, so remove the now-stale style.
        await this.win.webContents.removeInsertedCSS(key).catch(() => {});
      }
    } catch (error) {
      console.error("Could not update dialer sidebar CSS:", error);
    }
  }

  /**
   * Compiles and injects one of the local application themes.
   *
   * @param {string} theme
   */
  async injectTheme(theme) {
    if (!this.win || this.win.isDestroyed()) return;

    const requestId = ++this.themeRequestId;

    if (this.styleKey) {
      const existingKey = this.styleKey;
      this.styleKey = null;

      try {
        await this.win.webContents.removeInsertedCSS(existingKey);
      } catch (error) {
        // The page may have navigated since the key was created.  Old inserted CSS is already gone in that case.
      }
    }

    if (theme === "default" || requestId !== this.themeRequestId) {
      return;
    }

    // Only allow simple local theme names.  The main process validates against SUPPORTED_THEMES too,
    // but keeping validation here protects this utility if it is reused elsewhere later.
    if (!/^[a-z0-9_-]+$/i.test(theme)) {
      console.error(`Rejected invalid theme name: ${theme}`);
      return;
    }

    try {
      const themesDir = path.join(this.app.getAppPath(), "src", "themes");
      const themePath = path.join(themesDir, `${theme}.scss`);

      // Resolve the path and verify it is still inside the themes directory before reading from disk.
      const resolvedThemesDir = path.resolve(themesDir);
      const resolvedThemePath = path.resolve(themePath);
      if (!resolvedThemePath.startsWith(`${resolvedThemesDir}${path.sep}`)) {
        throw new Error(
          `Resolved theme path escaped themes directory: ${theme}`,
        );
      }

      const file = fs.readFileSync(resolvedThemePath, "utf-8");

      // Inline base + mappings so Sass sees one combined file (preserves old @import behavior)
      const data = joinImports(this.app, file);

      // Use Sass's modern compileString API instead of the deprecated legacy renderSync API.
      // loadPaths lets Sass resolve any leftover imports safely.
      const result = sass.compileString(data, {
        loadPaths: [themesDir],
        style: "expanded",
      });

      // Preserve the project's historical behavior of forcing injected theme declarations to win
      // against Google Voice's own styles.  Theme files can still use explicit !important rules too.
      const styles = result.css.replace(/;/g, " !important;");

      if (
        !this.win ||
        this.win.isDestroyed() ||
        requestId !== this.themeRequestId
      ) {
        return;
      }

      const key = await this.win.webContents.insertCSS(styles);

      if (requestId === this.themeRequestId) {
        this.styleKey = key;
      } else {
        // The user selected another theme before this insert completed.
        await this.win.webContents.removeInsertedCSS(key).catch(() => {});
      }
    } catch (error) {
      console.error(error);
      console.error(`Could not find or compile theme ${theme}`);
    }
  }
};

/**
 * The way sass processes use/import functions just isn't good enough for this project:
 *  - We need variables that scope across files
 *  - We want to split selectors and placeholder selectors into different files
 *
 * So we recombine multiple files into one string and then let Sass process that.
 */
function joinImports(app, file) {
  const themesDir = path.join(app.getAppPath(), "src", "themes");
  const base = fs.readFileSync(path.join(themesDir, BASE), "utf-8");
  const mappings = fs.readFileSync(path.join(themesDir, MAPPINGS), "utf-8");

  let contents = file;

  // Replace either @base or @import of base (single/double quotes, optional .scss, optional semicolon)
  contents = contents.replaceAll(
    /@(?:use|import)\s+["']base(?:\.scss)?["']\s*;?/g,
    base,
  );

  // Replace mappings directives anywhere (including those inside base)
  contents = contents.replaceAll(
    /@(?:use|import)\s+["']mappings(?:\.scss)?["']\s*;?/g,
    mappings,
  );

  // Strip any leftover base/mappings imports that may exist inside inserted files
  contents = contents.replaceAll(
    /@(?:use|import)\s+["']base(?:\.scss)?["']\s*;?/g,
    "",
  );

  contents = contents.replaceAll(
    /@(?:use|import)\s+["']mappings(?:\.scss)?["']\s*;?/g,
    "",
  );

  return contents;
}
