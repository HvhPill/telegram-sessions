const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('manager', Object.freeze({
  setLanguage: language => invoke('set-language', language),
  init: () => invoke('init'), scan: () => invoke('scan'),
  chooseFolder: () => invoke('choose-folder'), saveSettings: data => invoke('save-settings', data),
  importAccounts: () => invoke('import'), openFolder: which => invoke('open-folder', which),
  start: selected => invoke('start', selected), stop: () => invoke('stop'),
  startAdditional: selected => invoke('start-additional', selected), deleteAccounts: names => invoke('delete-accounts', names),
  reply: value => invoke('reply', value), window: action => invoke('window', action),
  convertAccounts: names => invoke('convert-accounts', names),
  convertPick: data => invoke('convert-pick', data), convertStart: data => invoke('convert-start', data),
  openAccountFolder: name => invoke('account-folder', name),
  openContact: () => invoke('open-contact'),
  onEvent: listener => { ipcRenderer.on('event', (_event, data) => listener(data)); },
}));
