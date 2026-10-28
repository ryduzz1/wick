// The commands agents use, shared by the app's control socket, the `wick`
// CLI and the MCP server. Each takes plain JSON and returns plain JSON.
//
// Agent input goes through the same gate as macros: only to the target
// window, only while it has focus, and the kill switch stops it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as library from './library.js';
import { writeAgentGuide } from './library.js';
import { DEFAULT_INPUT, loadMacro, MacroError, TARGETS } from './macro-loader.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Accepts the short forms agents type and fills in the engine's fields. */
export function normalizeCommand(c) {
  if (!c || typeof c !== 'object') throw new MacroError('An input needs a "t": click, mouseDown, mouseUp, move, turn, press, keyDown or keyUp.');
  const point = (at) => {
    if (at == null) return null;
    if (typeof at === 'string') return { region: at, x: 0.5, y: 0.5 };
    return { region: at.region ?? null, x: Number(at.x ?? 0.5), y: Number(at.y ?? 0.5) };
  };
  const key = () => {
    if (typeof c.key !== 'string' || !c.key) throw new MacroError(`"${c.t}" needs a "key".`);
    return c.key.toLowerCase();
  };
  switch (c.t) {
    case 'click':
      return { t: 'click', button: c.button ?? 'left', at: point(c.at), hold: Number(c.hold ?? 30) };
    case 'mouseDown':
    case 'mouseUp':
      return { t: c.t, button: c.button ?? 'left' };
    case 'move':
      if (c.at == null) throw new MacroError('"move" needs "at": a region name or { region, x, y }.');
      return { t: 'move', at: point(c.at) };
    case 'turn':
      return { t: 'turn', dx: Number(c.dx ?? 0), dy: Number(c.dy ?? 0) };
    case 'press':
      return { t: 'press', key: key(), hold: Number(c.hold ?? 40) };
    case 'keyDown':
    case 'keyUp':
      return { t: c.t, key: key() };
    default:
      throw new MacroError(`Unknown input "${c.t}". Use click, mouseDown, mouseUp, move, turn, press, keyDown or keyUp.`);
  }
}

/** Probe inputs: explicit `inputs`, plus a `clicks` shorthand. */
export function probeInputs({ inputs = [], clicks } = {}) {
  const out = inputs.map((i) => ({ time: Number(i.time ?? 0), command: normalizeCommand(i.command ?? i) }));
  if (clicks) {
    const count = Math.max(0, Math.min(200, Number(clicks.count ?? 1)));
    const every = Number(clicks.every ?? 300);
    const start = Number(clicks.start ?? 200);
    for (let i = 0; i < count; i++) {
      out.push({ time: start + i * every, command: normalizeCommand({ t: 'click', button: clicks.button, at: clicks.at, hold: clicks.hold }) });
    }
  }
  return out;
}

