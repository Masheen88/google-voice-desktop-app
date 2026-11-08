/**********************************************************************************************************************
 * Isolated preload for Voice Desktop's local GIF picker. No unfiltered IPC or Node APIs are exposed.
 * The page is local and separate from Google Voice, so Google Voice never sees the GIPHY API key.
 **********************************************************************************************************************/
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceGifPicker", {
  getSettings: () => ipcRenderer.invoke("gif-picker-settings"),
  selectGif: (gif) => ipcRenderer.invoke("gif-select", gif),
  saveGif: (gif) => ipcRenderer.invoke("gif-save-file", gif),
  saveFavorite: (gif) => ipcRenderer.invoke("gif-save-favorite", gif),
  removeFavorite: (id) => ipcRenderer.invoke("gif-remove-favorite", id),
  close: () => ipcRenderer.send("gif-picker-close"),
  // This URL is an external attribution link; the main process validates it.
  openGiphy: () => ipcRenderer.send("gif-picker-open-giphy"),
});
