const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  versions: call('versions'),
  loginMicrosoft: call('login:microsoft'),
  loginOffline: call('login:offline'),
  logout: call('logout'),
  pickDir: call('pick:dir'),
  play: call('play'),
  modsSearch: call('mods:search'),
  modsInstall: call('mods:install'),
  modsList: call('mods:list'),
  modsToggle: call('mods:toggle'),
  modsRemove: call('mods:remove'),
  skinLoad: call('skin:load'),
  skinApply: call('skin:apply'),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
  onState: (cb) => ipcRenderer.on('state', (_e, m) => cb(m)),
});