function readManifest(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, 'wick.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} host
 * @param {import('./engine-client.js').EngineClient} host.engine
 * @param {(target: string) => Promise<void>} host.ensureSession  points the engine's session at a target
 * @param {() => string|null} [host.busyTarget]  the target a macro is running on, if any
 * @param {(id: string) => object} [host.savedSettings]  the user's settings for a macro id
 * @param {() => object} [host.inputPreferences]  the app's human input preference
 * @param {string} [host.libraryDir]
 * @param {(event: string, data: object) => void} [host.notify]  tells the app what an agent did
 */
export function createCommands(host) {
  const { engine } = host;
  const notify = host.notify ?? (() => {});
  let lastRun = null;
  let activeRun = null;
  // Runs use the app's input preference; `exact` turns the human profile off.
  const inputFor = (exact) => (exact ? { human: false } : (host.inputPreferences?.() ?? DEFAULT_INPUT));

  const macroInfo = (folder) => {
    if (!folder) return { regions: {} };
    const manifest = readManifest(folder);
    if (!manifest) throw new MacroError(`${folder} isn't a Wick macro (no wick.json).`);
    let regions = {};
    try {
      regions = library.readRegions(folder);
    } catch (e) {
      throw new MacroError(`regions.json couldn't be read: ${e.message}`);
    }
    return { manifest, regions };
  };

  const pickTarget = (target, folder) => {
    const t = target ?? (folder && readManifest(folder)?.target) ?? 'sim';
    if (!TARGETS.includes(t)) throw new MacroError(`Unknown target "${t}". Use ${TARGETS.join(', ')}.`);
    return t;
  };

  async function onTarget(target) {
    const busy = host.busyTarget?.();
    if (busy && busy !== target) throw new MacroError(`A macro is running on ${busy}. Stop it first (wick stop).`);
    await host.ensureSession(target);
    notify('target', { target });
  }

  /** Session calls that need a frame retry briefly after a target switch. */
  async function withFrame(method, params) {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        return await engine.call(method, params);
      } catch (e) {
        if (!/No frame has been captured yet/.test(e.message) || Date.now() > deadline) throw e;
        await sleep(100);
      }
    }
  }

  // Images go in the macro's .wick folder (never shared), or a temp folder
  // when the macro's folder can't be written, like a bundled example.
  const outDir = (folder, kind) => {
    for (const dir of [folder && path.join(folder, '.wick', kind), path.join(os.tmpdir(), 'wick', kind)]) {
      if (!dir) continue;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return dir;
      } catch {}
    }
    throw new MacroError('There\'s nowhere to save the image.');
  };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  function regionFor(name, regions, inline) {
    if (inline) return inline;
    if (!name) return null;
    const r = regions[name];
    if (!r) throw new MacroError(`Unknown region "${name}". Known: ${Object.keys(regions).join(', ') || 'none'}.`);
    return r;
  }

  async function waitForEnd(seconds) {
    const logs = [];
    let resolveEnd;
    const ended = new Promise((resolve) => (resolveEnd = resolve));
    const onEvent = (method, params) => {
      if (method === 'macro.log' && logs.length < 500) logs.push(params.text);
      if (method === 'macro.end') resolveEnd(params);
    };
    engine.on('event', onEvent);
    return {
      logs,
      ended,
      done: () => engine.off('event', onEvent),
      timeout: seconds > 0 ? sleep(seconds * 1000).then(() => 'timeout') : new Promise(() => {}),
    };
  }

  return {
    async status() {
      const [version, permissions, targets] = await Promise.all([
        engine.call('version'),
        engine.call('permissions'),
        engine.call('targets.list'),
      ]);
      return { engine: version, permissions, targets, running: activeRun ? { id: activeRun.id, target: activeRun.target } : null };
    },

    targets: () => engine.call('targets.list'),

    async observe({ folder, target, region, out } = {}) {
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      const spec = regionFor(region, regions);
      await onTarget(t);
      const file = out ?? path.join(outDir(folder, 'observe'), `${t}-${region ?? 'window'}-${stamp()}.png`);
      const result = await withFrame('session.snapshot', { path: file, region: spec });
      notify('log', { text: `Agent saved a ${region ? `"${region}"` : 'window'} snapshot of ${t}.` });
      return { target: t, region: region ?? null, ...result };
    },

    async detect({ folder, target, region, color, tolerance, minPixels, mask } = {}) {
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      const spec = regionFor(region, regions);
      await onTarget(t);
      const maskPath = mask ? (typeof mask === 'string' ? mask : path.join(outDir(folder, 'detect'), `${t}-${region ?? 'window'}-${stamp()}.png`)) : undefined;
      const result = await withFrame('session.detect', { region: spec, color, tolerance, minPixels, mask: maskPath });
      return { target: t, region: region ?? null, ...result, note: 'Match positions are fractions of the region. Palette colors are averages of similar pixels; use one as a starting color.' };
    },

    async act({ folder, target, command } = {}) {
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      const cmd = normalizeCommand(command);
      await onTarget(t);
      const result = await engine.call('session.act', { command: cmd, regions });
      notify('log', { text: `Agent sent ${cmd.t}${cmd.key ? ` ${cmd.key}` : ''} to ${t}.` });
      return { target: t, command: cmd, ...result };
    },

    async probe({ folder, target, regions: inline = {}, track = [], inputs, clicks, seconds = 3, sampleHz = 60, scenario } = {}) {
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      const spec = {
        regions: { ...regions, ...inline },
        track: track.map((x) => ({ ...x, tolerance: x.tolerance ?? 30, minPixels: x.minPixels ?? 3 })),
        inputs: probeInputs({ inputs, clicks }),
        seconds: Number(seconds),
        sampleHz: Number(sampleHz),
      };
      if (!spec.track.length) throw new MacroError('A probe needs at least one tracker: { name, region, color }.');
      if (t === 'sim') return { target: t, ...(await engine.call('sim.probe', { ...spec, scenario })) };
      await onTarget(t);
      notify('log', { text: `Agent started a ${spec.seconds}s probe on ${t}.` });
      return { target: t, ...(await engine.call('session.probe', spec)) };
    },

    async record({ folder, target, region, seconds = 5, fps = 10, you = false, run = false, exact = false, live = false, scenario } = {}) {
      const t = pickTarget(target, folder);
      const { regions, manifest } = macroInfo(folder);
      const dir = path.join(outDir(folder, 'recordings'), `${t}-${stamp()}`);
      const spec = { dir, seconds: Number(seconds), fps: Number(fps), region: regionFor(region, regions), you: Boolean(you) };
      const macro = run ? await loadMacro(folder, { settings: host.savedSettings?.(manifest?.id) ?? {}, input: inputFor(exact) }) : undefined;
      const note = 'record.jsonl has one line per sample ({ t, change, frame? }) and per input ({ t, by: "wick"|"you", input, ... }); times are ms from the start and click positions are fractions of the recorded area. contact.png shows the frames listed in "sheet", left to right, top to bottom.';
      if (t === 'sim' && !live) return { target: t, ...(await engine.call('sim.record', { ...spec, macro, scenario })), note };
      await onTarget(t);
      notify('log', { text: `Agent started a ${spec.seconds}s recording of ${t}${you ? ', including your clicks and keys' : ''}.` });
      if (macro) {
        if (host.busyTarget?.()) throw new MacroError('A macro is already running. Stop it first, or record without --run.');
        await engine.call('macro.run', { macro });
        activeRun = { id: macro.id, target: t };
      }
      try {
        return { target: t, ...(await engine.call('session.record', spec)), note };
      } finally {
        if (macro) {
          activeRun = null;
          await engine.call('macro.stop').catch(() => {});
        }
      }
    },

    regions({ folder }) {
      return macroInfo(folder).regions;
    },

    setRegion({ folder, name, anchor, x, y, w, h }) {
      const { regions } = macroInfo(folder);
      const prev = regions[name] ?? { anchor: 'center', x: 0, y: 0, w: 0.2, h: 0.1 };
      const next = { ...prev };
      for (const [k, v] of Object.entries({ anchor, x, y, w, h })) if (v !== undefined) next[k] = k === 'anchor' ? v : Number(v);
      const saved = library.saveRegions(folder, { ...regions, [name]: next });
      notify('log', { text: `Agent set region "${name}".` });
      return { [name]: saved[name] };
    },

    removeRegion({ folder, name }) {
      const { regions } = macroInfo(folder);
      if (!regions[name]) throw new MacroError(`There's no region "${name}".`);
      delete regions[name];
      library.saveRegions(folder, regions);
      return { removed: name };
    },

    async run({ folder, target, seconds, settings, live = false, exact = false, scenario } = {}) {
      if (!folder) throw new MacroError('Run needs a macro folder.');
      const t = pickTarget(target, folder);
      const manifest = readManifest(folder);
      const spec = await loadMacro(folder, { settings: settings ?? host.savedSettings?.(manifest?.id) ?? {}, input: inputFor(exact) });
      if (t === 'sim' && !live) {
        const result = await engine.call('sim.run', { macro: spec, scenario, seconds: Number(seconds ?? 30) });
        lastRun = { target: t, folder, at: new Date().toISOString(), ...result };
        return lastRun;
      }
      await onTarget(t);
      const limit = Number(seconds ?? 30);
      const watch = await waitForEnd(limit);
      try {
        await engine.call('macro.run', { macro: spec });
        activeRun = { id: spec.id, target: t };
        notify('run', { folder, target: t });
        let end = await Promise.race([watch.ended, watch.timeout]);
        if (end === 'timeout') {
          await engine.call('macro.stop').catch(() => {});
          end = await Promise.race([watch.ended, sleep(2000).then(() => ({ end: { reason: 'stopped', detail: 'time limit' } }))]);
          end.end = { reason: 'stopped', detail: 'time limit' };
        }
        lastRun = { target: t, folder, at: new Date().toISOString(), ...end, logs: watch.logs };
        return lastRun;
      } finally {
        activeRun = null;
        watch.done();
      }
    },

    async simulate({ folder, seeds = 5, seconds = 30, settings, exact = false } = {}) {
      if (!folder) throw new MacroError('Simulate needs a macro folder.');
      const manifest = readManifest(folder);
      const spec = await loadMacro(folder, { settings: settings ?? host.savedSettings?.(manifest?.id) ?? {}, input: inputFor(exact) });
      const n = Math.max(1, Math.min(50, Number(seeds)));
      // Each game gets its own input seed, so results repeat run to run.
      const runs = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          engine.call('sim.run', { macro: { ...spec, human: spec.human && { ...spec.human, seed: i + 1 } }, scenario: { seed: i + 1 }, seconds: Number(seconds) }),
        ),
      );
      const scores = runs.map((r) => r.score?.inZone ?? 0);
      const errors = runs.filter((r) => r.end?.reason === 'error').map((r) => r.end.error);
      return {
        games: n,
        average: scores.reduce((a, b) => a + b, 0) / n,
        worst: Math.min(...scores),
        scores,
        errors: [...new Set(errors)],
        note: 'Scores are the fraction of time the tick was in the zone, on the simulated bar minigame.',
      };
    },

    telemetry() {
      if (!lastRun) throw new MacroError('Nothing has run yet in this session.');
      return lastRun;
    },

    async stop() {
      await engine.call('macro.stop').catch(() => {});
      await engine.call('session.stopRecord').catch(() => {});
      return { stopped: true };
    },

    newMacro({ name, target = 'roblox', dir }) {
      const folder = library.createMacro(dir ?? host.libraryDir ?? library.defaultLibrary(), { name, target });
      notify('library', { folder });
      return { folder };
    },

    init({ folder }) {
      if (!readManifest(folder)) throw new MacroError(`${folder} isn't a Wick macro (no wick.json).`);
      return { written: writeAgentGuide(folder) };
    },
  };
}
