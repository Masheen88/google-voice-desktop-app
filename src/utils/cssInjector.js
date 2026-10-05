const fs = require("node:fs");
const path = require("node:path");

const BASE = "base.scss";
const MAPPINGS = "mappings.scss";
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
        // Navigations can invalidate old style keys. There is nothing else to clean up in that case.
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
   * Injects one of the local application themes.
   *
   * Development compiles SCSS on demand so theme edits remain easy to test.
   * Packaged builds load precompiled CSS so Sass and its dependency tree are not
   * shipped inside the application.
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
        // The page may have navigated since the key was created. Old inserted CSS is already gone in that case.
      }
    }

    if (theme === "default" || requestId !== this.themeRequestId) {
      return;
    }

    // Only allow simple local theme names. The main process validates against SUPPORTED_THEMES too,
    // but keeping validation here protects this utility if it is reused elsewhere later.
    if (!/^[a-z0-9_-]+$/i.test(theme)) {
      console.error(`Rejected invalid theme name: ${theme}`);
      return;
    }

    try {
      const styles = this.app.isPackaged
        ? loadCompiledTheme(this.app, theme)
        : compileDevelopmentTheme(this.app, theme);

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
      console.error(`Could not find or load theme ${theme}`);
    }
  }
};

function loadCompiledTheme(app, theme) {
  const themesDir = path.join(app.getAppPath(), "src", "themes-compiled");
  const themePath = resolveThemePath(themesDir, theme, ".css");
  return fs.readFileSync(themePath, "utf8");
}

function compileDevelopmentTheme(app, theme) {
  // Sass is deliberately a devDependency. This lazy require is never executed
  // in packaged builds, which keeps Sass out of the shipped node_modules tree.
  const sass = require("sass");
  const themesDir = path.join(app.getAppPath(), "src", "themes");
  const themePath = resolveThemePath(themesDir, theme, ".scss");
  const file = fs.readFileSync(themePath, "utf8");
  const data = joinImports(app, file);

  const result = sass.compileString(data, {
    loadPaths: [themesDir],
    style: "expanded",
  });

  return forceImportant(result.css);
}

function resolveThemePath(themesDir, theme, extension) {
  const themePath = path.join(themesDir, `${theme}${extension}`);
  const resolvedThemesDir = path.resolve(themesDir);
  const resolvedThemePath = path.resolve(themePath);

  if (!resolvedThemePath.startsWith(`${resolvedThemesDir}${path.sep}`)) {
    throw new Error(`Resolved theme path escaped themes directory: ${theme}`);
  }

  return resolvedThemePath;
}

function forceImportant(css) {
  // Preserve the project's historical behavior of forcing injected theme declarations to win
  // against Google Voice's own styles. Theme files can still use explicit !important rules too.
  return css.replace(/(?<!!important);/g, " !important;");
}

/**
 * The theme files intentionally share variables and placeholder selectors across
 * base.scss and mappings.scss. Recombine them into one Sass source string before
 * compilation so the old global-variable behavior remains intact.
 */
function joinImports(app, file) {
  const themesDir = path.join(app.getAppPath(), "src", "themes");
  const base = fs.readFileSync(path.join(themesDir, BASE), "utf8");
  const mappings = fs.readFileSync(path.join(themesDir, MAPPINGS), "utf8");

  let contents = file;

  contents = contents.replaceAll(
    /@(?:use|import)\s+["']base(?:\.scss)?["']\s*;?/g,
    base,
  );

  contents = contents.replaceAll(
    /@(?:use|import)\s+["']mappings(?:\.scss)?["']\s*;?/g,
    mappings,
  );

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
