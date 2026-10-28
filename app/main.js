import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient, enginePath } from './engine-client.js';
import { createCommands } from './commands.js';
import { serve } from './control.js';
import * as library from './library.js';
import { Calibrations, colorsIn } from './calibration.js';
import { checkManifest, DEFAULT_INPUT, loadMacro, MacroError } from './macro-loader.js';
import { MiniWindow } from './mini-window.js';
import * as sharing from './package.js';
import { RunHistory } from './runs.js';

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

let history = null;
const runHistory = () => (history ??= new RunHistory(path.join(app.getPath('userData'), 'runs')));
// Names of macros started here, by id, for the mini window.
const runNames = new Map();
let mini = null;
const miniEnabled = () => preferences().miniWindow !== false;
let calibrationStore = null;
const calibrations = () => (calibrationStore ??= new Calibrations(path.join(app.getPath('userData'), 'calibration')));
const calibrationFor = (id) => calibrations().get(id);

const libraryDir = () => process.env.WICK_LIBRARY || preferences().library || library.defaultLibrary();

// Macro folders shown in the app: the library plus any folders the user opened.
function macroFolders() {
  const opened = (preferences().folders ?? []).filter((p) => fs.existsSync(path.join(p, 'wick.json')));
  return [...new Set([...library.listLibrary(libraryDir()), ...opened])];
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
  // Installed macros keep this user's region changes as calibration, so
  // updates don't overwrite them and exports don't include them.
  const install = sharing.installInfo(folder);
  const calibration = install ? calibrationFor(manifest.id) : null;
  return {
    folder,
    inLibrary: inLibrary(folder),
    entry: manifest.entry ?? 'main.ts',
    regions: calibration ? { ...regions, ...calibration.regions } : regions,
    installed: Boolean(install),
    source: install?.source ?? null,
    calibration,
    version: manifest.version ?? null,
    author: manifest.author ?? null,
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

// The simulator session restarts when a macro needs different simulator settings.
let sessionKey = null;
async function ensureSession(target, scenario) {
  const key = `${target}:${target === 'sim' ? JSON.stringify(scenario ?? null) : ''}`;
  if (sessionTarget === target && sessionKey === key) return;
  // Never restart a session under a running macro; it would stop the run.
  if (runningTarget === target) return;
  await engine.call('session.start', { target, ...(target === 'sim' && scenario ? { scenario } : {}) });
  sessionTarget = target;
  sessionKey = key;
}

function simulatorFor(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, 'wick.json'), 'utf8')).simulator ?? null;
  } catch {
    return null;
  }
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
  async deleteMacro({ folder }) {
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
    const m = describeMacro(folder);
    if (m.installed) {
      const own = library.readRegions(folder);
      const cal = calibrations().setRegions(m.id, regions, own);
      return { ...own, ...cal.regions };
    }
    return library.saveRegions(folder, regions);
  },
  async exportMacro({ folder }) {
    const m = describeMacro(folder);
    const result = await dialog.showSaveDialog(window, {
      title: 'Export macro',
      defaultPath: path.join(app.getPath('documents'), `${path.basename(folder)}-${m.version ?? '0.1.0'}.wick`),
      filters: [{ name: 'Wick macro', extensions: ['wick'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return sharing.exportMacro(folder, result.filePath);
  },
  async chooseInstallFile() {
    const result = await dialog.showOpenDialog(window, { title: 'Install a macro', properties: ['openFile'], filters: [{ name: 'Wick macro', extensions: ['wick'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return prepareInstall({ source: result.filePaths[0] });
  },
  prepareInstall: (data) => prepareInstall(data),
  // The renderer calls this once it's listening; anything the OS handed Wick
  // before then (a double-clicked .wick, a wick:// link) comes back here.
  takeInstallRequests() {
    rendererReady = true;
    return openRequests.splice(0);
  },
  confirmInstall({ token }) {
    const pending = pendingInstalls.get(token);
    if (!pending) throw new MacroError('That install has expired. Open it again.');
    pendingInstalls.delete(token);
    const result = sharing.install(pending.files, libraryDir(), { source: pending.source });
    return { ...result, macro: describeMacro(result.folder) };
  },
  async checkUpdate({ folder }) {
    const source = sharing.installInfo(folder)?.source;
    if (!source?.url) throw new MacroError('This macro wasn\'t installed from a link, so there\'s nowhere to check.');
    const found = await prepareInstall({ source: source.url, macro: source.folder });
    return found.sameAsInstalled ? { upToDate: true } : found;
  },
  async calibrationColors({ folder }) {
    const spec = await loadMacro(folder);
    return { colors: colorsIn(spec.files), mapped: calibrationFor(spec.id).colors };
  },
  setCalibrationColor({ folder, from, to }) {
    calibrations().setColor(describeMacro(folder).id, from, to);
    return describeMacro(folder);
  },
  resetCalibration({ folder }) {
    calibrations().reset(describeMacro(folder).id);
    return describeMacro(folder);
  },
  updateManifest({ folder, changes }) {
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
  watch: ({ target, folder }) => ensureSession(target, folder ? simulatorFor(folder) : null),
  async unwatch() {
    await engine.call('session.stop');
    sessionTarget = null;
    sessionKey = null;
  },
  inputPreferences: () => ({ ...DEFAULT_INPUT, ...preferences().input }),
  appPreferences: () => ({
    miniWindow: miniEnabled(),
    cli: library.cliCommand(),
    // The packaged app ships a `wick` script to link onto PATH.
    cliScript: app.isPackaged ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'wick.cmd' : 'wick') : null,
  }),
  saveAppPreferences({ miniWindow }) {
    savePreferences({ miniWindow: Boolean(miniWindow) });
    if (!miniWindow) mini?.hide();
    return actions.appPreferences();
  },
  // The automatic check only runs in the packaged app, never in development or smoke runs.
  checkAppUpdate: ({ auto = false } = {}) => (auto && (!app.isPackaged || smoke) ? { version, latest: null, available: false } : checkAppUpdate()),
  openRelease({ url }) {
    if (!String(url).startsWith(RELEASES)) throw new Error('Not a Wick release page.');
    return shell.openExternal(url);
  },
  onboarded: () => Boolean(preferences().onboarded),
  finishOnboarding: () => Boolean(savePreferences({ onboarded: true })),
  runs: ({ id }) => runHistory().list(id),
  readRun: ({ id, file }) => runHistory().read(id, file),
  saveInputPreferences(input) {
    savePreferences({ input: { ...DEFAULT_INPUT, ...preferences().input, ...input } });
    return { ...DEFAULT_INPUT, ...preferences().input };
  },
  async run({ folder, target, settings }) {
    const spec = await loadMacro(folder, { settings, input: preferences().input, calibration: calibrationFor });
    await ensureSession(target, spec.simulator);
    runNames.set(spec.id, spec.name);
    await engine.call('macro.run', { macro: spec });
    return { id: spec.id };
  },
  stop: () => engine.call('macro.stop'),
  killswitch: () => engine.call('killswitch'),
  async simulate({ folder, settings, seeds = 5, seconds = 30 }) {
    const spec = await loadMacro(folder, { settings, input: preferences().input, calibration: calibrationFor });
    const runs = await Promise.all(
      Array.from({ length: seeds }, (_, i) =>
        engine.call('sim.run', { macro: { ...spec, human: spec.human && { ...spec.human, seed: i + 1 } }, scenario: { ...spec.simulator, seed: i + 1 }, seconds }),
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
    runHistory: () => runHistory(),
    calibrations: calibrations(),
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

// Wick's own updates: the latest GitHub release, compared with this version.
// Wick only links to the release page; installing it stays with the user.
const RELEASES = 'https://github.com/ryduzz1/wick/releases';

const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(Number);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function checkAppUpdate() {
  const response = await fetch('https://api.github.com/repos/ryduzz1/wick/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': `wick/${version}` }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return { version, latest: null, available: false };
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const release = await response.json();
  const latest = String(release.tag_name ?? '').replace(/^v/, '');
  const url = String(release.html_url ?? '').startsWith(RELEASES) ? release.html_url : `${RELEASES}/latest`;
  return { version, latest, available: Boolean(latest) && newer(latest, version), url, notes: String(release.body ?? '').slice(0, 2000) };
}

// Installs waiting for the user to confirm on the install screen.
const pendingInstalls = new Map();

/**
 * Reads a macro from a .wick file or a link and returns what the install
 * screen shows, with a token to confirm it. Nothing is written yet.
 */
async function prepareInstall({ source, macro: which } = {}) {
  let origin;
  let macros;
  if (!/^[a-z]+:\/\//i.test(source) && fs.existsSync(source)) {
    const { files, declaredHash } = sharing.openPackage(fs.readFileSync(source));
    origin = null;
    macros = sharing.macrosIn(files).map((m) => ({ ...m, declaredHash: m.folder === '' ? declaredHash : null }));
  } else {
    const fetched = await sharing.fetchSource(source);
    origin = { kind: fetched.source.kind, url: fetched.source.url };
    macros = fetched.macros;
  }
  if (which != null) macros = macros.filter((m) => m.folder === which);
  if (!macros.length) throw new MacroError('There\'s no Wick macro there.');
  if (macros.length > 1) return { source, choose: macros.map((m) => ({ folder: m.folder, name: JSON.parse(m.files.get('wick.json')).name ?? m.folder })) };
  const [m] = macros;
  const info = sharing.inspect(m.files, { libraryDir: libraryDir(), declaredHash: m.declaredHash });
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingInstalls.clear();
  pendingInstalls.set(token, { files: m.files, source: origin && { ...origin, folder: m.folder } });
  return { token, source: origin?.url ?? path.basename(source), ...info };
}

// wick:// links and .wick files the OS hands to Wick, held until the window is ready.
const openRequests = [];
let rendererReady = false;

function requestInstall(source) {
  if (!source) return;
  if (rendererReady) forward('app.install', { source });
  else openRequests.push(source);
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
}

const installArg = (argv) => argv.find((a) => a.startsWith('wick://') || a.toLowerCase().endsWith('.wick'));

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
  // A fresh profile starts empty: no bundled examples in the sidebar.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const js = (code) => window.webContents.executeJavaScript(code);
  await sleep(2500);
  const shown = await js(`({
    engine: document.getElementById('engineLabel').textContent,
    empty: !document.getElementById('emptyView').classList.contains('hidden'),
    sidebar: document.getElementById('macroList').textContent,
  })`);
  // Exercise the editor: create a macro on the simulator (which needs no
  // window or permissions), let it draw, drag its region, and check a color.
  await js(`document.getElementById('newMacro').click()`);
  await sleep(300);
  await js(`(() => {
    const f = document.getElementById('newForm');
    f.elements.name.value = 'Smoke test';
    f.elements.target.value = 'sim';
    f.querySelector('button[value=create]').click();
  })()`);
  await sleep(2500);
  Object.assign(shown, await js(`({
    target: document.getElementById('crumbTarget').textContent,
    fps: document.getElementById('fpsText').textContent,
    previewDrawn: document.getElementById('liveEmpty').classList.contains('hidden'),
  })`));
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
  // Run the new macro on the simulator briefly: the trace graph should fill.
  await js(`document.getElementById('runButton').click()`);
  await sleep(process.env.WICK_SMOKE_DIALOG === 'trace' ? 6000 : 1500);
  shown.trace = await js(`({ visible: !document.getElementById('traceCard').classList.contains('hidden'), legend: document.getElementById('traceLegend').textContent })`);
  shown.mini = await mini.text();
  if (process.env.WICK_SMOKE_MINI) fs.writeFileSync(process.env.WICK_SMOKE_MINI, (await mini.window.webContents.capturePage()).toPNG());
  shown.onboarding = await js(`!document.getElementById('onboarding').classList.contains('hidden')`);
  if (process.env.WICK_SMOKE_DIALOG !== 'trace') {
    await js(`document.getElementById('stopButton').click()`);
    await sleep(800);
    shown.runs = await js(`document.querySelectorAll('#runList .run-row').length`);
  }
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
  // Sharing: export an example, open it on the install screen, install it,
  // and calibrate a color on the installed copy.
  const pack = path.join(app.getPath('temp'), `wick-smoke-${process.pid}.wick`);
  // The repo's examples aren't in the app; smoke:dist passes their folder.
  sharing.exportMacro(path.join(process.env.WICK_SMOKE_EXAMPLES || path.join(root, 'examples'), 'fishing-trip'), pack);
  forward('app.install', { source: pack });
  await sleep(800);
  shown.install = await js(`({
    open: document.getElementById('installDialog').open,
    name: document.getElementById('installName').textContent,
    badges: [...document.querySelectorAll('#installBadges .badge')].map((b) => b.textContent),
    permissions: document.querySelectorAll('#installPermissions li').length,
    files: document.querySelectorAll('#installFiles details').length,
    button: document.getElementById('installConfirm').textContent,
  })`);
  if (process.env.WICK_SMOKE_DIALOG === 'install') {
    await js(`document.querySelector('#installFiles details:nth-child(3)')?.setAttribute('open', '')`);
  } else {
    await js(`document.getElementById('installConfirm').click()`);
    await sleep(1500);
    shown.installed = await js(`({
      name: document.getElementById('macroName').textContent,
      calibration: !document.getElementById('calibrationCard').classList.contains('hidden'),
      colors: document.querySelectorAll('#calibrationColors .cal-row').length,
    })`);
    const installed = sharing.findInstalled(libraryDir(), 'wick/fishing-trip');
    shown.installed.folder = Boolean(installed && sharing.installInfo(installed));
    if (installed) {
      const id = JSON.parse(fs.readFileSync(path.join(installed, 'wick.json'), 'utf8')).id;
      await js(`document.querySelector('#calibrationColors .cal-row button').click()`);
      await sleep(200);
      await js(`(() => {
        const c = document.getElementById('liveCanvas');
        const b = c.getBoundingClientRect();
        const at = (type) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: b.left + 5, clientY: b.top + 5 }));
        at('pointerdown'); at('pointerup');
      })()`);
      await sleep(800);
      shown.installed.calibrated = Object.keys(calibrations().get(id).colors).length;
      if (process.env.WICK_SMOKE_DIALOG !== 'calibration') calibrations().reset(id);
    }
  }
  fs.rmSync(pack, { force: true });
  if (process.env.WICK_SMOKE_SHOT) {
    if (process.env.WICK_SMOKE_SCROLL) await js(`document.querySelector('main').scrollTop = ${Number(process.env.WICK_SMOKE_SCROLL)}`);
    await sleep(100);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(process.env.WICK_SMOKE_SHOT, image.toPNG());
  }
  const ok = errors.length === 0 && shown.engine === 'Engine running' && shown.empty && !/Examples|Bar minigame/.test(shown.sidebar) && shown.previewDrawn &&
    shown.created === 'Smoke test' && shown.regions.includes('area') && shown.movedRegion?.x > 0 && /^[1-9]\d* px/.test(shown.matches) &&
    shown.cli?.usedApp && shown.cli?.saved && shown.input?.precision === 0.7 && shown.trace?.visible && (process.env.WICK_SMOKE_DIALOG === 'trace' || shown.runs === 1) &&
    /Smoke test/.test(shown.mini ?? '') && /F8 to stop/.test(shown.mini ?? '') && shown.onboarding &&
    shown.install.open && shown.install.name === 'Fishing trip' && shown.install.permissions > 0 && shown.install.files > 3 &&
    (process.env.WICK_SMOKE_DIALOG === 'install' || (shown.installed?.name === 'Fishing trip' && shown.installed.folder && shown.installed.calibration && shown.installed.colors > 0 && shown.installed.calibrated === 1));
  process.stdout.write(`WICK_SMOKE ${JSON.stringify({ ok, shown, errors })}\n`);
  app.exit(ok ? 0 : 1);
}

/** Shows the mini window over the game while a macro runs there (not on the simulator). */
function updateMini(method, params) {
  if (!mini) return;
  if (method === 'macro.state' && params.state === 'running') {
    const target = runningTarget ?? sessionTarget;
    if (miniEnabled() && (target !== 'sim' || smoke)) mini.start({ name: runNames.get(params.id) ?? params.id?.split('/').pop() ?? 'Macro', target });
  } else if (method === 'macro.stats') mini.update({ elapsed: params.elapsed, loops: params.loops ?? null });
  else if (method === 'macro.step') mini.update({ step: params.state });
  else if (method === 'session.stats' && params.target === runningTarget) mini.update({ found: params.found, focused: params.focused });
  else if (method === 'macro.end') mini.end({ ...params.end }, params.elapsed);
}

function showMainWindow() {
  if (!window) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
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
  window.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  window.on('closed', () => {
    window = null;
    rendererReady = false;
    // The hidden mini window would otherwise keep Wick open on Windows.
    if (process.platform !== 'darwin') app.quit();
  });
}

// One Wick at a time: a second launch (from a wick:// link or a .wick file)
// hands its request to the running app. Smoke runs stay independent.
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (event, argv) => requestInstall(installArg(argv.slice(1))));
app.on('open-url', (event, url) => {
  event.preventDefault();
  requestInstall(url);
});
app.on('open-file', (event, file) => {
  if (!file.toLowerCase().endsWith('.wick')) return;
  event.preventDefault();
  requestInstall(file);
});
// Only the packaged app claims wick:// links, so development runs don't
// change which program the system opens them with.
if (app.isPackaged && !smoke) app.setAsDefaultProtocolClient('wick');
const launchRequest = installArg(process.argv.slice(app.isPackaged ? 1 : 2));
if (launchRequest) openRequests.push(launchRequest);

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [{ label: 'Wick', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => forward('app.settings', {}) }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
        : []),
      { label: 'File', submenu: [{ label: 'New Macro…', accelerator: 'CmdOrCtrl+N', click: () => forward('app.newMacro', {}) }, { label: 'Open Macro Folder…', accelerator: 'CmdOrCtrl+O', click: () => forward('app.openMacro', {}) }, { label: 'Install Macro…', accelerator: 'CmdOrCtrl+Shift+I', click: () => forward('app.installMacro', {}) }, { label: 'Open Test Bench', click: openTestBench }, ...(process.platform === 'darwin' ? [] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => forward('app.settings', {}) }]), { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
      { role: 'editMenu' },
      {
        label: 'Macro',
        submenu: [
          { label: 'Run', accelerator: 'CmdOrCtrl+R', click: () => forward('app.run', {}) },
          { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => engine.call('macro.stop').catch(() => {}) },
          { label: 'Test on Simulator', accelerator: 'CmdOrCtrl+T', click: () => forward('app.simulate', {}) },
          { type: 'separator' },
          { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => forward('app.export', {}) },
          { label: 'Check for Updates', click: () => forward('app.checkUpdate', {}) },
          { label: 'Show Folder', accelerator: 'CmdOrCtrl+Shift+R', click: () => forward('app.showFolder', {}) },
          { label: 'Edit Code', accelerator: 'CmdOrCtrl+Shift+E', click: () => forward('app.editCode', {}) },
        ],
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: 'Get Started', click: () => forward('app.onboarding', {}) },
          { label: 'Check for Wick Updates…', click: () => forward('app.checkAppUpdate', {}) },
          { label: 'Wick on GitHub', click: () => shell.openExternal('https://github.com/ryduzz1/wick') },
        ],
      },
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
    const saved = runHistory().onEvent(method, params, runningTarget ?? sessionTarget);
    updateMini(method, params);
    if (method === 'macro.end') runningTarget = null;
    forward(method, params);
    if (saved) forward('runs.saved', { id: params.id });
  });
  engine.on('exit', () => {
    sessionTarget = null;
    sessionKey = null;
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

  mini = new MiniWindow({
    directory,
    position: () => preferences().miniPosition ?? null,
    savePosition: (at) => savePreferences({ miniPosition: at }),
    stop: () => engine.call('macro.stop').catch(() => {}),
    showMain: showMainWindow,
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
    if (!window) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  mini?.destroy();
  globalShortcut.unregisterAll();
  engine.stop();
});
