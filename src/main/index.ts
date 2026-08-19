// =====================================================================
// Processo main: finestra, IPC, ciclo di vita.
// =====================================================================

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModel } from '../language/compile.js';
import type { AskAnswer, CredentialId, NewProjectInput, Project, ProviderId } from '../shared/protocol.js';
import { PROVIDERS, WEB_SEARCH } from '../shared/protocol.js';
import { getProvider } from './llm/index.js';
import { TavilyClient } from './web/tavily.js';
import { answerAsk, isRunning, snapshotFor, startRun, stopAll, stopRun } from './runs.js';
import { createProject, getProject, listProjects, removeProject, updateProject } from './store/projects.js';
import {
  clearKey,
  credentialsFor,
  firstConfiguredProvider,
  readPreferences,
  readSettings,
  setBaseUrl,
  setKey,
  writePreferences,
} from './store/settings.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;

/**
 * L'icona per finestra e Dock.
 *
 * Nel pacchetto finale ci pensa electron-builder a livello di sistema
 * operativo; questa serve durante lo sviluppo, dove altrimenti si
 * vedrebbe il rombo di Electron, e su Linux dove l'icona della
 * finestra la decide l'applicazione.
 */
function appIcon(): Electron.NativeImage | undefined {
  for (const candidate of [
    path.join(dirname, '../../build/icon.png'),
    path.join(process.resourcesPath ?? '', 'build/icon.png'),
  ]) {
    if (candidate && existsSync(candidate)) {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    }
  }
  return undefined;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#0e0c0a',
    icon: appIcon(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // I link esterni escono nel browser di sistema, mai in una finestra
  // dell'app: una finestra Electron senza chrome e' un ottimo posto per
  // farsi ingannare.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(dirname, '../renderer/index.html'));
  }
}

// --------------------------------------------------------------- IPC

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_event, ...args) => fn(...(args as T)));
}

function registerIpc(): void {
  handle('projects:list', () => listProjects());
  handle('projects:get', (id: string) => getProject(id));
  handle('projects:create', (input: NewProjectInput) => createProject(input));
  handle('projects:update', (id: string, patch: Partial<Project>) => updateProject(id, patch));
  handle('projects:remove', async (id: string) => {
    if (isRunning(id)) stopRun(id);
    await removeProject(id);
  });

  handle('model:compile', (text: string) => compileModel(text));
  handle('model:readFile', async (p: string) => ({ path: p, text: await fs.readFile(p, 'utf8') }));

  handle('dialog:pickWorkspace', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose workspace directory',
      properties: ['openDirectory', 'createDirectory'],
      message: 'The agent can read and write only inside this directory.',
    });
    return res.canceled ? undefined : res.filePaths[0];
  });

  handle('dialog:pickModelFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose an Orcrist model',
      properties: ['openFile'],
      filters: [
        { name: 'Orcrist', extensions: ['orc'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return undefined;
    const p = res.filePaths[0];
    return { path: p, text: await fs.readFile(p, 'utf8') };
  });

  handle('settings:read', () => readSettings());
  handle('settings:setKey', (provider: CredentialId, key: string) => setKey(provider, key));
  handle('settings:clearKey', (provider: CredentialId) => clearKey(provider));
  handle('settings:setBaseUrl', (provider: CredentialId, url: string) => setBaseUrl(provider, url));
  handle('settings:test', async (provider: CredentialId, model: string) => {
    const info = [...PROVIDERS, WEB_SEARCH].find((p) => p.id === provider);
    const creds = await credentialsFor(provider);
    if (info?.needsKey && !creds.apiKey) return { ok: false, message: 'No key configured.' };

    if (provider === 'tavily') {
      try {
        const first = await new TavilyClient(creds.apiKey!, creds.baseUrl).ping();
        return { ok: true, message: `Search succeeded: ${first}` };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    }

    try {
      const res = await getProvider(provider as ProviderId).chat(
        {
          system: 'Reply with one word only.',
          messages: [{ role: 'user', content: 'ping' }],
          tools: [],
          model,
          maxTokens: 16,
        },
        creds,
      );
      return { ok: true, message: `Response received: "${res.text.trim().slice(0, 40) || '(empty)'}"` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  handle('settings:readPreferences', async () => {
    const prefs = await readPreferences();
    // Se non c'e' ancora una scelta ricordata, si propone il primo
    // provider gia' configurato invece del default di fabbrica.
    if (!prefs.lastProvider) prefs.lastProvider = await firstConfiguredProvider();
    return prefs;
  });
  handle('settings:writePreferences', (patch: Record<string, unknown>) => writePreferences(patch));

  handle('run:start', async (projectId: string) => {
    const project = await getProject(projectId);
    if (!project) return { ok: false, message: 'Project does not exist.' };
    return startRun(project);
  });
  handle('run:stop', (projectId: string) => stopRun(projectId));
  handle('run:snapshot', (projectId: string) => snapshotFor(projectId));
  handle('run:answer', (projectId: string, answer: AskAnswer) => answerAsk(projectId, answer));

  handle('shell:openWorkspace', async (p: string) => {
    await shell.openPath(p);
  });
}

// ------------------------------------------------------------ avvio

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      app.setName('Orcrist');
      const icon = appIcon();
      if (icon) app.dock?.setIcon(icon);
    }
    Menu.setApplicationMenu(buildMenu());
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopAll();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => stopAll());
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac
      ? ([
          {
            label: 'Orcrist',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'Modifica',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Vista',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]);
}
