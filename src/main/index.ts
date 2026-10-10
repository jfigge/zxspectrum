import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, ModelId, OpenedFile, Roms, Settings } from '../shared/api';
import { buildMenu } from './menu';
import { addRecent, loadSettings, saveSettings } from './settings';

const here = fileURLToPath(new URL('.', import.meta.url));
const SCREEN_W = 352;
const SCREEN_H = 288;
const STATUS_BAR_H = 24;
const FILE_FILTERS = [
  { name: 'Spectrum files', extensions: ['tap', 'tzx', 'z80', 'sna'] },
  { name: 'Tapes', extensions: ['tap', 'tzx'] },
  { name: 'Snapshots', extensions: ['z80', 'sna'] },
];

let win: BrowserWindow | null = null;
let settings: Settings;

function romDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'roms') : join(app.getAppPath(), 'resources', 'roms');
}

function send(cmd: Command): void {
  win?.webContents.send('command', cmd);
}

function update(changes: Partial<Settings>): void {
  Object.assign(settings, changes);
  saveSettings(settings);
  if (win) Menu.setApplicationMenu(buildMenu(settings, actions));
}

async function readSpectrumFile(path: string): Promise<OpenedFile> {
  const data = new Uint8Array(await readFile(path));
  addRecent(settings, path);
  update({});
  return { name: basename(path), data };
}

async function openRecent(path: string): Promise<void> {
  try {
    send({ type: 'open-file', file: await readSpectrumFile(path) });
  } catch (err) {
    dialog.showErrorBox('Could not open file', `${path}\n\n${(err as Error).message}`);
    update({ recent: settings.recent.filter((p) => p !== path) });
  }
}

async function showOpenDialog(): Promise<OpenedFile | null> {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILE_FILTERS });
  if (result.canceled || !result.filePaths[0]) return null;
  return readSpectrumFile(result.filePaths[0]);
}

function resizeForScale(scale: number): void {
  if (!win || win.isFullScreen()) return;
  win.setContentSize(SCREEN_W * scale, SCREEN_H * scale + STATUS_BAR_H);
}

const actions = {
  send,
  openDialog: async () => {
    const file = await showOpenDialog();
    if (file) send({ type: 'open-file', file });
  },
  openRecent,
  clearRecent: () => {
    app.clearRecentDocuments();
    update({ recent: [] });
  },
  setModel: (model: ModelId) => {
    update({ model });
    send({ type: 'set-model', model });
  },
  setScale: (scale: number) => {
    update({ scale });
    resizeForScale(scale);
  },
  setFastLoad: (enabled: boolean) => {
    update({ fastLoad: enabled });
    send({ type: 'set-fast-load', enabled });
  },
  setAccelerate: (enabled: boolean) => {
    update({ accelerateLoading: enabled });
    send({ type: 'set-accelerate', enabled });
  },
};

function registerIpc(): void {
  ipcMain.handle('roms:get', async (): Promise<Roms> => {
    const dir = romDir();
    const read = async (name: string) => {
      try {
        return new Uint8Array(await readFile(join(dir, name)));
      } catch {
        throw new Error(`Missing ROM ${name} in ${dir}. Run "npm run fetch-roms".`);
      }
    };
    return { '48': await read('48.rom'), '128-0': await read('128-0.rom'), '128-1': await read('128-1.rom') };
  });
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set-model', (_e, model: ModelId) => update({ model }));
  ipcMain.handle('file:open-dialog', () => showOpenDialog());
  ipcMain.handle('recent:add', (_e, path: string) => {
    addRecent(settings, path);
    update({});
  });
  ipcMain.handle('file:save', async (_e, defaultName: string, data: Uint8Array) => {
    if (!win) return false;
    const ext = defaultName.split('.').pop() ?? '';
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: `${ext.toUpperCase()} snapshot`, extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, data);
    return true;
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: SCREEN_W * settings.scale,
    height: SCREEN_H * settings.scale + STATUS_BAR_H,
    useContentSize: true,
    minWidth: SCREEN_W,
    minHeight: SCREEN_H + STATUS_BAR_H,
    backgroundColor: '#000000',
    title: 'ZX Spectrum',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  Menu.setApplicationMenu(buildMenu(settings, actions));
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(here, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });
}

// Files opened via Finder / dock before or after launch.
const pendingOpens: string[] = [];
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (win) void openRecent(path);
  else pendingOpens.push(path);
});

app.whenReady().then(() => {
  settings = loadSettings();
  registerIpc();
  createWindow();
  win!.webContents.once('did-finish-load', () => {
    for (const p of pendingOpens.splice(0)) void openRecent(p);
  });
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
