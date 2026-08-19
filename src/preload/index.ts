// =====================================================================
// Ponte fra renderer e main. Nessun accesso diretto a Node dal
// renderer: solo questa superficie tipizzata.
// =====================================================================

import { contextBridge, ipcRenderer } from 'electron';
import type { OrcristApi, RunEvent } from '../shared/protocol.js';


const api: OrcristApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (id) => ipcRenderer.invoke('projects:get', id),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    update: (id, patch) => ipcRenderer.invoke('projects:update', id, patch),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
  },
  model: {
    compile: (text) => ipcRenderer.invoke('model:compile', text),
    readFile: (p) => ipcRenderer.invoke('model:readFile', p),
  },
  dialog: {
    pickWorkspace: () => ipcRenderer.invoke('dialog:pickWorkspace'),
    pickModelFile: () => ipcRenderer.invoke('dialog:pickModelFile'),
  },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    setKey: (provider, key) => ipcRenderer.invoke('settings:setKey', provider, key),
    clearKey: (provider) => ipcRenderer.invoke('settings:clearKey', provider),
    setBaseUrl: (provider, url) => ipcRenderer.invoke('settings:setBaseUrl', provider, url),
    test: (provider, model) => ipcRenderer.invoke('settings:test', provider, model),
    readPreferences: () => ipcRenderer.invoke('settings:readPreferences'),
    writePreferences: (patch) => ipcRenderer.invoke('settings:writePreferences', patch),
  },
  run: {
    start: (projectId) => ipcRenderer.invoke('run:start', projectId),
    stop: (projectId) => ipcRenderer.invoke('run:stop', projectId),
    snapshot: (projectId) => ipcRenderer.invoke('run:snapshot', projectId),
    answer: (projectId, answer) => ipcRenderer.invoke('run:answer', projectId, answer),
    onEvent: (cb) => {
      const listener = (_e: unknown, projectId: string, event: RunEvent): void => cb(projectId, event);
      ipcRenderer.on('run:event', listener);
      return () => ipcRenderer.off('run:event', listener);
    },
    onFocusProject: (cb) => {
      const listener = (_e: unknown, projectId: string): void => cb(projectId);
      ipcRenderer.on('run:focus-project', listener);
      return () => ipcRenderer.off('run:focus-project', listener);
    },
  },
  shell: {
    openWorkspace: (p) => ipcRenderer.invoke('shell:openWorkspace', p),
  },
};

contextBridge.exposeInMainWorld('orcrist', api);
contextBridge.exposeInMainWorld('platform', { os: process.platform });
