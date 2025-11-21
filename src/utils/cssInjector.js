const sass = require("sass");
const fs = require("fs");
const path = require("path");

const BASE = `base.scss`;
const MAPPINGS = `mappings.scss`;
const HIDE_DIALER_SIDEBAR_CSS = `gv-call-sidebar { display: none }`;

module.exports = class Injector {
  constructor(app, win) {
    this.win = win;
    this.app = app;
  }

  showHideDialerSidebar(hide) {
    if (!this.win) return;

    if (hide) {
      this.win.webContents.insertCSS(HIDE_DIALER_SIDEBAR_CSS).then((key) => {
        this.sidebarStyleKey = key;
      });
    } else {
      if (this.sidebarStyleKey) {
        this.win.webContents.removeInsertedCSS(this.sidebarStyleKey);
      }
    }
  }

  injectTheme(theme) {
    if (this.styleKey) {
      this.win.webContents.removeInsertedCSS(this.styleKey);
      this.styleKey = null;
    }

    if (theme !== "default") {
      try {
        const themesDir = path.join(this.app.getAppPath(), "src", "themes");

        const file = fs.readFileSync(
          path.join(themesDir, `${theme}.scss`),
          "utf-8"
        );

        // Inline base + mappings so Sass sees one combined file (preserves old @import behavior)
        const data = joinImports(this.app, file);

        // ✅ includePaths lets Sass resolve any leftover @imports safely
        const result = sass.renderSync({
          data,
          includePaths: [themesDir],
        });

        const styles = result.css.toString().replace(/;/g, " !important;");
        if (this.win) {
          this.win.webContents.insertCSS(styles).then((key) => {
            this.styleKey = key;
          });
        }
      } catch (e) {
        console.log(e);
        console.error(`Could not find theme ${theme}`);
      }
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
    base
  );

  // Replace mappings directives anywhere (including those inside base)
  contents = contents.replaceAll(
    /@(?:use|import)\s+["']mappings(?:\.scss)?["']\s*;?/g,
    mappings
  );

  // ✅ Strip any leftover base/mappings imports that may exist inside inserted files
  contents = contents.replaceAll(
    /@(?:use|import)\s+["']base(?:\.scss)?["']\s*;?/g,
    ""
  );
  contents = contents.replaceAll(
    /@(?:use|import)\s+["']mappings(?:\.scss)?["']\s*;?/g,
    ""
  );

  return contents;
}
