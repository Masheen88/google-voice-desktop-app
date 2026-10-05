const { Menu } = require("electron");

function addSeparator(template) {
  if (template.length > 0 && template.at(-1)?.type !== "separator") {
    template.push({ type: "separator" });
  }
}

/**
 * Adds the small subset of context-menu behavior this app actually uses.
 * Keeping it local avoids shipping electron-context-menu and its transitive
 * dependencies in every packaged build.
 */
function configureContextMenu(browserWindow, options = {}) {
  const { allowInspect = false, allowSaveImage = true } = options;
  const webContents = browserWindow.webContents;

  webContents.on("context-menu", (_event, params) => {
    const template = [];
    const editFlags = params.editFlags || {};

    if (params.isEditable) {
      template.push(
        { role: "undo", enabled: Boolean(editFlags.canUndo) },
        { role: "redo", enabled: Boolean(editFlags.canRedo) },
        { type: "separator" },
        { role: "cut", enabled: Boolean(editFlags.canCut) },
        { role: "copy", enabled: Boolean(editFlags.canCopy) },
        { role: "paste", enabled: Boolean(editFlags.canPaste) },
        { role: "selectAll", enabled: Boolean(editFlags.canSelectAll) },
      );
    } else if (params.selectionText) {
      template.push({ role: "copy" });
    }

    if (allowSaveImage && params.mediaType === "image" && params.srcURL) {
      addSeparator(template);
      template.push({
        label: "Save Image As…",
        click: () => {
          if (!webContents.isDestroyed()) {
            webContents.downloadURL(params.srcURL);
          }
        },
      });
    }

    if (allowInspect) {
      addSeparator(template);
      template.push({
        label: "Inspect Element",
        click: () => {
          if (!webContents.isDestroyed()) {
            webContents.inspectElement(params.x, params.y);
          }
        },
      });
    }

    if (template.length === 0) return;

    Menu.buildFromTemplate(template).popup({ window: browserWindow });
  });
}

module.exports = configureContextMenu;
