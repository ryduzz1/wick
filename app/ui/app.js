// Wick's window: macro list, target picker, live view and editor, run
// controls and log.

import { LiveView, parseHex, rectRegion } from './live.js';

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
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/>',
  code: '<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5"/>',
  pointer: '<path d="M4 2.5v10l3-2.8 2 4.3 1.6-.7-2-4.2H13z"/>',
  square: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-dasharray="2.5 2"/>',
  drop: '<path d="M8 2.2S4 6.6 4 9.6a4 4 0 0 0 8 0c0-3-4-7.4-4-7.4z"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  sliders: '<path d="M3 4.5h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.6"/><circle cx="10.5" cy="11.5" r="1.6"/>',
};

const TARGET_LABELS = { sim: 'Simulator', testbench: 'Test bench', roblox: 'Roblox' };
const TARGET_ORDER = ['sim', 'testbench', 'roblox'];
const ANCHORS = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'];
const PERMISSION_LABELS = {
  'mouse.click': 'Click',
  'mouse.move': 'Move the mouse',
  keyboard: 'Press keys',
  'character.reset': 'Reset character',
  'game.rejoin': 'Rejoin the game',
};

const state = {
  macros: [],
  selected: null,
  target: null,
  targets: {},
  running: null,
  lastStats: null,
  sessionStats: null,
  permissions: null,
  selectedRegion: null,
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
const editable = () => Boolean(state.selected?.editable) && !state.running;

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
  renderEditing();
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
  const groups = [
    ['Library', state.macros.filter((m) => m.inLibrary)],
    ['Opened', state.macros.filter((m) => !m.inLibrary && !m.example)],
    ['Examples', state.macros.filter((m) => m.example)],
  ];
  for (const [title, macros] of groups) {
    if (!macros.length) continue;
    const label = document.createElement('div');
    label.className = 'macro-group';
    label.textContent = title;
    list.append(label);
    for (const m of macros) {
      const b = document.createElement('button');
      b.className = 'macro-item';
      if (state.selected?.folder === m.folder) b.classList.add('selected');
      if (state.running?.folder === m.folder) b.classList.add('running');
      b.innerHTML = '<span data-icon="macro"></span><span></span><small></small>';
      b.children[1].textContent = m.name;
      b.children[2].textContent = m.error ? 'problem' : '';
      b.title = m.error ?? m.folder;
      b.onclick = () => select(m);
      list.append(b);
    }
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

function renderHeader(m) {
  $('macroName').textContent = m.name;
  $('macroDescription').textContent = m.error ? `Problem: ${m.error}` : m.description || (m.editable ? 'No description yet.' : '');
  $('crumbMacro').textContent = m.name;
  $('runButton').disabled = Boolean(m.error);
  $('copyButton').classList.toggle('hidden', m.editable);
  $('editCode').classList.toggle('hidden', !m.editable);
}

function renderDetails(m) {
  const form = $('detailsForm');
  form.elements.name.value = m.name ?? '';
  form.elements.description.value = m.description ?? '';
  form.elements.target.value = m.target ?? 'roblox';
  const boxes = $('permissionBoxes');
  boxes.replaceChildren();
  for (const [id, label] of Object.entries(PERMISSION_LABELS)) {
    const l = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = Boolean(m.permissions?.includes(id));
    input.disabled = !editable();
    input.onchange = () => saveDetails();
    l.append(input, document.createTextNode(label));
    boxes.append(l);
  }
  $('macroId').textContent = m.id ?? '';
  $('deleteMacro').textContent = m.inLibrary ? 'Move to Trash' : 'Remove from list';
  $('deleteMacro').classList.toggle('hidden', m.example);
  $('detailsNote').textContent = m.example
    ? 'Examples come with Wick and can\'t be changed. Make a copy to edit it.'
    : m.inLibrary ? m.folder : `Opened from ${m.folder}. Removing it from the list leaves the folder alone.`;
}

async function saveDetails() {
  const m = state.selected;
  if (!m?.editable) return;
  const form = $('detailsForm');
  const changes = {
    name: form.elements.name.value.trim() || m.name,
    description: form.elements.description.value.trim(),
    target: form.elements.target.value,
    permissions: [...$('permissionBoxes').querySelectorAll('input:checked')].map((i) => i.value),
  };
  try {
    const updated = await call('updateManifest', { folder: m.folder, changes });
    Object.assign(m, updated, { values: m.values });
    renderHeader(m);
    renderMacroList();
  } catch (e) {
    toast('Couldn\'t save', e.message, 'error');
  }
}

function renderEditing() {
  const can = editable();
  for (const el of $('detailsForm').elements) el.disabled = !can;
  $('deleteMacro').disabled = Boolean(state.running);
  $('addRegion').classList.toggle('hidden', !can);
  $('toolAdd').classList.toggle('hidden', !can);
  live.setRegions(state.selected?.regions ?? {}, can);
  if (!can && live.mode === 'add') setTool('select');
  $('regionsHint').textContent = !state.selected
    ? ''
    : state.running
      ? 'Stop the macro to change regions.'
      : state.selected.editable
        ? 'Drag a region on the live view to move it, or its corners to resize it. Positions are kept relative to the anchor, so they hold on other screen sizes.'
        : 'Examples can\'t be changed. Make a copy to edit its regions.';
  renderRegions();
}

async function select(m) {
  if (state.running && state.running.folder !== m.folder) {
    toast('A macro is running', 'Stop it before switching to another macro.');
    return;
  }
  state.selected = m;
  renderHeader(m);
  $('simResults').classList.add('hidden');
  renderSettings(m);
  renderDetails(m);
  live.select(null);
  renderEditing();
  renderMacroList();
  updateSnippet();
  $('emptyView').classList.add('hidden');
  $('macroView').classList.remove('hidden');
  call('watchMacro', { folder: m.folder }).catch(() => {});
  if (!state.target) await chooseTarget(TARGET_ORDER.includes(m.target) ? m.target : 'sim');
}

/** Picks up changes made outside the app, by an editor or an agent. */
async function reloadSelected() {
  const m = state.selected;
  if (!m || live.drag) return;
  try {
    const fresh = await call('describe', { folder: m.folder });
    Object.assign(m, fresh);
    renderHeader(m);
    renderSettings(m);
    if (!document.activeElement?.closest('#detailsForm')) renderDetails(m);
    renderEditing();
    renderMacroList();
  } catch {
    await loadMacros();
  }
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

// MARK: Live view and regions

const live = new LiveView($('liveCanvas'), {
  onSelect(name) {
    state.selectedRegion = name;
    renderRegions();
    updateSnippet();
  },
  onRegionsChange(regions, added) {
    saveRegions(regions);
    if (added) setTimeout(() => document.querySelector(`.region-row[data-name="${added}"] input`)?.select(), 50);
  },
  onPick(hex) {
    setColor(hex);
    setTool('select');
  },
  onHover(hex) {
    $('hoverText').textContent = hex ?? '';
  },
  onMode(mode) {
    for (const [id, m] of [['toolSelect', 'select'], ['toolAdd', 'add'], ['toolPick', 'pick']]) $(id).setAttribute('aria-pressed', String(mode === m));
    if (mode !== 'pick') $('hoverText').textContent = '';
  },
  onMatches(m) {
    const pill = $('matchText');
    pill.classList.toggle('hidden', !m);
    if (m) pill.textContent = `${m.pixels} px · ${pct(m.coverage)} of ${m.area}`;
  },
});

const setTool = (mode) => live.setMode(mode);

function decode(base64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(base64);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function clearLive() {
  live.clear();
  $('liveEmpty').classList.remove('hidden');
  const t = state.target;
  $('liveEmptyTitle').textContent = t ? `Looking for ${TARGET_LABELS[t]}…` : 'Pick a target';
  $('liveEmptyText').textContent =
    t === 'testbench' ? 'Open the test bench from the top bar.' : t === 'roblox' ? 'Open Roblox and join a game.' : '';
}

function drawPreview(p) {
  if (p.target !== state.target) return;
  $('liveEmpty').classList.add('hidden');
  live.setPreview(p, decode(p.rgba));
}

let saveTimer = null;
function saveRegions(regions) {
  const m = state.selected;
  if (!m?.editable) return;
  m.regions = structuredClone(regions);
  renderRegions();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      m.regions = await call('saveRegions', { folder: m.folder, regions: m.regions });
      live.setRegions(m.regions, editable());
      renderRegions();
    } catch (e) {
      toast('Couldn\'t save regions', e.message, 'error');
    }
  }, 150);
}

const fmtRegion = (r) => `x ${r.x} · y ${r.y} · w ${r.w} · h ${r.h}`;

function renderRegions() {
  const list = $('regionList');
  const regions = state.selected?.regions ?? {};
  const can = editable();
  if (list.contains(document.activeElement) && list.children.length === Object.keys(regions).length) {
    // Don't rebuild under the user's cursor; just refresh the numbers.
    for (const row of list.children) {
      const r = regions[row.dataset.name];
      if (r) row.querySelector('small').textContent = fmtRegion(r);
      row.classList.toggle('selected', row.dataset.name === state.selectedRegion);
    }
    return;
  }
  list.replaceChildren();
  for (const [name, r] of Object.entries(regions)) {
    const row = document.createElement('div');
    row.className = 'region-row';
    row.dataset.name = name;
    row.classList.toggle('selected', name === state.selectedRegion);
    const input = document.createElement('input');
    input.value = name;
    input.disabled = !can;
    input.setAttribute('aria-label', 'Region name');
    input.onchange = () => renameRegion(name, input.value.trim());
    const anchor = document.createElement('select');
    anchor.disabled = !can;
    anchor.setAttribute('aria-label', 'Anchor');
    anchor.title = 'The point on the game window this region is positioned from';
    for (const a of ANCHORS) anchor.add(new Option(a, a, false, a === (r.anchor ?? 'center')));
    anchor.onchange = () => reanchor(name, anchor.value);
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = `Delete ${name}`;
    remove.innerHTML = '<span data-icon="close"></span>';
    remove.classList.toggle('hidden', !can);
    remove.onclick = (e) => {
      e.stopPropagation();
      const next = { ...regions };
      delete next[name];
      live.select(null);
      live.setRegions(next, can);
      saveRegions(next);
    };
    const info = document.createElement('small');
    info.textContent = fmtRegion(r);
    row.append(input, anchor, remove, info);
    row.onclick = () => live.select(name);
    list.append(row);
  }
  icons(list);
}

function renameRegion(from, to) {
  const regions = state.selected?.regions ?? {};
  if (!to || to === from) return renderRegions();
  if (regions[to]) {
    toast('That name is taken', `There's already a region called "${to}".`);
    return renderRegions();
  }
  const next = {};
  for (const [k, v] of Object.entries(regions)) next[k === from ? to : k] = v;
  live.setRegions(next, editable());
  live.select(to);
  saveRegions(next);
  updateSnippet();
}

/** Changes a region's anchor without moving it on screen. */
function reanchor(name, anchor) {
  const regions = state.selected?.regions ?? {};
  const moved = live.preview ? rectRegion(live.rectOf(name), anchor, live.viewport, live.aspect) : { ...regions[name], anchor };
  const next = { ...regions, [name]: moved };
  live.setRegions(next, editable());
  saveRegions(next);
}

// MARK: Color

function setColor(hex, { typed = false } = {}) {
  const rgb = parseHex(hex);
  if (!typed) $('colorHex').value = rgb ? hex.toLowerCase() : hex;
  $('colorSwatch').style.background = rgb ? hex : '';
  live.setColor(rgb ? { hex, tolerance: Number($('tolerance').value) } : null);
  updateSnippet();
}

function updateSnippet() {
  const hex = parseHex($('colorHex').value) ? $('colorHex').value.toLowerCase() : '#ffffff';
  const region = state.selectedRegion ?? Object.keys(state.selected?.regions ?? {})[0] ?? 'area';
  $('snippet').textContent = `screen.track("${region}", { color: "${hex}", tolerance: ${$('tolerance').value} })`;
}

// MARK: Stats

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
  const keep = state.selected && state.macros.find((m) => m.folder === state.selected.folder);
  state.selected = null;
  renderMacroList();
  if (!state.macros.length) {
    $('emptyView').classList.remove('hidden');
    $('macroView').classList.add('hidden');
  } else {
    await select(keep ?? state.macros[0]);
  }
}

