import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import { join } from 'node:path';
import { checkModel } from '../src/orcrist';
import { listOllamaModels } from '../src/core/llm';
import { loadLanguageAssets, type LanguageAssets } from '../src/core/paths';
import {
  approveRun,
  cancelRun,
  isAwaitingApproval,
  isRunActive,
  liveRun,
  liveRunStates,
  startRun,
  withLiveRuns,
} from '../src/core/runner';
import { Storage } from '../src/core/storage';
import { ensureWorkspace } from '../src/core/tools';
import type { Run, RunEvent, Settings } from '../src/core/types';

let mainWindow: BrowserWindow | undefined;
let storage: Storage;
let assets: LanguageAssets | undefined;

/**
 * The app icon, read from build/icon.png next to the sources.
 *
 * Windows and Linux take it from the window; macOS ignores that and uses the
 * bundle's own icon, which a packaged build carries and a development run does
 * not — so on macOS it is set on the dock instead, which is the only way to
 * see it before there is a bundle.
 */
const ICON = join(__dirname, '../../../build/icon.png');

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Orcrist Agent',
    icon: ICON,
    // The colour the window paints before the renderer has drawn anything. It
    // was a near-black, which flashed against an app whose field is a pale
    // sage — so it is the default palette's field instead.
    backgroundColor: '#b9d9c6',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServer = process.env.ORCRIST_DEV_SERVER;
  if (devServer) {
    void mainWindow.loadURL(devServer);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    const img = nativeImage.createFromPath(ICON);
    if (!img.isEmpty()) app.dock.setIcon(img);
  }
  storage = new Storage(app.getPath('userData'));
  // The app is meant to live next to metamodel/ and examples/ inside the
  // Orcrist repo; in a packaged build __dirname is inside the asar, so try the
  // executable's folder too.
  assets =
    loadLanguageAssets(app.getAppPath()) ??
    loadLanguageAssets(join(app.getPath('exe'), '..')) ??
    loadLanguageAssets(process.cwd());

  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerHandlers(): void {
  const handle = <T>(channel: string, fn: (...args: any[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
  };

  // --- environment ----------------------------------------------------
  handle('env:info', () => ({
    orcristRoot: assets?.root,
    hasGuide: Boolean(assets?.guide),
    exampleCount: assets?.examples.length ?? 0,
    platform: process.platform,
    version: app.getVersion(),
  }));

  handle('env:reloadAssets', () => {
    assets =
      loadLanguageAssets(app.getAppPath()) ??
      loadLanguageAssets(join(app.getPath('exe'), '..')) ??
      loadLanguageAssets(process.cwd());
    return { orcristRoot: assets?.root, exampleCount: assets?.examples.length ?? 0 };
  });

  handle('env:openExternal', (url: string) => {
    void shell.openExternal(url);
    return true;
  });

  handle('env:revealPath', (p: string) => {
    shell.showItemInFolder(p);
    return true;
  });

  // --- settings -------------------------------------------------------
  handle('settings:load', () => storage.loadSettings());
  handle('settings:save', (s: Settings) => storage.saveSettings(s));
  handle('settings:ollamaModels', (baseUrl?: string) => listOllamaModels(baseUrl));

  // --- projects -------------------------------------------------------
  handle('project:list', () => storage.listProjects());
  handle('project:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a workspace folder for this project',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    return res.canceled ? undefined : res.filePaths[0];
  });
  handle('project:create', async (name: string, workspace: string) => {
    await ensureWorkspace(workspace);
    return storage.createProject(name, workspace);
  });
  handle('project:open', (id: string) =>
    storage.updateProject(id, { lastOpenedAt: new Date().toISOString() }),
  );
  handle('project:rename', (id: string, name: string) => storage.updateProject(id, { name }));
  handle('project:forget', (id: string) => {
    storage.forgetProject(id);
    return true;
  });

  // --- sessions -------------------------------------------------------
  handle('session:list', (projectId: string) => storage.listSessions(projectId));
  handle('session:create', (projectId: string, title?: string) =>
    storage.createSession(projectId, title || 'New session'),
  );
  handle('session:rename', (projectId: string, sessionId: string, title: string) =>
    storage.updateSession(projectId, sessionId, { title }),
  );
  handle('session:delete', (projectId: string, sessionId: string) => {
    storage.deleteSession(projectId, sessionId);
    return true;
  });

  // --- runs -----------------------------------------------------------
  // A run still going lives in memory with every event it has emitted; the
  // copy on disk is whatever had been written at the last checkpoint. Read the
  // live one first, or opening another session loses the transcript of the one
  // that is working.
  handle('run:list', (projectId: string, sessionId: string) =>
    withLiveRuns(storage.listRuns(projectId, sessionId)),
  );
  handle('run:get', (projectId: string, runId: string) =>
    liveRun(runId) ?? storage.loadRun(projectId, runId),
  );
  handle('run:isActive', (runId: string) => isRunActive(runId));
  handle('run:live', () => liveRunStates());
  handle('run:cancel', (runId: string) => cancelRun(runId));
  handle('run:approve', (runId: string, approved: boolean) => approveRun(runId, approved));
  handle('run:awaitingApproval', (runId: string) => isAwaitingApproval(runId));

  handle('run:start', async (projectId: string, sessionId: string, task: string) => {
    const settings = storage.loadSettings();
    const project = storage.getProject(projectId);
    const session = storage.listSessions(projectId).find((s) => s.id === sessionId);
    if (!session) throw new Error('No such session.');

    return startRun({
      storage,
      project,
      session,
      task,
      settings,
      assets,
      history: storage.listRuns(projectId, sessionId).map((r) => r.task),
      emit: (runId: string, event: RunEvent) => send('run:event', { runId, event }),
      onRunChanged: (run: Run) => send('run:changed', run),
      onSessionChanged: (s) => send('session:changed', s),
    });
  });

  // --- language -------------------------------------------------------
  handle('orcrist:check', (source: string) => {
    const r = checkModel(source);
    return { machine: r.machine, errors: r.errors, warnings: r.warnings };
  });
  handle('orcrist:examples', () => assets?.examples ?? []);
}
