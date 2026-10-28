const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  'mini',
  Object.freeze({
    stop: () => ipcRenderer.send('wick:mini', 'stop'),
    showMain: () => ipcRenderer.send('wick:mini', 'main'),
    onUpdate: (callback) => ipcRenderer.on('wick:mini', (_event, state) => callback(state)),
  }),
);
