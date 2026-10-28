import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient, enginePath } from './engine-client.js';
import { checkManifest, loadMacro, MacroError } from './macro-loader.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.setName('Wick');
app.setPath('userData', process.env.WICK_USER_DATA || path.join(app.getPath('appData'), 'wick'));

const engine = new EngineClient({ path: enginePath({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined }) });
let window = null;
let bench = null;
// The target the engine's session is watching, so a run can reuse it.
let sessionTarget = null;
// Macro folders shown in the app: the bundled examples plus any the user opened.
const preferencesPath = () => path.join(app.getPath('userData'), 'preferences.json');

function preferences() {
  try {
    return JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
  } catch {
    return { folders: [], settings: {} };
  }
}

function savePreferences(update) {
  const next = { ...preferences(), ...update };
  fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
  fs.writeFileSync(preferencesPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function exampleFolders() {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'examples') : path.join(root, 'examples');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((p) => fs.existsSync(path.join(p, 'wick.json')));
}

function macroFolders() {
  const opened = (preferences().folders ?? []).filter((p) => fs.existsSync(path.join(p, 'wick.json')));
  return [...new Set([...exampleFolders(), ...opened])];
}

function describeMacro(folder) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(folder, 'wick.json'), 'utf8'));
  } catch (e) {
    return { folder, error: `wick.json couldn't be read: ${e.message}` };
  }
  const problems = checkManifest(manifest);
  return {
    folder,
    example: exampleFolders().includes(folder),
    id: manifest.id,
    name: manifest.name ?? path.basename(folder),
    description: manifest.description ?? '',
    target: manifest.target,
    permissions: manifest.permissions ?? [],
    settings: manifest.settings ?? {},
    values: preferences().settings?.[manifest.id] ?? {},
    error: problems.length ? problems.join(' ') : null,
  };
}

async function ensureSession(target, scenario) {
  if (sessionTarget === target && !scenario) return;
  await engine.call('session.start', { target, ...(scenario ? { scenario } : {}) });
  sessionTarget = target;
}

