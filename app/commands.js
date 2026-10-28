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
import { DEFAULT_INPUT, loadMacro, loadTemplates, MacroError, TARGETS } from './macro-loader.js';

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

  async function onTarget(target, scenario) {
    const busy = host.busyTarget?.();
    if (busy && busy !== target) throw new MacroError(`A macro is running on ${busy}. Stop it first (wick stop).`);
    await host.ensureSession(target, target === 'sim' && !busy ? scenario : undefined);
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

  const camel = (slug) => slug.replace(/-(\w)/g, (_, c) => c.toUpperCase()).replace(/^\d/, '_$&');
  // The newest recording of a macro, if any.
  const latestRecording = (folder) => {
    const root = outDir(folder, 'recordings');
    try {
      const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'record.jsonl')));
      dirs.sort((a, b) => fs.statSync(path.join(root, a)).mtimeMs - fs.statSync(path.join(root, b)).mtimeMs);
      return dirs.length ? path.join(root, dirs.at(-1)) : null;
    } catch {
      return null;
    }
  };
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
      await onTarget(t, readManifest(folder)?.simulator);
      const file = out ?? path.join(outDir(folder, 'observe'), `${t}-${region ?? 'window'}-${stamp()}.png`);
      const result = await withFrame('session.snapshot', { path: file, region: spec });
      notify('log', { text: `Agent saved a ${region ? `"${region}"` : 'window'} snapshot of ${t}.` });
      return { target: t, region: region ?? null, ...result };
    },

    async detect({ folder, target, region, color, tolerance, minPixels, mask, template, scenario } = {}) {
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      const spec = regionFor(region, regions);
      let tpl;
      if (template) {
        tpl = (await loadTemplates(folder))[template];
        if (!tpl) throw new MacroError(`There's no template "${template}". Save one with "wick template save ${template} --region R".`);
      }
      await onTarget(t, scenario ?? readManifest(folder)?.simulator);
      const maskPath = mask ? (typeof mask === 'string' ? mask : path.join(outDir(folder, 'detect'), `${t}-${region ?? 'window'}-${stamp()}.png`)) : undefined;
      const result = await withFrame('session.detect', { region: spec, color, tolerance, minPixels, mask: maskPath, template: tpl });
      return { target: t, region: region ?? null, ...result, note: 'Match positions are fractions of the region. Palette colors are averages of similar pixels; use one as a starting color. A template score is 0 to 1; screen.find counts 0.8 and up as seen by default.' };
    },

    /** Reads text in a region (or the whole window) with the system's text recognition. */
    async read({ folder, target, region, fast = false, scenario } = {}) {
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      const spec = regionFor(region, regions);
      await onTarget(t, scenario ?? readManifest(folder)?.simulator);
      const result = await withFrame('session.read', { region: spec, accurate: !fast });
      return { target: t, region: region ?? null, ...result, note: 'Line boxes are fractions of the region. In a macro, ctx.screen.read(region) gives the same text a couple of times a second, with .number for the first number in it.' };
    },

    /** Saves a region of the target window as templates/NAME.png for screen.find. */
    async saveTemplate({ folder, target, name, region, scenario } = {}) {
      if (!folder) throw new MacroError('Saving a template needs a macro folder.');
      const slug = String(name ?? '').trim();
      if (!/^[\w-]+$/.test(slug)) throw new MacroError('Name the template with letters, digits, - or _, like sell-button.');
      if (!region) throw new MacroError('Say which region to save: --region R. Draw a tight one around the thing first.');
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      await onTarget(t, scenario ?? readManifest(folder)?.simulator);
      const file = path.join(folder, 'templates', `${slug}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const result = await withFrame('session.snapshot', { path: file, region: regionFor(region, regions) });
      const metaFile = path.join(folder, 'templates.json');
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      } catch {}
      meta[slug] = { viewportHeight: result.viewport.h, region };
      fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
      notify('log', { text: `Agent saved template "${slug}" from region "${region}".` });
      return { name: slug, file, path: file, width: result.width, height: result.height, viewportHeight: result.viewport.h, usage: `const ${slug.replace(/-(\w)/g, (_, c) => c.toUpperCase())} = ctx.screen.find("${region}", { template: "${slug}" });` };
    },

    async templates({ folder } = {}) {
      const meta = (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(folder, 'templates.json'), 'utf8'));
        } catch {
          return {};
        }
      })();
      return Object.entries(meta).map(([name, m]) => ({ name, ...m, file: path.join(folder, 'templates', `${name}.png`) }));
    },

    async act({ folder, target, command } = {}) {
      const t = pickTarget(target, folder);
      const { regions } = macroInfo(folder);
      const cmd = normalizeCommand(command);
      await onTarget(t, readManifest(folder)?.simulator);
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
      if (t === 'sim') return { target: t, ...(await engine.call('sim.probe', { ...spec, scenario: scenario ?? readManifest(folder)?.simulator })) };
      await onTarget(t, readManifest(folder)?.simulator);
      notify('log', { text: `Agent started a ${spec.seconds}s probe on ${t}.` });
      return { target: t, ...(await engine.call('session.probe', spec)) };
    },

    async record({ folder, target, region, seconds = 5, fps = 10, you = false, run = false, exact = false, live = false, scenario } = {}) {
      const t = pickTarget(target, folder);
      const { regions, manifest } = macroInfo(folder);
      const dir = path.join(outDir(folder, 'recordings'), `${t}-${stamp()}`);
      const spec = { dir, seconds: Number(seconds), fps: Number(fps), region: regionFor(region, regions), you: Boolean(you) };
      const macro = run ? await loadMacro(folder, { settings: host.savedSettings?.(manifest?.id) ?? {}, input: inputFor(exact) }) : undefined;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ target: t, region: region ?? null, seconds: spec.seconds, fps: spec.fps, you: spec.you, at: new Date().toISOString() }));
      const note = 'Read storyboard.md first: the recording split into steps (what was pressed, held, clicked and turned, the waits, and where the screen changed), with each step\'s start and end frame; storyboard.png shows each step\'s last frame in order. record.jsonl has one line per sample ({ t, change, frame? }) and per input ({ t, by: "wick"|"you", input, ... }; "mouse" lines are the person\'s mouse motion summed per sample, which is how camera turns show up). Times are ms from the start and positions are fractions of the recorded area. contact.png shows the frames listed in "sheet", left to right, top to bottom.';
      if (t === 'sim' && !live) return { target: t, ...(await engine.call('sim.record', { ...spec, macro, scenario: scenario ?? manifest?.simulator })), note };
      await onTarget(t, manifest?.simulator);
      notify('log', { text: `Agent started a ${spec.seconds}s recording of ${t}${you ? ', including your clicks, keys and mouse' : ''}.` });
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

    /** A recording's storyboard, rebuilt from its log. Defaults to the newest recording. */
    async storyboard({ folder, recording } = {}) {
      const dir = recording ? path.resolve(recording) : latestRecording(folder);
      if (!dir) throw new MacroError('There are no recordings yet. Make one with "wick record --you".');
      const summary = await engine.call('record.storyboard', { dir });
      const board = JSON.parse(fs.readFileSync(path.join(dir, 'storyboard.json'), 'utf8'));
      return { dir, ...summary, path: summary.sheet ?? undefined, board };
    },

    /**
     * Turns part of a recording into a route a macro can replay with
     * ctx.input.play: storyboard steps ("3" or "3-5") or a time range in
     * seconds. With a name, saves it as routes/NAME.js in the macro.
     */
    async route({ folder, recording, steps, from, to, name } = {}) {
      const dir = recording ? path.resolve(recording) : latestRecording(folder);
      if (!dir) throw new MacroError('There are no recordings yet. Make one with "wick record --you".');
      if (!fs.existsSync(path.join(dir, 'storyboard.json'))) await engine.call('record.storyboard', { dir });
      const board = JSON.parse(fs.readFileSync(path.join(dir, 'storyboard.json'), 'utf8'));
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      } catch {}
      let actions;
      let range;
      if (steps != null) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(String(steps).trim());
        if (!m) throw new MacroError('Give steps as a number or a range, like 3 or 3-5.');
        const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
        const picked = board.steps.filter((s) => s.n >= a && s.n <= b);
        if (!picked.length) throw new MacroError(`The storyboard has steps 1 to ${board.steps.length}.`);
        actions = picked.flatMap((s) => s.actions);
        range = [picked[0].start, picked.at(-1).end];
      } else if (from != null || to != null) {
        range = [Number(from ?? 0) * 1000, to != null ? Number(to) * 1000 : Infinity];
        actions = board.steps.flatMap((s) => s.actions).filter((a) => a.t >= range[0] && a.t < range[1]);
      } else {
        throw new MacroError('Say which part: --steps 3-5, or --from S --to S in seconds.');
      }
      if (!actions.length) throw new MacroError('There are no inputs in that part of the recording.');
      const base = actions[0].t;
      const route = actions.map(({ to: _to, ...a }) => {
        const out = { ...a, t: Math.round(a.t - base) };
        if (a.do === 'click' && meta.region) out.region = meta.region;
        return out;
      });
      const duration = Math.max(...route.map((a) => a.t + (a.ms ?? 0)));
      const result = { dir, from: range[0] / 1000, to: Number.isFinite(range[1]) ? range[1] / 1000 : null, duration, route };
      if (name) {
        if (!folder) throw new MacroError('Saving a route needs a macro folder.');
        const slug = String(name).trim().toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) throw new MacroError('Give the route a name, like to-vendor.');
        const file = path.join(folder, 'routes', `${slug}.js`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const where = steps != null ? `${/-/.test(String(steps)) ? 'steps' : 'step'} ${steps}` : `${result.from}–${result.to ?? 'end'} s`;
        fs.writeFileSync(file, `// Route "${slug}": ${where} of the recording ${path.basename(dir)}, made by \`wick route\`.\n// Times are ms from the start of the route. Play it with ctx.input.play(route, { until }).\nexport default [\n${route.map((a) => `  ${JSON.stringify(a)},`).join('\n')}\n];\n`);
        notify('log', { text: `Agent saved route "${slug}" (${(duration / 1000).toFixed(1)} s).` });
        Object.assign(result, { file, usage: `import ${camel(slug)} from "./routes/${slug}.js";\n// ...\nawait ctx.input.play(${camel(slug)}, { until: () => prompt.seen });` });
      }
      return result;
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
        const result = await engine.call('sim.run', { macro: spec, scenario: scenario ?? spec.simulator, seconds: Number(seconds ?? 30) });
        lastRun = { target: t, folder, at: new Date().toISOString(), ...result };
        return lastRun;
      }
      await onTarget(t, readManifest(folder)?.simulator);
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
          engine.call('sim.run', { macro: { ...spec, human: spec.human && { ...spec.human, seed: i + 1 } }, scenario: { ...spec.simulator, seed: i + 1 }, seconds: Number(seconds) }),
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

    runs({ folder, file, last = 10 } = {}) {
      const history = host.runHistory?.();
      if (!history) throw new MacroError('Run history is kept by the Wick app. Open it and run the macro there (or with wick run --live).');
      const { manifest } = macroInfo(folder);
      if (!manifest) throw new MacroError('Runs needs a macro folder.');
      if (file) return history.read(manifest.id, file);
      return { runs: history.list(manifest.id, Number(last)), note: 'Newest first. Pass a file to get one run in full: its log and the trace of its last 15 seconds ([t, [[x, left, right] | null per tracker]]).' };
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
