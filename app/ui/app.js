// Wick's window: macro list, target picker, live view, run controls and log.

const $ = (id) => document.getElementById(id);
const wick = window.wick;

const ICONS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  monitor: '<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 14h4M8 11v3"/>',
  flask: '<path d="M6 2h4M7 2v4L3.5 12.5A1 1 0 0 0 4.4 14h7.2a1 1 0 0 0 .9-1.5L9 6V2"/><path d="M5 10h6"/>',
  bolt: '<path d="M9 2 4 9h4l-1 5 5-7H8z"/>',
  macro: '<path d="M3 4h10M3 8h6M3 12h8"/>',
};

const TARGET_LABELS = { sim: 'Simulator', testbench: 'Test bench', roblox: 'Roblox' };
const TARGET_ORDER = ['sim', 'testbench', 'roblox'];

const state = {
  macros: [],
  selected: null,
  target: null,
  targets: {},
  running: null,
  lastStats: null,
  sessionStats: null,
  permissions: null,
};

function icons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.dataset.icon;
    if (!ICONS[name] || el.dataset.iconDone) continue;
    el.dataset.iconDone = '1';
    el.outerHTML = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  }
}

async function call(action, data) {
  const result = await wick.call(action, data);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function toast(title, text = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = '<b></b><p></p>';
  el.querySelector('b').textContent = title;
  el.querySelector('p').textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4500);
}

function log(text, kind = '') {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const span = document.createElement('span');
  span.textContent = text;
  if (kind) span.className = kind;
  li.append(time, span);
  const list = $('runLog');
  list.append(li);
  while (list.children.length > 300) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

const fmtSeconds = (ms) => {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;

// MARK: Run state

function setRunState(kind, label) {
  const dot = $('stateDot');
  dot.className = `dot ${kind === 'running' ? 'ember pulse' : kind === 'waiting' ? 'pulse' : kind === 'paused' ? 'ember' : kind === 'done' ? 'on' : kind === 'error' ? 'red' : ''}`;
  $('stateLabel').textContent = label;
  const running = kind === 'running' || kind === 'paused' || kind === 'waiting';
  $('runButton').classList.toggle('hidden', running);
  $('stopButton').classList.toggle('hidden', !running);
  for (const b of $('targetPicker').querySelectorAll('button')) b.disabled = running;
  renderMacroList();
}

function refreshRunLabel() {
  if (!state.running) return;
  const s = state.sessionStats;
  const elapsed = state.lastStats ? fmtSeconds(state.lastStats.elapsed) : '0s';
  if (s && !s.found) setRunState('waiting', `Waiting for ${TARGET_LABELS[state.target]}`);
  else if (s && !s.focused) setRunState('paused', `Paused: click the ${TARGET_LABELS[state.target]} window so it has focus`);
  else setRunState('running', `Running · ${elapsed}`);
}

// MARK: Macro list and selection

function renderMacroList() {
  const list = $('macroList');
  list.replaceChildren();
  for (const m of state.macros) {
    const b = document.createElement('button');
    b.className = 'macro-item';
    if (state.selected?.folder === m.folder) b.classList.add('selected');
    if (state.running?.folder === m.folder) b.classList.add('running');
    b.innerHTML = '<span data-icon="macro"></span><span></span><small></small>';
    b.children[1].textContent = m.name;
    b.children[2].textContent = m.example ? 'example' : '';
    b.title = m.error ?? m.folder;
    b.onclick = () => select(m);
    list.append(b);
  }
  icons(list);
}

function renderTargets() {
  const picker = $('targetPicker');
  picker.replaceChildren();
  for (const id of TARGET_ORDER) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.target === id));
    const info = state.targets[id];
    const dot = document.createElement('span');
    dot.className = `dot ${info?.found ? 'on' : ''}`;
    b.append(dot, document.createTextNode(TARGET_LABELS[id]));
    b.title = info?.found ? `${TARGET_LABELS[id]} found` : `${TARGET_LABELS[id]} isn't open`;
    b.disabled = Boolean(state.running);
    b.onclick = () => chooseTarget(id);
    picker.append(b);
  }
  $('crumbTarget').textContent = state.target ? TARGET_LABELS[state.target] : 'No target';
}

