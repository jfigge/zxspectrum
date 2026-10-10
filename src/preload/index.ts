import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Command, ZxApi } from '../shared/api';

const api: ZxApi = {
  getRoms: () => ipcRenderer.invoke('roms:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setModel: (model) => ipcRenderer.invoke('settings:set-model', model),
  openFileDialog: () => ipcRenderer.invoke('file:open-dialog'),
  saveFile: (defaultName, data) => ipcRenderer.invoke('file:save', defaultName, data),
  addRecent: (path) => ipcRenderer.invoke('recent:add', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onCommand: (cb) => {
    ipcRenderer.on('command', (_event, cmd: Command) => cb(cmd));
  },
};

contextBridge.exposeInMainWorld('zx', api);
