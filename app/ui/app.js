// Wick's window: macro list, target picker, live view and editor, run
// controls and log.

import { LiveView, parseHex, rectRegion } from './live.js';
import { TraceGraph } from './trace.js';

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
  download: '<path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7"/><path d="M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11"/>',
  share: '<path d="M8 10V2.5M4.8 5.5 8 2.3l3.2 3.2"/><path d="M5.5 7.5H4A1.5 1.5 0 0 0 2.5 9v3.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V9A1.5 1.5 0 0 0 12 7.5h-1.5"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>',
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
  // The macro color being calibrated with the picker, if any.
  pickFor: null,
  // The install screen's pending install.
  install: null,
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
const editable = () => Boolean(state.selected) && !state.running;
// Installed macros can be moved and resized to fit (as calibration), but
// their regions aren't added, renamed or removed: that's the author's code.
const reshapeable = () => editable() && !state.selected.installed;

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
  else setRunState('running', `Running · ${elapsed}${state.step ? ` · ${state.step}` : ''}`);
}

// MARK: Macro list and selection

function renderMacroList() {
  const list = $('macroList');
  list.replaceChildren();
  const groups = [
    ['Library', state.macros.filter((m) => m.inLibrary)],
    ['Opened', state.macros.filter((m) => !m.inLibrary)],
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
      b.children[2].textContent = m.error ? 'problem' : m.installed && m.version ? `v${m.version}` : '';
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
  $('macroDescription').textContent = m.error ? `Problem: ${m.error}` : m.description || 'No description yet.';
  $('crumbMacro').textContent = m.name;
  $('runButton').disabled = Boolean(m.error);
  $('updateButton').classList.toggle('hidden', !m.source?.url);
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
  $('detailsNote').textContent = m.installed ? `Installed${m.source?.url ? ` from ${m.source.url}` : ''}${m.author ? `, by ${m.author}` : ''}. ${m.folder}`
      : m.inLibrary ? m.folder : `Opened from ${m.folder}. Removing it from the list leaves the folder alone.`;
}

async function saveDetails() {
  const m = state.selected;
  if (!m) return;
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
  $('addRegion').classList.toggle('hidden', !reshapeable());
  $('toolAdd').classList.toggle('hidden', !reshapeable());
  live.setRegions(state.selected?.regions ?? {}, can);
  if (!can && live.mode === 'add') setTool('select');
  $('regionsHint').textContent = !state.selected
    ? ''
    : state.running
      ? 'Stop the macro to change regions.'
      : state.selected.installed
        ? 'Drag a region on the live view to fit your screen. Your changes are kept as calibration: updates don\'t overwrite them and exports leave them out.'
        : 'Drag a region on the live view to move it, or its corners to resize it. Positions are kept relative to the anchor, so they hold on other screen sizes.';
  renderRegions();
  renderCalibration();
}

async function select(m) {
  if (state.running && state.running.folder !== m.folder) {
    toast('A macro is running', 'Stop it before switching to another macro.');
    return;
  }
  if (state.selected?.folder !== m.folder && !state.running) {
    trace.clear();
    $('traceCard').classList.add('hidden');
  }
  state.selected = m;
  renderHeader(m);
  $('simResults').classList.add('hidden');
  loadRuns();
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
  // The simulator plays the game this macro describes in wick.json, if any.
  else if (state.target === 'sim' && !state.running) call('watch', { target: 'sim', folder: m.folder }).catch(() => {});
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
    await call('watch', { target: id, folder: state.selected?.folder });
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
    if (state.pickFor) calibrateColor(state.pickFor, hex);
    else setColor(hex);
    setTool('select');
  },
  onHover(hex) {
    $('hoverText').textContent = hex ?? '';
  },
  onMode(mode) {
    if (mode !== 'pick' && state.pickFor) {
      state.pickFor = null;
      renderCalibration();
    }
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
  if (!m) return;
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
  const reshape = reshapeable();
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
    input.disabled = !reshape;
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
    remove.classList.toggle('hidden', !reshape);
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
  if (m.score?.rounds) {
    $('tileScore').textContent = `${m.score.rounds.won}/${m.score.rounds.played}`;
    $('tileScoreLabel').textContent = 'Rounds won (simulator)';
  } else if (m.score) {
    $('tileScore').textContent = pct(m.score.inZone);
    $('tileScoreLabel').textContent = 'In zone (simulator)';
  } else {
    const recovered = m.recoveries ? `, ${m.recoveries} recovered` : '';
    $('tileScore').textContent = String(m.loops ?? 0);
    $('tileScoreLabel').textContent = `Loops${recovered}`;
  }
  refreshRunLabel();
}

// MARK: Actions

// MARK: Trace

const TRACE_HINT = $('traceHover').textContent;
const trace = new TraceGraph($('traceCanvas'), {
  onHover(text) {
    const el = $('traceHover');
    el.textContent = text || TRACE_HINT;
    el.classList.toggle('muted', !text);
  },
  onLegend(items) {
    const legend = $('traceLegend');
    legend.replaceChildren();
    for (const item of items) {
      const span = document.createElement('span');
      span.innerHTML = `<i class="${item.style}"></i>`;
      span.append(`${item.region} ${item.color}`);
      legend.append(span);
    }
    const inputs = document.createElement('span');
    inputs.innerHTML = '<i class="input"></i>inputs';
    legend.append(inputs);
  },
});

// MARK: Run history

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

const END_DOTS = { done: 'dot', error: 'dot red', stopped: 'dot' };

function endText(end) {
  if (!end) return 'Unknown';
  if (end.reason === 'done') return 'Done';
  if (end.reason === 'error') return 'Error';
  return end.detail === 'kill switch' ? 'Kill switch' : end.detail === 'time limit' ? 'Time limit' : 'Stopped';
}

async function loadRuns() {
  const m = state.selected;
  if (!m) return;
  const runs = await call('runs', { id: m.id }).catch(() => []);
  $('runsCard').classList.toggle('hidden', runs.length === 0);
  $('runDetail').classList.add('hidden');
  const list = $('runList');
  list.replaceChildren();
  for (const r of runs) {
    const row = document.createElement('button');
    row.className = 'run-row';
    row.innerHTML = '<i></i><b></b><span class="when"></span><span class="took"></span><span class="score"></span>';
    row.querySelector('i').className = END_DOTS[r.end?.reason] ?? 'dot';
    row.querySelector('b').textContent = `${endText(r.end)} · ${TARGET_LABELS[r.target] ?? r.target ?? ''}`;
    row.querySelector('.when').textContent = timeAgo(r.at);
    row.querySelector('.took').textContent = fmtSeconds(r.elapsed ?? 0);
    row.querySelector('.score').textContent = r.score ? pct(r.score.inZone) : `${r.inputs ?? 0} inputs`;
    row.onclick = () => showRun(r, row);
    list.append(row);
  }
}

async function showRun(summary, row) {
  if (state.running) {
    toast('A macro is running', 'Stop it to look at an earlier run.');
    return;
  }
  const m = state.selected;
  try {
    const run = await call('readRun', { id: m.id, file: summary.file });
    for (const el of $('runList').children) el.setAttribute('aria-current', String(el === row));
    trace.clear();
    trace.push(run.trace ?? {});
    $('traceCard').classList.toggle('hidden', trace.empty);
    $('runDetailTitle').textContent = `${endText(run.end)} after ${fmtSeconds(run.elapsed ?? 0)}, ${new Date(run.at).toLocaleString()}${run.end?.error ? ` — ${run.end.error.split('\n')[0]}` : ''}`;
    const log = $('runDetailLog');
    log.replaceChildren();
    for (const line of run.logs ?? []) {
      const li = document.createElement('li');
      li.innerHTML = '<time></time><span></span>';
      li.querySelector('time').textContent = line.at == null ? '' : fmtSeconds(line.at);
      li.querySelector('span').textContent = typeof line.text === 'string' ? line.text : JSON.stringify(line.text);
      log.append(li);
    }
    if (run.end?.reason === 'error') {
      const li = document.createElement('li');
      li.innerHTML = '<time></time><span class="error"></span>';
      li.querySelector('span').textContent = run.end.error;
      log.append(li);
    }
    $('runDetail').classList.remove('hidden');
  } catch (e) {
    toast('Couldn\'t open the run', e.message, 'error');
  }
}

async function run() {
  const m = state.selected;
  if (!m || !state.target) return;
  try {
    await saveSettings();
    state.running = { folder: m.folder, target: state.target };
    state.lastStats = null;
    state.step = null;
    trace.clear();
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
  if (state.running.target === 'sim') markTried();
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
    renderOnboarding();
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
  const prefs = await call('appPreferences').catch(() => null);
  form.elements.miniWindow.checked = prefs?.miniWindow ?? true;
  $('cliCommand').textContent = prefs?.cliScript ?? prefs?.cli ?? '';
  $('cliHint').textContent = !prefs?.cliScript
    ? 'This is a development run, so the command runs Wick from this checkout. Agents in a macro folder find it in AGENTS.md.'
    : wick.platform === 'darwin'
      ? `To type "wick" anywhere: ln -s "${prefs.cliScript}" /usr/local/bin/wick`
      : 'To type "wick" anywhere, add this file\'s folder to your PATH.';
  $('settingsDialog').showModal();
}

function renderPrecision() {
  const form = $('settingsDialogForm');
  $('precisionText').textContent = form.elements.precision.value;
  form.elements.precision.disabled = !form.elements.human.checked;
  $('precisionLabel').classList.toggle('disabled', !form.elements.human.checked);
}

$('settingsDialogForm').oninput = async (e) => {
  renderPrecision();
  const form = $('settingsDialogForm');
  if (e.target === form.elements.miniWindow) {
    await call('saveAppPreferences', { miniWindow: form.elements.miniWindow.checked }).catch((err) => toast('Couldn\'t save settings', err.message, 'error'));
    return;
  }
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

// MARK: Sharing

function openInstallSource() {
  if (state.running) {
    toast('A macro is running', 'Stop it before installing another one.');
    return;
  }
  $('installSourceForm').reset();
  $('installSourceDialog').showModal();
  $('installSourceForm').elements.url.focus();
}

$('installSourceDialog').onclose = () => {
  const url = $('installSourceForm').elements.url.value.trim();
  if ($('installSourceDialog').returnValue === 'continue' && url) installFrom(url);
};

$('chooseInstallFile').onclick = async () => {
  $('installSourceDialog').close('cancel');
  try {
    const info = await call('chooseInstallFile');
    if (info) showInstall(info);
  } catch (e) {
    toast('Couldn\'t open that package', e.message, 'error');
  }
};

/** Reads a .wick file or link and shows what it contains. Nothing is installed yet. */
async function installFrom(source, macro) {
  if (state.running) {
    toast('A macro is running', 'Stop it before installing another one.');
    return;
  }
  try {
    showInstall(await call('prepareInstall', { source, macro }));
  } catch (e) {
    toast('Couldn\'t open that macro', e.message, 'error');
  }
}

const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`);

function showInstall(info) {
  const dialog = $('installDialog');
  state.install = info;
  const choosing = Boolean(info.choose);
  $('installChoose').classList.toggle('hidden', !choosing);
  $('installReview').classList.toggle('hidden', choosing);
  $('installConfirm').classList.toggle('hidden', choosing);
  if (choosing) {
    $('installChooseText').textContent = `${info.source} has ${info.choose.length} macros. Which one?`;
    const list = $('installChoices');
    list.replaceChildren();
    for (const c of info.choose) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span data-icon="macro"></span><span></span><small></small>';
      b.children[1].textContent = c.name;
      b.children[2].textContent = c.folder;
      b.onclick = () => {
        dialog.close('cancel');
        installFrom(info.source, c.folder);
      };
      list.append(b);
    }
    icons(list);
    if (!dialog.open) dialog.showModal();
    return;
  }
  const m = info.manifest ?? {};
  $('installName').textContent = m.name ?? 'Unnamed macro';
  $('installMeta').textContent = [m.version && `v${m.version}`, m.author && `by ${m.author}`, m.target && TARGET_LABELS[m.target], info.source].filter(Boolean).join(' · ');
  $('installDescription').textContent = m.description ?? '';
  $('installDescription').classList.toggle('hidden', !m.description);

  const badges = $('installBadges');
  badges.replaceChildren();
  const badge = (text, kind = '') => {
    const b = document.createElement('span');
    b.className = `badge ${kind}`;
    b.textContent = text;
    badges.append(b);
  };
  if (info.intact === true) badge('Unchanged since it was exported');
  if (info.intact === false) badge('Changed after it was exported', 'error');
  if (info.existing) badge(info.sameAsInstalled ? 'Already installed, same files' : `Updates v${info.existing.version ?? '?'} to v${m.version ?? '?'}`, info.sameAsInstalled ? '' : 'ember');
  if (info.addedPermissions.length) badge(`Asks for ${info.addedPermissions.length} new permission${info.addedPermissions.length > 1 ? 's' : ''}`, 'ember');
  badge(`${info.files.length} files · ${info.hash.slice(0, 12)}`);

  const problems = $('installProblems');
  problems.replaceChildren(...info.problems.map((p) => Object.assign(document.createElement('li'), { textContent: p })));
  problems.classList.toggle('hidden', !info.problems.length);

  const perms = $('installPermissions');
  perms.replaceChildren();
  for (const p of info.permissions) {
    const li = document.createElement('li');
    li.classList.toggle('added', info.addedPermissions.includes(p.name));
    li.append(document.createTextNode(p.text));
    if (info.addedPermissions.includes(p.name)) li.append(' ', Object.assign(document.createElement('small'), { textContent: 'new in this version' }));
    perms.append(li);
  }
  if (!info.permissions.length) perms.append(Object.assign(document.createElement('li'), { textContent: 'Watch the game window. It asks to send no input.' }));

  $('installReadmeBlock').classList.toggle('hidden', !info.readme);
  $('installReadme').textContent = info.readme ?? '';

  // Every file, readable before installing. Shown as text, never as markup.
  const files = $('installFiles');
  files.replaceChildren();
  for (const f of info.files) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.append(f.name, Object.assign(document.createElement('span'), { textContent: kb(f.bytes) }));
    details.append(summary);
    const pre = document.createElement('pre');
    pre.textContent = f.text ?? 'Not a text file.';
    details.append(pre);
    files.append(details);
  }

  const blocked = info.problems.length > 0 || info.intact === false;
  const confirm = $('installConfirm');
  confirm.disabled = blocked || info.sameAsInstalled;
  confirm.textContent = info.sameAsInstalled ? 'Installed' : info.existing ? 'Update' : 'Install';
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('form').scrollTop = 0;
  dialog.scrollTop = 0;
}

$('installDialog').onclose = async () => {
  const info = state.install;
  state.install = null;
  if ($('installDialog').returnValue !== 'install' || !info?.token) return;
  try {
    const done = await call('confirmInstall', { token: info.token });
    toast(done.updated ? 'Updated' : 'Installed', done.updated ? `${done.macro.name} is now v${done.version}.` : `${done.macro.name} is in your library.`);
    log(`${done.updated ? 'Updated' : 'Installed'} ${done.macro.name}${done.version ? ` v${done.version}` : ''}.`);
    await showMacro(done.folder);
  } catch (e) {
    toast('Couldn\'t install', e.message, 'error');
  }
};

async function exportSelected() {
  const m = state.selected;
  if (!m) return;
  try {
    const done = await call('exportMacro', { folder: m.folder });
    if (done) toast('Exported', `${done.file}\n${done.files} files · ${kb(done.bytes)}. Anyone with Wick can open it to install.`);
  } catch (e) {
    toast('Couldn\'t export', e.message, 'error');
  }
}

async function checkUpdate() {
  const m = state.selected;
  if (!m || state.running) return;
  const b = $('updateButton');
  b.disabled = true;
  try {
    const found = await call('checkUpdate', { folder: m.folder });
    if (found.upToDate) toast('Up to date', `${m.name} matches ${m.source.url}.`);
    else showInstall(found);
  } catch (e) {
    toast('Couldn\'t check for updates', e.message, 'error');
  } finally {
    b.disabled = false;
  }
}

// MARK: Calibration

let calibrationFolder = null;
let calibrationColors = [];

async function renderCalibration() {
  const m = state.selected;
  const card = $('calibrationCard');
  card.classList.toggle('hidden', !m?.installed);
  if (!m?.installed) return;
  if (calibrationFolder !== m.folder) {
    calibrationFolder = m.folder;
    calibrationColors = [];
    try {
      calibrationColors = (await call('calibrationColors', { folder: m.folder })).colors;
    } catch {}
    if (state.selected !== m) return;
  }
  const mapped = m.calibration?.colors ?? {};
  const moved = Object.keys(m.calibration?.regions ?? {});
  $('calibrationHint').textContent =
    `If a color here looks different in your game (a different shader, graphics level or theme), pick what you see instead. ` +
    (moved.length ? `Regions you've fitted: ${moved.join(', ')}.` : 'Regions you move on the live view are kept here too.');
  $('resetCalibration').disabled = !moved.length && !Object.keys(mapped).length;
  const list = $('calibrationColors');
  list.replaceChildren();
  for (const hex of calibrationColors) {
    const to = mapped[hex];
    const row = document.createElement('div');
    row.className = 'cal-row';
    row.classList.toggle('picking', state.pickFor === hex);
    const sw = (color) => Object.assign(document.createElement('span'), { className: 'swatch', style: `background:${color}` });
    const pick = Object.assign(document.createElement('button'), { type: 'button', className: 'small-button quiet', innerHTML: '<span data-icon="drop"></span>' });
    pick.append(state.pickFor === hex ? 'Click the game…' : 'Pick');
    pick.title = 'Click the live view on the color your game shows';
    pick.disabled = Boolean(state.running);
    pick.onclick = () => {
      state.pickFor = hex;
      setTool('pick');
      renderCalibration();
    };
    const clear = Object.assign(document.createElement('button'), { type: 'button', className: 'small-button quiet remove', innerHTML: '<span data-icon="close"></span>' });
    clear.title = 'Use the macro\'s own color';
    clear.style.visibility = to ? '' : 'hidden';
    clear.onclick = () => calibrateColor(hex, null);
    row.append(
      sw(hex),
      document.createTextNode(hex),
      Object.assign(document.createElement('span'), { className: 'arrow', textContent: '→' }),
      to ? sw(to) : document.createElement('span'),
      Object.assign(document.createElement('span'), { className: to ? '' : 'same', textContent: to ?? 'as written' }),
      pick,
      clear,
    );
    list.append(row);
  }
  icons(list);
}

async function calibrateColor(from, to) {
  const m = state.selected;
  state.pickFor = null;
  if (!m) return;
  try {
    Object.assign(m, await call('setCalibrationColor', { folder: m.folder, from, to }), { values: m.values });
    if (to) log(`Calibrated ${from} to ${to} for ${m.name}.`);
  } catch (e) {
    toast('Couldn\'t save calibration', e.message, 'error');
  }
  renderCalibration();
}

$('resetCalibration').onclick = async () => {
  const m = state.selected;
  if (!m) return;
  try {
    Object.assign(m, await call('resetCalibration', { folder: m.folder }), { values: m.values });
    renderEditing();
    toast('Calibration reset', `${m.name} uses its own regions and colors again.`);
  } catch (e) {
    toast('Couldn\'t reset calibration', e.message, 'error');
  }
};

// Dropping a .wick file, or a link, anywhere on the window installs it.
let dragDepth = 0;
const dragHasInstall = (e) => [...(e.dataTransfer?.types ?? [])].some((t) => t === 'Files' || t === 'text/uri-list');
document.addEventListener('dragenter', (e) => {
  if (!dragHasInstall(e)) return;
  dragDepth++;
  $('dropZone').classList.remove('hidden');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('dropZone').classList.add('hidden');
  }
});
document.addEventListener('dragover', (e) => {
  if (dragHasInstall(e)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropZone').classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (file) {
    const where = wick.pathForFile(file);
    if (where?.toLowerCase().endsWith('.wick')) installFrom(where);
    else toast('That isn\'t a macro package', 'Drop a .wick file, or open a macro folder with Open macro folder.');
    return;
  }
  const url = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
  if (url) installFrom(url.trim());
});

// MARK: Onboarding and Wick updates

let onboarding = false;

function markTried() {
  try {
    localStorage.setItem('wick.triedSimulator', '1');
  } catch {}
  renderOnboarding();
}

function renderOnboarding() {
  if (!onboarding) return;
  const p = state.permissions;
  $('stepPermissions').classList.toggle('done', Boolean(p?.screenRecording && p?.accessibility));
  let tried = false;
  try {
    tried = localStorage.getItem('wick.triedSimulator') === '1';
  } catch {}
  $('stepExample').classList.toggle('done', tried);
  $('stepRoblox').classList.toggle('done', Boolean(state.targets.roblox?.found));
}

function showOnboarding(show = true) {
  onboarding = show;
  $('onboarding').classList.toggle('hidden', !show);
  renderOnboarding();
  if (show) document.querySelector('main').scrollTop = 0;
}

$('onboardingDone').onclick = () => {
  showOnboarding(false);
  call('finishOnboarding').catch(() => {});
};

async function checkAppUpdate({ quiet = false } = {}) {
  try {
    const u = await call('checkAppUpdate', { auto: quiet });
    $('appUpdate').classList.toggle('hidden', !u.available);
    if (u.available) {
      $('appUpdateTitle').textContent = `Wick ${u.latest} is out`;
      $('appUpdateOpen').onclick = () => call('openRelease', { url: u.url });
    }
    if (!quiet) toast(u.available ? `Wick ${u.latest} is available` : 'Wick is up to date', u.available ? 'Download it from the release page; your macros, settings and calibration stay.' : `You have ${u.version}${u.latest ? ', the latest release' : ''}.`);
  } catch (e) {
    if (!quiet) toast('Couldn\'t check for updates', e.message, 'error');
  }
}

$('checkAppUpdate').onclick = () => checkAppUpdate();

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
    case 'runs.saved':
      if (params.id === state.selected?.id) loadRuns();
      break;
    case 'macro.step':
      state.step = params.state;
      refreshRunLabel();
      break;
    case 'macro.trace':
      trace.push(params);
      $('traceCard').classList.remove('hidden');
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
    case 'app.run':
      if (state.selected && !state.running && !$('runButton').disabled) run();
      break;
    case 'app.simulate':
      if (state.selected && !state.running) simulate();
      break;
    case 'app.export':
      exportSelected();
      break;
    case 'app.checkUpdate':
      if (state.selected?.source?.url) checkUpdate();
      else if (state.selected) toast('Nothing to check', 'This macro wasn\'t installed from a link.');
      break;
    case 'app.showFolder':
      if (state.selected) call('showFolder', { folder: state.selected.folder });
      break;
    case 'app.editCode':
      if (state.selected) call('editCode', { folder: state.selected.folder });
      break;
    case 'app.onboarding':
      showOnboarding(true);
      break;
    case 'app.checkAppUpdate':
      checkAppUpdate();
      break;
    case 'app.installMacro':
      openInstallSource();
      break;
    case 'app.install':
      installFrom(params.source);
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
$('installShortcut').textContent = wick.platform === 'darwin' ? '⇧ ⌘ I' : 'Ctrl Shift I';
$('installMacro').onclick = openInstallSource;
$('exportButton').onclick = exportSelected;
$('updateButton').onclick = checkUpdate;
$('openSettings').onclick = openSettings;
$('emptyNew').onclick = newMacro;
$('emptyInstall').onclick = openInstallSource;
$('openMacro').onclick = openMacro;
$('runButton').onclick = run;
$('stopButton').onclick = () => call('stop').catch((e) => toast('Couldn\'t stop', e.message, 'error'));
$('killChip').onclick = () => call('killswitch');
$('simulateButton').onclick = simulate;
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
if (!(await call('onboarded').catch(() => true))) showOnboarding(true);
// Once per launch, quietly: a notice in the sidebar if a newer Wick is out.
setTimeout(() => checkAppUpdate({ quiet: true }), 8000);
// A .wick file or wick:// link that opened Wick.
for (const source of await call('takeInstallRequests').catch(() => [])) installFrom(source);
