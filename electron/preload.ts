import { contextBridge, ipcRenderer } from 'electron';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

const api = {
  env: {
    info: () => call<any>('env:info'),
    reloadAssets: () => call<any>('env:reloadAssets'),
    openExternal: (url: string) => call<boolean>('env:openExternal', url),
    revealPath: (p: string) => call<boolean>('env:revealPath', p),
  },
  settings: {
    load: () => call<any>('settings:load'),
    save: (s: unknown) => call<any>('settings:save', s),
    ollamaModels: (baseUrl?: string) => call<string[]>('settings:ollamaModels', baseUrl),
  },
  projects: {
    list: () => call<any[]>('project:list'),
    pickFolder: () => call<string | undefined>('project:pickFolder'),
    create: (name: string, workspace: string) => call<any>('project:create', name, workspace),
    open: (id: string) => call<any>('project:open', id),
    rename: (id: string, name: string) => call<any>('project:rename', id, name),
    forget: (id: string) => call<boolean>('project:forget', id),
  },
  sessions: {
    list: (projectId: string) => call<any[]>('session:list', projectId),
    create: (projectId: string, title?: string) => call<any>('session:create', projectId, title),
    rename: (projectId: string, sessionId: string, title: string) =>
      call<any>('session:rename', projectId, sessionId, title),
    remove: (projectId: string, sessionId: string) =>
      call<boolean>('session:delete', projectId, sessionId),
    onChanged: (cb: (session: any) => void) => {
      const listener = (_e: unknown, s: any) => cb(s);
      ipcRenderer.on('session:changed', listener);
      return () => ipcRenderer.removeListener('session:changed', listener);
    },
  },
  runs: {
    list: (projectId: string, sessionId: string) => call<any[]>('run:list', projectId, sessionId),
    get: (projectId: string, runId: string) => call<any>('run:get', projectId, runId),
    start: (projectId: string, sessionId: string, task: string) =>
      call<any>('run:start', projectId, sessionId, task),
    cancel: (runId: string) => call<boolean>('run:cancel', runId),
    approve: (runId: string, approved: boolean) => call<boolean>('run:approve', runId, approved),
    isActive: (runId: string) => call<boolean>('run:isActive', runId),
    live: () => call<{ runId: string; sessionId: string; state?: string }[]>('run:live'),
    onEvent: (cb: (payload: { runId: string; event: any }) => void) => {
      const listener = (_e: unknown, payload: { runId: string; event: any }) => cb(payload);
      ipcRenderer.on('run:event', listener);
      return () => ipcRenderer.removeListener('run:event', listener);
    },
    onChanged: (cb: (run: any) => void) => {
      const listener = (_e: unknown, run: any) => cb(run);
      ipcRenderer.on('run:changed', listener);
      return () => ipcRenderer.removeListener('run:changed', listener);
    },
  },
  orcrist: {
    check: (source: string) => call<any>('orcrist:check', source),
    examples: () => call<{ name: string; source: string }[]>('orcrist:examples'),
  },
};

contextBridge.exposeInMainWorld('orcrist', api);

export type OrcristApi = typeof api;