async function showMacro(folder) {
  if (state.running) return;
  state.macros = await call('macros');
  state.selected = null;
  await select(state.macros.find((x) => x.folder === folder) ?? state.macros[0]);
}

async function openMacro() {
  try {
    const m = await call('openMacro');
    if (m) await showMacro(m.folder);
  } catch (e) {
    toast('Couldn\'t open that folder', e.message, 'error');
  }
}

async function newMacro() {
  if (state.running) {
    toast('A macro is running', 'Stop it before creating another one.');
    return;
  }
  const dialog = $('newDialog');
  const form = $('newForm');
  form.reset();
  form.elements.target.value = 'roblox';
  const info = await call('libraryInfo').catch(() => null);
  $('newWhere').textContent = info ? `Saved in ${info.folder}` : '';
  dialog.showModal();
  form.elements.name.focus();
}

$('newDialog').onclose = async () => {
  if ($('newDialog').returnValue !== 'create') return;
  const form = $('newForm');
  try {
    const m = await call('newMacro', { name: form.elements.name.value, target: form.elements.target.value });
    await showMacro(m.folder);
    log(`Created ${m.name} in your library.`);
  } catch (e) {
    toast('Couldn\'t create the macro', e.message, 'error');
  }
};

async function openSettings() {
  const form = $('settingsDialogForm');
  const [input, info] = await Promise.all([call('inputPreferences'), call('libraryInfo').catch(() => null)]);
  form.elements.human.checked = input.human;
  form.elements.precision.value = Math.round(input.precision * 100);
  renderPrecision();
  $('libraryFolder').textContent = info?.folder ?? '';
  $('settingsDialog').showModal();
}