function renderSettings(m) {
  const form = $('settingsForm');
  form.replaceChildren();
  const entries = Object.entries(m.settings ?? {});
  $('noSettings').classList.toggle('hidden', entries.length > 0);
  for (const [key, s] of entries) {
    const label = document.createElement('label');
    const value = m.values?.[key] ?? s.default;
    const input = document.createElement('input');
    input.name = key;
    if (s.type === 'boolean') {
      label.className = 'checkbox';
      input.type = 'checkbox';
      input.checked = Boolean(value);
      label.append(input, document.createTextNode(s.label ?? key));
    } else {
      input.type = s.type === 'string' ? 'text' : 'number';
      if (s.type === 'integer') input.step = '1';
      if (typeof s.min === 'number') input.min = s.min;
      if (typeof s.max === 'number') input.max = s.max;
      input.value = value ?? '';
      label.append(document.createTextNode(s.label ?? key), input);
    }
    input.onchange = () => saveSettings();
    form.append(label);
  }
}

function currentSettings() {
  const out = {};
  for (const input of $('settingsForm').elements) {
    if (!input.name) continue;
    out[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  return out;
}

async function saveSettings() {
  const m = state.selected;
  if (!m) return;
  m.values = currentSettings();
  await call('saveSettings', { id: m.id, values: m.values });
}

async function select(m) {
  if (state.running && state.running.folder !== m.folder) {
    toast('A macro is running', 'Stop it before switching to another macro.', 'warning');
    return;
  }
  state.selected = m;
  $('macroName').textContent = m.name;
  $('macroDescription').textContent = m.error ? `Problem: ${m.error}` : m.description;
  $('crumbMacro').textContent = m.name;
  $('runButton').disabled = Boolean(m.error);
  $('simResults').classList.add('hidden');
  renderSettings(m);
  renderMacroList();
  $('emptyView').classList.add('hidden');
  $('macroView').classList.remove('hidden');
  if (!state.target) await chooseTarget(TARGET_ORDER.includes(m.target) ? m.target : 'sim');
}

async function chooseTarget(id) {
  state.target = id;
  renderTargets();
  clearLive();
  try {
    await call('watch', { target: id });
  } catch (e) {
    toast('Couldn\'t watch that target', e.message, 'error');
  }
}

// MARK: Live view

const canvas = $('liveCanvas');
const g = canvas.getContext('2d');
const scratch = document.createElement('canvas');

function decode(base64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(base64);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function clearLive() {
  g.fillStyle = '#111';
  g.fillRect(0, 0, canvas.width, canvas.height);
  $('liveEmpty').classList.remove('hidden');
  const t = state.target;
  $('liveEmptyTitle').textContent = t ? `Looking for ${TARGET_LABELS[t]}…` : 'Pick a target';
  $('liveEmptyText').textContent =
    t === 'testbench' ? 'Open the test bench from the top bar.' : t === 'roblox' ? 'Open Roblox and join a game.' : '';
}

function drawPreview(p) {
  if (p.target !== state.target) return;
  $('liveEmpty').classList.add('hidden');
  scratch.width = p.width;
  scratch.height = p.height;
  const image = new ImageData(new Uint8ClampedArray(decode(p.rgba).buffer), p.width, p.height);
  scratch.getContext('2d').putImageData(image, 0, 0);
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // Letterbox the frame inside the 16:9 view.
  const scale = Math.min(w / p.width, h / p.height);
  const fw = p.width * scale;
  const fh = p.height * scale;
  const ox = (w - fw) / 2;
  const oy = (h - fh) / 2;
  g.fillStyle = '#111';
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.drawImage(scratch, ox, oy, fw, fh);
  const X = (fx) => ox + fx * fw;
  const Y = (fy) => oy + fy * fh;
  const overlay = p.overlay;
  if (overlay && $('showRegions').checked) {
    g.save();
    g.setLineDash([6 * dpr, 4 * dpr]);
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = 'rgba(255,255,255,.8)';
    g.font = `${11 * dpr}px ui-monospace, monospace`;
    for (const r of overlay.regions) {
      g.strokeRect(X(r.rect.x), Y(r.rect.y), r.rect.w * fw, r.rect.h * fh);
      const tw = g.measureText(r.name).width + 8 * dpr;
      g.fillStyle = 'rgba(0,0,0,.7)';
      g.fillRect(X(r.rect.x), Y(r.rect.y) - 16 * dpr, tw, 15 * dpr);
      g.fillStyle = '#fff';
      g.fillText(r.name, X(r.rect.x) + 4 * dpr, Y(r.rect.y) - 5 * dpr);
    }
    g.restore();
  }
  if (overlay && $('showTrackers').checked) {
    g.save();
    g.lineWidth = 1.5 * dpr;
    for (const t of overlay.trackers) {
      if (!t.seen) continue;
      g.strokeStyle = '#f08a4b';
      g.strokeRect(X(t.left), Y(t.top), (t.right - t.left) * fw, (t.bottom - t.top) * fh);
      const cx = X(t.x);
      const cy = Y(t.y);
      g.beginPath();
      g.moveTo(cx - 6 * dpr, cy);
      g.lineTo(cx + 6 * dpr, cy);
      g.moveTo(cx, cy - 6 * dpr);
      g.lineTo(cx, cy + 6 * dpr);
      g.stroke();
    }
    g.restore();
  }
}

function showSessionStats(s) {
  state.sessionStats = s;
  state.targets[s.target] = { ...state.targets[s.target], found: s.found };
  $('fpsText').textContent = `${s.fps.toFixed(0)} fps`;
  $('tickText').textContent = `${s.tickMs.toFixed(2)} ms/tick`;
  $('latencyText').textContent = `${Math.round(s.latency * 1000)} ms latency`;
  $('windowText').textContent = s.window ? `${Math.round(s.window.width)} × ${Math.round(s.window.height)}` : '';
  if (!s.found && s.target === state.target) clearLive();
  if (s.error) $('liveEmptyText').textContent = s.error;
  refreshRunLabel();
}

function showMacroStats(m) {
  state.lastStats = m;
  $('tileElapsed').textContent = fmtSeconds(m.elapsed);
  $('tileInputs').textContent = String(m.inputs);
  $('tileDropped').textContent = String(m.dropped);
  $('tileScore').textContent = m.score ? pct(m.score.inZone) : '—';
  refreshRunLabel();
}

// MARK: Actions

async function run() {
  const m = state.selected;
  if (!m || !state.target) return;
  try {
    await saveSettings();
    state.running = { folder: m.folder, target: state.target };
    state.lastStats = null;
    setRunState('running', 'Starting…');
    log(`Started on ${TARGET_LABELS[state.target]}.`);
    await call('run', { folder: m.folder, target: state.target, settings: currentSettings() });
  } catch (e) {
    state.running = null;
    setRunState('error', 'Couldn\'t start');
    log(e.message, 'error');
    toast('Couldn\'t start the macro', e.message, 'error');
  }
}

function ended(params) {
  if (!state.running) return;
  state.running = null;
  const end = params.end ?? {};
  const score = params.score ? `, ${pct(params.score.inZone)} in zone` : '';
  if (end.reason === 'done') {
    setRunState('done', `Done · ${fmtSeconds(params.elapsed)}${score}`);
    log(`Finished after ${fmtSeconds(params.elapsed)}${score}.`, 'good');
  } else if (end.reason === 'error') {
    setRunState('error', 'Stopped by an error');
    log(end.error, 'error');
    toast('The macro stopped with an error', end.error.split('\n')[0], 'error');
  } else {
    const why = end.detail === 'kill switch' ? 'Stopped by the kill switch' : 'Stopped';
    setRunState('stopped', `${why} · ${fmtSeconds(params.elapsed)}${score}`);
    log(`${why} after ${fmtSeconds(params.elapsed)}${score}.`);
  }
}

async function simulate() {
  const m = state.selected;
  if (!m) return;
  const button = $('simulateButton');
  button.disabled = true;
  button.lastChild.textContent = 'Testing…';
  try {
    const runs = await call('simulate', { folder: m.folder, settings: currentSettings(), seeds: 5, seconds: 30 });
    const rows = $('simRows');
    rows.replaceChildren();
    const scores = runs.map((r) => r.score.inZone);
    for (const [i, r] of runs.entries()) {
      const el = document.createElement('div');
      el.className = 'sim-row';
      el.innerHTML = '<b></b><span></span>';
      el.querySelector('b').textContent = pct(r.score.inZone);
      el.querySelector('span').textContent = r.end.reason === 'error' ? 'error' : `game ${i + 1} · ${r.score.clicks} clicks`;
      rows.append(el);
    }
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    $('simSummary').textContent = `average ${pct(avg)} in zone`;
    $('simResults').classList.remove('hidden');
    const failed = runs.find((r) => r.end.reason === 'error');
    if (failed) log(failed.end.error, 'error');
    else log(`Simulator test: ${pct(avg)} in zone on average over ${runs.length} games.`, 'good');
  } catch (e) {
    toast('Simulator test failed', e.message, 'error');
  } finally {
    button.disabled = false;
    button.lastChild.textContent = 'Test on simulator';
  }
}

async function refreshStatus() {
  try {
    const s = await call('status');
    $('appVersion').textContent = s.appVersion;
    $('engineDot').className = 'dot on';
    $('engineLabel').textContent = 'Engine running';
    $('engineSub').textContent = `${s.engine.version} · ${s.engine.platform}`;
    for (const t of s.targets) state.targets[t.id] = t;
    state.permissions = s.permissions;
    const missing = [];
    if (!s.permissions.screenRecording) missing.push('Screen Recording (to see the game window)');
    if (!s.permissions.accessibility) missing.push('Accessibility (to click, press keys and catch F8 from any app)');
    const needed = wick.platform === 'darwin' && missing.length > 0;
    $('permissionNotice').classList.toggle('hidden', !needed);
    $('permissionText').textContent =
      `Wick asked macOS for ${missing.join(' and ')}. Turn on Electron (or Wick) in System Settings, then restart Wick so the change applies. The simulator works without them.`;
    state.settingsPane = !s.permissions.screenRecording ? 'screen' : 'accessibility';
    clearTimeout(state.permissionTimer);
    if (needed) state.permissionTimer = setTimeout(refreshStatus, 3000);
    $('killChip').title = s.permissions.hotkey.active
      ? 'Stops every macro. Works from any app.'
      : 'Stops every macro. F8 works while Wick is open; grant Accessibility so it works from any app.';
    renderTargets();
  } catch {
    $('engineDot').className = 'dot red';
    $('engineLabel').textContent = 'Engine not running';
    $('engineSub').textContent = 'Restarting…';
  }
}

async function loadMacros() {
  state.macros = await call('macros');
  renderMacroList();
  if (!state.macros.length) {
    $('emptyView').classList.remove('hidden');
    $('macroView').classList.add('hidden');
  } else if (!state.selected) {
    await select(state.macros[0]);
  }
}

async function openMacro() {
  try {
    const m = await call('openMacro');
    if (!m) return;
    await loadMacros();
    await select(state.macros.find((x) => x.folder === m.folder) ?? m);
  } catch (e) {
    toast('Couldn\'t open that folder', e.message, 'error');
  }
}

// MARK: Wiring

wick.onEvent((method, params) => {
  switch (method) {
    case 'preview':
      drawPreview(params);
      break;
    case 'session.stats':
      if (params.target === state.target) showSessionStats(params);
      break;
    case 'macro.stats':
      showMacroStats(params);
      break;
    case 'macro.log':
      log(params.text);
      break;
    case 'macro.end':
      showMacroStats(params);
      ended(params);
      break;
    case 'killswitch': {
      const chip = $('killChip');
      chip.classList.add('fired');
      setTimeout(() => chip.classList.remove('fired'), 1200);
      if (state.running) toast('Kill switch', 'Every macro was stopped.', 'warning');
      break;
    }
    case 'engine.ready':
      refreshStatus();
      if (state.target) chooseTarget(state.target);
      break;
    case 'engine.exit':
      if (state.running) ended({ end: { reason: 'error', error: 'The engine stopped unexpectedly.' }, elapsed: 0 });
      refreshStatus();
      break;
    case 'app.openMacro':
      openMacro();
      break;
  }
});

$('openShortcut').textContent = wick.platform === 'darwin' ? '⌘ O' : 'Ctrl O';
$('openMacro').onclick = openMacro;
$('runButton').onclick = run;
$('stopButton').onclick = () => call('stop').catch((e) => toast('Couldn\'t stop', e.message, 'error'));
$('killChip').onclick = () => call('killswitch');
$('simulateButton').onclick = simulate;
$('openBench').onclick = () => call('openTestBench');
$('showFolder').onclick = () => state.selected && call('showFolder', { folder: state.selected.folder });
$('clearLog').onclick = () => $('runLog').replaceChildren();
$('openPermissionSettings').onclick = () => call('openPrivacySettings', { pane: state.settingsPane });
$('restartApp').onclick = () => call('restart');

icons();
clearLive();
setInterval(() => {
  if (!state.running) call('status').then((s) => {
    for (const t of s.targets) state.targets[t.id] = t;
    renderTargets();
  }).catch(() => {});
}, 3000);
await refreshStatus();
await loadMacros();
