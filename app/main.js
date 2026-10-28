import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient, enginePath } from './engine-client.js';
import { createCommands } from './commands.js';
import { serve } from './control.js';
import * as library from './library.js';
import { checkManifest, DEFAULT_INPUT, loadMacro, MacroError } from './macro-loader.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, '..');
const icon = path.join(directory, 'ui', 'assets', 'icon.png');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.setName('Wick');
app.setPath('userData', process.env.WICK_USER_DATA || path.join(app.getPath('appData'), 'wick'));

const engine = new EngineClient({ path: enginePath({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined }) });
let window = null;
let bench = null;
// The target the engine's session is watching, so a run can reuse it.
let sessionTarget = null;
let askedForPermissions = false;
let macroWatcher = null;
// The target a macro is running on, from the engine's events.
let runningTarget = null;
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

const libraryDir = () => process.env.WICK_LIBRARY || preferences().library || library.defaultLibrary();

function macroFolders() {
  const opened = (preferences().folders ?? []).filter((p) => fs.existsSync(path.join(p, 'wick.json')));
  return [...new Set([...library.listLibrary(libraryDir()), ...opened, ...exampleFolders()])];
}

const inLibrary = (folder) => path.dirname(folder) === path.resolve(libraryDir());

function describeMacro(folder) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(folder, 'wick.json'), 'utf8'));
  } catch (e) {
    return { folder, error: `wick.json couldn't be read: ${e.message}` };
  }
  const problems = checkManifest(manifest);
  let regions = {};
  try {
    regions = library.readRegions(folder);
  } catch (e) {
    problems.push(`regions.json couldn't be read: ${e.message}`);
  }
  const example = exampleFolders().includes(folder);
  return {
    folder,
    example,
    editable: !example,
    inLibrary: inLibrary(folder),
    entry: manifest.entry ?? 'main.ts',
    regions,
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
  async newMacro({ name, target }) {
    return describeMacro(library.createMacro(libraryDir(), { name, target }));
  },
  copyMacro: ({ folder }) => describeMacro(library.copyMacro(folder, libraryDir())),
  async deleteMacro({ folder }) {
    if (exampleFolders().includes(folder)) throw new MacroError('Examples come with Wick and can\'t be deleted.');
    const name = describeMacro(folder).name ?? path.basename(folder);
    if (inLibrary(folder)) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Move to Trash', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Move "${name}" to the Trash?`,
        detail: 'You can put it back from the Trash.',
      });
      if (response !== 0) return false;
      await shell.trashItem(folder);
    } else {
      savePreferences({ folders: (preferences().folders ?? []).filter((f) => f !== folder) });
    }
    return true;
  },
  saveRegions({ folder, regions }) {
    if (!describeMacro(folder).editable) throw new MacroError('Examples can\'t be edited. Make a copy first.');
    return library.saveRegions(folder, regions);
  },
  updateManifest({ folder, changes }) {
    if (!describeMacro(folder).editable) throw new MacroError('Examples can\'t be edited. Make a copy first.');
    library.updateManifest(folder, changes);
    return describeMacro(folder);
  },
  describe: ({ folder }) => describeMacro(folder),
  editCode({ folder }) {
    const entry = path.join(folder, describeMacro(folder).entry);
    return shell.openPath(fs.existsSync(entry) ? entry : folder);
  },
  watchMacro({ folder }) {
    macroWatcher?.close();
    macroWatcher = null;
    if (!folder || !fs.existsSync(folder)) return;
    let timer = null;
    try {
      macroWatcher = fs.watch(folder, { recursive: true }, (_type, file) => {
        if (file && /(^|[\\/])\./.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => forward('macro.changed', { folder }), 200);
      });
    } catch {
      // Watching is a convenience; without it the user reselects the macro.
    }
  },
  libraryInfo: () => ({ folder: libraryDir() }),
  async chooseLibrary() {
    const result = await dialog.showOpenDialog(window, { title: 'Choose the library folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    savePreferences({ library: result.filePaths[0] });
    return { folder: result.filePaths[0] };
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
  inputPreferences: () => ({ ...DEFAULT_INPUT, ...preferences().input }),
  saveInputPreferences(input) {
    savePreferences({ input: { ...DEFAULT_INPUT, ...preferences().input, ...input } });
    return { ...DEFAULT_INPUT, ...preferences().input };
  },
  async run({ folder, target, settings }) {
    const spec = await loadMacro(folder, { settings, input: preferences().input });
    await ensureSession(target);
    await engine.call('macro.run', { macro: spec });
    return { id: spec.id };
  },
  stop: () => engine.call('macro.stop'),
  killswitch: () => engine.call('killswitch'),
  async simulate({ folder, settings, seeds = 5, seconds = 30 }) {
    const spec = await loadMacro(folder, { settings, input: preferences().input });
    const runs = await Promise.all(
      Array.from({ length: seeds }, (_, i) =>
        engine.call('sim.run', { macro: { ...spec, human: spec.human && { ...spec.human, seed: i + 1 } }, scenario: { seed: i + 1 }, seconds }),
      ),
    );
    return runs;
  },
  requestPermissions: () => engine.call('permissions.request'),
  restart() {
    app.relaunch();
    app.quit();
  },
  openPrivacySettings({ pane }) {
    const anchor = pane === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
    return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
  },
  openTestBench,
  showFolder({ folder, create }) {
    if (create) fs.mkdirSync(folder, { recursive: true });
    return shell.openPath(folder);
  },
};

// The control socket, for the `wick` CLI and MCP server.
async function startControl() {
  const commands = createCommands({
    engine,
    ensureSession: (target) => ensureSession(target),
    busyTarget: () => runningTarget,
    savedSettings: (id) => preferences().settings?.[id] ?? {},
    inputPreferences: () => ({ ...DEFAULT_INPUT, ...preferences().input }),
    get libraryDir() {
      return libraryDir();
    },
    notify: (event, data) => forward(`agent.${event}`, data),
  });
  try {
    await serve(commands);
  } catch (e) {
    process.stderr.write(`Wick couldn't open its control socket, so the wick CLI will use its own engine: ${e.message}\n`);
  }
}

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
  // Exercise the editor: create a macro, drag its region, and check a color.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const js = (code) => window.webContents.executeJavaScript(code);
  await js(`document.getElementById('newMacro').click()`);
  await sleep(300);
  await js(`(() => {
    const f = document.getElementById('newForm');
    f.elements.name.value = 'Smoke test';
    f.elements.target.value = 'sim';
    f.querySelector('button[value=create]').click();
  })()`);
  await sleep(1500);
  shown.created = await js(`document.getElementById('macroName').textContent`);
  shown.regions = await js(`[...document.querySelectorAll('.region-row')].map((r) => r.dataset.name)`);
  await js(`(() => {
    const c = document.getElementById('liveCanvas');
    const b = c.getBoundingClientRect();
    const at = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    at('pointerdown', cx, cy); at('pointermove', cx + 60, cy + 20); at('pointerup', cx + 60, cy + 20);
    at('pointerdown', b.left + 3, b.top + 3); at('pointerup', b.left + 3, b.top + 3);
    const hex = document.getElementById('colorHex');
    hex.value = '#3ccf5a';
    hex.dispatchEvent(new Event('input'));
  })()`);
  await sleep(800);
  const smokeFolder = path.join(libraryDir(), 'smoke-test');
  shown.movedRegion = fs.existsSync(smokeFolder) ? library.readRegions(smokeFolder).area : null;
  shown.matches = await js(`document.getElementById('matchText').textContent`);
  // Settings: changing precision saves it.
  await js(`document.getElementById('openSettings').click()`);
  await sleep(300);
  await js(`(() => {
    const f = document.getElementById('settingsDialogForm');
    f.elements.precision.value = 70;
    f.dispatchEvent(new Event('input'));
  })()`);
  await sleep(300);
  shown.input = preferences().input;
  if (process.env.WICK_SMOKE_DIALOG !== 'settings') await js(`document.getElementById('settingsDialog').close()`);
  // The CLI should reach this app over the control socket, not start its own engine.
  const cli = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, 'bin', 'wick.js'), 'observe', '--target', 'sim', '--folder', smokeFolder], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (error, stdout, stderr) =>
      resolve({ error: error?.message, stdout, stderr }),
    );
  });
  try {
    shown.cli = { usedApp: !/own engine/.test(cli.stderr), saved: fs.existsSync(JSON.parse(cli.stdout).path) };
  } catch {
    shown.cli = { error: cli.error ?? cli.stderr };
  }
  if (process.env.WICK_SMOKE_SHOT) {
    if (process.env.WICK_SMOKE_SCROLL) await js(`document.querySelector('main').scrollTop = ${Number(process.env.WICK_SMOKE_SCROLL)}`);
    await sleep(100);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(process.env.WICK_SMOKE_SHOT, image.toPNG());
  }
  const ok = errors.length === 0 && shown.engine === 'Engine running' && Boolean(shown.macro) && shown.previewDrawn &&
    shown.created === 'Smoke test' && shown.regions.includes('area') && shown.movedRegion?.x > 0 && /^[1-9]\d* px/.test(shown.matches) &&
    shown.cli?.usedApp && shown.cli?.saved && shown.input?.precision === 0.7;
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
    icon,
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
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [{ label: 'Wick', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => forward('app.settings', {}) }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
        : []),
      { label: 'File', submenu: [{ label: 'New Macro…', accelerator: 'CmdOrCtrl+N', click: () => forward('app.newMacro', {}) }, { label: 'Open Macro Folder…', accelerator: 'CmdOrCtrl+O', click: () => forward('app.openMacro', {}) }, { label: 'Open Test Bench', click: openTestBench }, ...(process.platform === 'darwin' ? [] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => forward('app.settings', {}) }]), { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
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
    if (method === 'macro.state' && params.state === 'running') runningTarget = sessionTarget;
    if (method === 'macro.end') runningTarget = null;
    forward(method, params);
  });
  engine.on('exit', () => {
    sessionTarget = null;
    runningTarget = null;
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
    // Ask macOS for anything missing once per launch, so the system prompts
    // appear without the user having to find a button.
    if (permissions && process.platform === 'darwin' && !smoke && !askedForPermissions) {
      askedForPermissions = true;
      if (!permissions.screenRecording || !permissions.accessibility) engine.call('permissions.request').catch(() => {});
    }
  });

  createWindow();
  startControl();
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