function renderPrecision() {
  const form = $('settingsDialogForm');
  $('precisionText').textContent = form.elements.precision.value;
  form.elements.precision.disabled = !form.elements.human.checked;
  $('precisionLabel').classList.toggle('disabled', !form.elements.human.checked);
}

$('settingsDialogForm').oninput = async () => {
  renderPrecision();
  const form = $('settingsDialogForm');
  try {
    await call('saveInputPreferences', { human: form.elements.human.checked, precision: Number(form.elements.precision.value) / 100 });
  } catch (e) {
    toast('Couldn\'t save settings', e.message, 'error');
  }
};

$('chooseLibrary').onclick = async () => {
  try {
    const chosen = await call('chooseLibrary');
    if (!chosen) return;
    $('libraryFolder').textContent = chosen.folder;
    if (!state.running) await loadMacros();
  } catch (e) {
    toast('Couldn\'t change the library', e.message, 'error');
  }
};

$('showLibrary').onclick = async () => {
  const info = await call('libraryInfo').catch(() => null);
  if (info) call('showFolder', { folder: info.folder, create: true });
};

async function copySelected() {
  const m = state.selected;
  if (!m || state.running) return;
  try {
    const copy = await call('copyMacro', { folder: m.folder });
    await showMacro(copy.folder);
    toast('Copied to your library', `${copy.name} is yours to edit.`);
  } catch (e) {
    toast('Couldn\'t copy the macro', e.message, 'error');
  }
}

