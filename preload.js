const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hikari', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  saveLibrary: (items) => ipcRenderer.invoke('library:set', items),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  remoteInfo: () => ipcRenderer.invoke('remote:info'),
  remoteSetEnabled: (on) => ipcRenderer.invoke('remote:set-enabled', on),
  remoteRotateToken: () => ipcRenderer.invoke('remote:rotate-token'),
  openDataDir: () => ipcRenderer.invoke('app:open-data'),
  revealFile: (p) => ipcRenderer.invoke('media:reveal', p),
  fetchJson: (url) => ipcRenderer.invoke('net:json', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (obj) => ipcRenderer.invoke('settings:set', obj),
  exportData: (payload) => ipcRenderer.invoke('data:export', payload),
  importData: () => ipcRenderer.invoke('data:import'),

  mediaSetRoots: (roots) => ipcRenderer.invoke('media:set-roots', roots),
  mediaPickFolder: () => ipcRenderer.invoke('media:pick-folder'),
  mediaScan: (roots) => ipcRenderer.invoke('media:scan', roots),
  mediaScanShow: (dir) => ipcRenderer.invoke('media:scan-show', dir),
  mediaPrepare: (file, epKey, wait) => ipcRenderer.invoke('media:prepare', { file, epKey, wait }),
  mediaNeeds: (file) => ipcRenderer.invoke('media:needs', file),
  mediaCancel: (epKey) => ipcRenderer.invoke('media:cancel', epKey),
  mediaExists: (file) => ipcRenderer.invoke('media:exists', file),
  mediaOpenExternal: (file) => ipcRenderer.invoke('media:open-external', file),
  mediaOrganize: (ops) => ipcRenderer.invoke('media:organize', ops),
  onMediaProgress: (cb) => ipcRenderer.on('media:progress', (_e, v) => cb(v)),

  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v))
});
