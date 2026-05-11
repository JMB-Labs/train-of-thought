const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toot', {
  setView: (view) => ipcRenderer.send('set-view', view),
  quit: () => ipcRenderer.send('quit'),
  hide: () => ipcRenderer.send('hide'),
});