async function deleteSelected() {
  const m = state.selected;
  if (!m || state.running) return;
  try {
    if (!(await call('deleteMacro', { folder: m.folder }))) return;
    state.selected = null;
    await call('watchMacro', {});
    await loadMacros();
  } catch (e) {
    toast('Couldn\'t remove the macro', e.message, 'error');
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
    case 'macro.changed':
      if (params.folder === state.selected?.folder) reloadSelected();
      break;
    case 'killswitch': {
      const chip = $('killChip');
      chip.classList.add('fired');
      setTimeout(() => chip.classList.remove('fired'), 1200);
      if (state.running) toast('Kill switch', 'Every macro was stopped.');
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
    case 'app.newMacro':
      newMacro();
      break;
    case 'app.settings':
      openSettings();
      break;
    case 'agent.target':
      if (!state.running && params.target !== state.target) {
        state.target = params.target;
        renderTargets();
        clearLive();
      }
      break;
    case 'agent.log':
      log(params.text);
      break;
    case 'agent.library':
      showMacro(params.folder);
      break;
    case 'agent.run': {
      const m = state.macros.find((x) => x.folder === params.folder);
      if (m && state.selected?.folder !== m.folder) select(m);
      state.target = params.target;
      renderTargets();
      state.running = { folder: params.folder, target: params.target };
      state.lastStats = null;
      setRunState('running', 'Started by an agent');
      log(`An agent started ${m?.name ?? 'a macro'} on ${TARGET_LABELS[params.target]}.`);
      break;
    }
  }
});