function openTestBench() {
  if (bench && !bench.isDestroyed()) {
    bench.show();
    bench.focus();
    return;
  }
  // A standard titled window, so the engine finds the game area by
  // subtracting the system title bar, as it does for Roblox.
  bench = new BrowserWindow({
    width: 960,
    height: 540,
    useContentSize: true,
    minWidth: 480,
    minHeight: 300,
    title: 'Wick Test Bench',
    backgroundColor: '#181a1f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  bench.on('page-title-updated', (event) => event.preventDefault());
  bench.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bench.loadFile(path.join(root, 'testbench', 'index.html'));
  bench.on('closed', () => {
    bench = null;
  });
}

const actions = {
  async status() {
    const [engineVersion, permissions, targets] = await Promise.all([
      engine.call('version'),
      engine.call('permissions'),
      engine.call('targets.list'),
    ]);
    return { appVersion: version, engine: engineVersion, permissions, targets, sessionTarget };
  },
  macros: () => macroFolders().map(describeMacro),
  async openMacro() {
    const result = await dialog.showOpenDialog(window, { title: 'Open a macro folder', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = result.filePaths[0];
    if (!fs.existsSync(path.join(folder, 'wick.json'))) throw new MacroError('That folder has no wick.json, so it isn\'t a Wick macro.');
    const folders = preferences().folders ?? [];
    if (!folders.includes(folder)) savePreferences({ folders: [...folders, folder] });
    return describeMacro(folder);
  },
  saveSettings({ id, values }) {
    const all = preferences().settings ?? {};
    savePreferences({ settings: { ...all, [id]: values } });
    return true;
  },
  watch: ({ target }) => ensureSession(target),
  async unwatch() {
    await engine.call('session.stop');
    sessionTarget = null;
  },
  async run({ folder, target, settings }) {
    const spec = await loadMacro(folder, { settings });
    await ensureSession(target);
    await engine.call('macro.run', { macro: spec });
    return { id: spec.id };
  },
  stop: () => engine.call('macro.stop'),
  killswitch: () => engine.call('killswitch'),
  async simulate({ folder, settings, seeds = 5, seconds = 30 }) {
    const spec = await loadMacro(folder, { settings });
    const runs = await Promise.all(
      Array.from({ length: seeds }, (_, i) => engine.call('sim.run', { macro: spec, scenario: { seed: i + 1 }, seconds })),
    );
    return runs;
  },
  requestPermissions: () => engine.call('permissions.request'),
  openPrivacySettings({ pane }) {
    const anchor = pane === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
    return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
  },
  openTestBench,
  showFolder: ({ folder }) => shell.openPath(folder),
};

async function dispatch(action, data) {
  const handler = actions[action];
  if (!handler) throw new Error(`Unknown action "${action}"`);
  return handler(data ?? {});
}

function forward(method, params) {
  if (window && !window.isDestroyed()) window.webContents.send('wick:event', method, params);
}

// WICK_SMOKE=1 runs the window hidden, reports what loaded, and quits (scripts/smoke-app.mjs).
const smoke = process.env.WICK_SMOKE === '1';

async function smokeReport() {
  const errors = [];
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  // Give the renderer time to reach the engine and pick a macro, then switch
  // to the simulator, which needs no window or permissions, and let it draw.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await window.webContents.executeJavaScript(`document.querySelector('#targetPicker button').click()`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const shown = await window.webContents.executeJavaScript(`({
    macro: document.getElementById('macroName').textContent,
    engine: document.getElementById('engineLabel').textContent,
    target: document.getElementById('crumbTarget').textContent,
    fps: document.getElementById('fpsText').textContent,
    previewDrawn: document.getElementById('liveEmpty').classList.contains('hidden'),
  })`);
  if (process.env.WICK_SMOKE_SHOT) {
    const image = await window.webContents.capturePage();
    fs.writeFileSync(process.env.WICK_SMOKE_SHOT, image.toPNG());
  }
  const ok = errors.length === 0 && shown.engine === 'Engine running' && Boolean(shown.macro) && shown.previewDrawn;
  process.stdout.write(`WICK_SMOKE ${JSON.stringify({ ok, shown, errors })}\n`);
  app.exit(ok ? 0 : 1);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: !smoke,
    backgroundColor: '#181818',
    title: 'Wick',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 17, y: 18 } } : {}),
    webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(directory, 'ui', 'index.html'));
  window.on('closed', () => {
    window = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [{ label: 'Wick', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
        : []),
      { label: 'File', submenu: [{ label: 'Open Macro Folder…', accelerator: 'CmdOrCtrl+O', click: () => forward('app.openMacro', {}) }, { label: 'Open Test Bench', click: openTestBench }, { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );

  ipcMain.handle('wick', async (event, action, data) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    try {
      return { ok: true, value: await dispatch(action, data) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  engine.on('event', (method, params) => {
    if (method === 'session.stats' || method === 'preview') sessionTarget = params.target ?? sessionTarget;
    forward(method, params);
  });
  engine.on('exit', () => {
    sessionTarget = null;
    forward('engine.exit', {});
  });
  engine.on('stderr', (text) => process.stderr.write(`[engine] ${text}`));
  engine.on('ready', async () => {
    forward('engine.ready', {});
    // The engine registers F8 itself; if it couldn't (no Accessibility
    // permission yet), the app's own shortcut keeps the kill switch working.
    const permissions = await engine.call('permissions').catch(() => null);
    if (permissions && !permissions.hotkey.active && !globalShortcut.isRegistered('F8')) {
      globalShortcut.register('F8', () => engine.call('killswitch').catch(() => {}));
    }
  });

  createWindow();
  if (smoke) smokeReport();
  try {
    engine.start();
  } catch (e) {
    if (smoke) process.stdout.write(`WICK_SMOKE ${JSON.stringify({ ok: false, errors: [e.message] })}\n`);
    dialog.showErrorBox('Wick engine missing', e.message);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  engine.stop();
});
