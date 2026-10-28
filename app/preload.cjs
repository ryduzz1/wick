const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld(
  'wick',
  Object.freeze({
    call: (action, data) => ipcRenderer.invoke('wick', action, data),
    onEvent: (callback) => {
      const listener = (_event, method, params) => callback(method, params);
      ipcRenderer.on('wick:event', listener);
      return () => ipcRenderer.removeListener('wick:event', listener);
    },
    // Where a dropped file lives, so a dropped .wick can be installed.
    pathForFile: (file) => webUtils.getPathForFile(file),
    platform: process.platform,
  }),
);