const mod = wick.platform === 'darwin' ? '⌘' : 'Ctrl';
$('openShortcut').textContent = `${mod} O`;
$('newShortcut').textContent = `${mod} N`;
$('newMacro').onclick = newMacro;
$('settingsShortcut').textContent = `${mod} ,`;
$('openSettings').onclick = openSettings;
$('emptyNew').onclick = newMacro;
$('openMacro').onclick = openMacro;
$('runButton').onclick = run;
$('stopButton').onclick = () => call('stop').catch((e) => toast('Couldn\'t stop', e.message, 'error'));
$('killChip').onclick = () => call('killswitch');
$('simulateButton').onclick = simulate;
$('copyButton').onclick = copySelected;
$('editCode').onclick = () => state.selected && call('editCode', { folder: state.selected.folder });
$('openBench').onclick = () => call('openTestBench');
$('showFolder').onclick = () => state.selected && call('showFolder', { folder: state.selected.folder });
$('clearLog').onclick = () => $('runLog').replaceChildren();
$('openPermissionSettings').onclick = () => call('openPrivacySettings', { pane: state.settingsPane });
$('restartApp').onclick = () => call('restart');
$('deleteMacro').onclick = deleteSelected;
$('detailsForm').onchange = (e) => {
  if (!e.target.closest('#permissionBoxes')) saveDetails();
};
$('detailsForm').onsubmit = (e) => e.preventDefault();

$('toolSelect').onclick = () => setTool('select');
$('toolAdd').onclick = () => setTool('add');
$('toolPick').onclick = () => setTool('pick');
$('pickButton').onclick = () => setTool('pick');
$('addRegion').onclick = () => setTool('add');
$('showRegions').onchange = (e) => live.setLayer('regions', e.target.checked);
$('showMatches').onchange = (e) => live.setLayer('matches', e.target.checked);
$('showTrackers').onchange = (e) => live.setLayer('trackers', e.target.checked);
$('colorHex').oninput = () => {
  const v = $('colorHex').value.trim();
  setColor(v.startsWith('#') ? v : `#${v}`, { typed: true });
};
$('tolerance').oninput = () => {
  $('toleranceText').textContent = $('tolerance').value;
  const hex = $('colorHex').value;
  if (parseHex(hex)) live.setColor({ hex, tolerance: Number($('tolerance').value) });
  updateSnippet();
};
$('copySnippet').onclick = () => navigator.clipboard.writeText($('snippet').textContent).then(() => toast('Copied', $('snippet').textContent));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && live.mode !== 'select') setTool('select');
});

icons();
clearLive();
updateSnippet();
setInterval(() => {
  if (!state.running) call('status').then((s) => {
    for (const t of s.targets) state.targets[t.id] = t;
    renderTargets();
  }).catch(() => {});
}, 3000);
await refreshStatus();
await loadMacros();
