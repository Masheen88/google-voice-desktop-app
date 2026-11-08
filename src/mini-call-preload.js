// A narrowly scoped bridge for the local Mini Call Controller window.
// No Node APIs or raw ipcRenderer are exposed to this renderer.
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_ACTIONS = new Set([
  'answer', 'decline', 'hangup', 'mute', 'tone-1', 'tone-2',
  'open-main', 'hide', 'show-keypad', 'copy-diagnostics',
]);

contextBridge.exposeInMainWorld('miniCall', {
  ready: () => ipcRenderer.invoke('mini-call-ready'),
  action: (name) => ALLOWED_ACTIONS.has(name)
    ? ipcRenderer.invoke('mini-call-action', name)
    : Promise.resolve({ ok: false, message: 'Unsupported action.' }),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('mini-call-update', listener);
    return () => ipcRenderer.removeListener('mini-call-update', listener);
  },
  onFeedback: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('mini-call-feedback', listener);
    return () => ipcRenderer.removeListener('mini-call-feedback', listener);
  },
});
