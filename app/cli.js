// The `wick` command line: agent tools for observing a game, probing it,
// editing regions and running macros. Talks to the running app when there
// is one, so everything shows up in its window; otherwise starts its own
// engine.

import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createCommands } from './commands.js';
import { connect } from './control.js';
import { EngineClient } from './engine-client.js';

const HELP = `wick: agent tools for Wick macros

Usage: wick <command> [options]

  status                         Wick, the engine, permissions and targets
  observe [--region R] [--out F] Save a PNG of the target window or one region
  detect [--region R] [--color HEX] [--tolerance N] [--min-pixels N] [--mask [F]]
                                 Main colors in a region, and where a color matches
  act click [--at R|R:x,y] [--button B] [--hold MS]
  act press KEY [--hold MS]      Also: key-down KEY, key-up KEY, mouse-down, mouse-up,
                                 move --at R, turn --dx N --dy N
  probe --track NAME:REGION:HEX[:TOL] [--track ...] [--clicks N --every MS --start MS]
        [--input '{"time":0,"command":{"t":"press","key":"e"}}'] [--seconds S] [--hz N]
                                 Follow colors while sending timed input
  record [--seconds S] [--fps N] [--region R] [--you] [--run]
                                 Save keyframes, change scores, inputs and a storyboard
                                 (up to 600 s). --you also logs your clicks, keys and
                                 mouse; --run runs the macro meanwhile
  storyboard [DIR]               Rebuild and show a recording's steps (default: newest)
  regions                        List the macro's regions
  region set NAME [--anchor A] [--x N] [--y N] [--w N] [--h N]
  region remove NAME
  run [--seconds S] [--live] [--exact]
                                 Run the macro (instantly on sim, unless --live).
                                 --exact sends input without the human profile
  simulate [--seeds N] [--seconds S] [--exact]
  telemetry                      The last run's result
  runs [--last N] | runs show FILE
                                 Saved live runs of this macro (app only)
  stop                           Stop whatever is running
  new NAME [--target T] [--dir D] Create a macro (in the library by default)
  init                           Add AGENTS.md and CLAUDE.md to this macro
  mcp                            Run as an MCP server over stdio

Options for every command:
  --folder F     The macro folder (default: the nearest folder with wick.json)
  --target T     roblox, testbench or sim (default: the macro's target)
  --local        Use a local engine even if the Wick app is open

Output is JSON. Input only reaches the target while it has focus; F8 stops everything.`;

const BOOLEAN = new Set(['local', 'live', 'help', 'mask', 'exact', 'you', 'run']);
const REPEATED = new Set(['track', 'input']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (BOOLEAN.has(key) && (next === undefined || next.startsWith('--') || key !== 'mask')) value = true;
      else if (next !== undefined && !next.startsWith('--')) value = argv[++i];
      else value = true;
    }
    if (REPEATED.has(key)) (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return { positional, flags };
}

/** "bar", "bar:0.2,0.5" or "0.5,0.5" (the whole game area). */
export function parseAt(text) {
  if (text === undefined || text === true) return undefined;
  const [a, b] = String(text).split(':');
  const coords = (s) => {
    const [x, y] = s.split(',').map(Number);
    if (![x, y].every(Number.isFinite)) throw new Error(`"${text}" isn't a position. Use REGION, REGION:x,y or x,y.`);
    return { x, y };
  };
  if (b !== undefined) return { region: a, ...coords(b) };
  if (/^[\d.]+,[\d.]+$/.test(a)) return coords(a);
  return { region: a };
}

/** "tick:bar:#ffffff" or "tick:bar:#ffffff:40". */
export function parseTrack(text) {
  const [name, region, color, tolerance] = String(text).split(':');
  if (!name || !region || !color) throw new Error(`"${text}" isn't a tracker. Use NAME:REGION:#rrggbb[:tolerance].`);
  return { name, region, color, ...(tolerance ? { tolerance: Number(tolerance) } : {}) };
}

export function findFolder(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'wick.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The app if it's running, otherwise a private engine. */
export async function openBackend({ local = false } = {}) {
  if (!local) {
    const client = await connect();
    if (client) return { kind: 'app', call: (m, p) => client.call(m, p), close: () => client.close() };
  }
  const engine = new EngineClient({ restart: false });
  const ready = once(engine, 'ready');
  engine.start();
  await ready;
  let current = null;
  const commands = createCommands({
    engine,
    async ensureSession(target) {
      if (current === target) return;
      await engine.call('session.start', { target });
      current = target;
    },
  });
  return {
    kind: 'local',
    async call(method, params) {
      if (!Object.hasOwn(commands, method)) throw new Error(`Unknown command "${method}"`);
      return commands[method](params);
    },
    close: () => engine.stop(),
  };
}

const number = (v) => (v === undefined ? undefined : Number(v));

const ACT = {
  click: (args, f) => ({ t: 'click', at: parseAt(f.at), button: f.button, hold: number(f.hold) }),
  'mouse-down': (args, f) => ({ t: 'mouseDown', button: f.button }),
  'mouse-up': (args, f) => ({ t: 'mouseUp', button: f.button }),
  move: (args, f) => ({ t: 'move', at: parseAt(f.at) }),
  turn: (args, f) => ({ t: 'turn', dx: number(f.dx), dy: number(f.dy) }),
  press: (args, f) => ({ t: 'press', key: args[0], hold: number(f.hold) }),
  'key-down': (args) => ({ t: 'keyDown', key: args[0] }),
  'key-up': (args) => ({ t: 'keyUp', key: args[0] }),
};

/** Turns a command line into a command name and its JSON parameters. */
export function toRequest(positional, flags, cwd = process.cwd()) {
  const [command, ...args] = positional;
  const folder = flags.folder ? path.resolve(cwd, flags.folder) : findFolder(cwd);
  const base = { folder: folder ?? undefined, target: flags.target };
  const needFolder = () => {
    if (!folder) throw new Error('Run this inside a macro folder (one with wick.json), or pass --folder.');
  };
  switch (command) {
    case 'status':
      return ['status', {}];
    case 'observe':
      return ['observe', { ...base, region: flags.region, out: flags.out && path.resolve(cwd, flags.out) }];
    case 'detect':
      return ['detect', {
        ...base,
        region: flags.region,
        color: flags.color,
        tolerance: number(flags.tolerance),
        minPixels: number(flags.minPixels),
        mask: typeof flags.mask === 'string' ? path.resolve(cwd, flags.mask) : flags.mask,
      }];
    case 'act': {
      const make = ACT[args[0]];
      if (!make) throw new Error(`Unknown input "${args[0] ?? ''}". Use ${Object.keys(ACT).join(', ')}.`);
      return ['act', { ...base, command: make(args.slice(1), flags) }];
    }
    case 'probe':
      return ['probe', {
        ...base,
        track: (flags.track ?? []).map(parseTrack),
        inputs: (flags.input ?? []).map((s) => JSON.parse(s)),
        clicks: flags.clicks ? { count: number(flags.clicks), every: number(flags.every), start: number(flags.start), at: parseAt(flags.at), button: flags.button } : undefined,
        seconds: number(flags.seconds) ?? 3,
        sampleHz: number(flags.hz) ?? 60,
      }];
    case 'record':
      return ['record', {
        ...base,
        region: flags.region,
        seconds: number(flags.seconds) ?? 5,
        fps: number(flags.fps) ?? 10,
        you: Boolean(flags.you),
        run: Boolean(flags.run),
        exact: Boolean(flags.exact),
        live: Boolean(flags.live),
      }];
    case 'storyboard':
      return ['storyboard', { ...base, recording: args[0] && path.resolve(cwd, args[0]) }];
    case 'regions':
      needFolder();
      return ['regions', base];
    case 'region': {
      needFolder();
      const [action, name] = args;
      if (!name) throw new Error('Name the region: wick region set NAME ... or wick region remove NAME.');
      if (action === 'set') {
        return ['setRegion', { ...base, name, anchor: flags.anchor, x: number(flags.x), y: number(flags.y), w: number(flags.w), h: number(flags.h) }];
      }
      if (action === 'remove') return ['removeRegion', { ...base, name }];
      throw new Error('Use "wick region set NAME ..." or "wick region remove NAME".');
    }
    case 'run':
      needFolder();
      return ['run', { ...base, seconds: number(flags.seconds), live: Boolean(flags.live), exact: Boolean(flags.exact) }];
    case 'simulate':
      needFolder();
      return ['simulate', { ...base, seeds: number(flags.seeds) ?? 5, seconds: number(flags.seconds) ?? 30, exact: Boolean(flags.exact) }];
    case 'telemetry':
      return ['telemetry', {}];
    case 'runs':
      needFolder();
      return ['runs', { ...base, file: args[0] === 'show' ? args[1] : undefined, last: number(flags.last) ?? 10 }];
    case 'stop':
      return ['stop', {}];
    case 'new':
      if (!args[0]) throw new Error('Give the macro a name: wick new "Fishing loop".');
      return ['newMacro', { name: args.join(' '), target: flags.target ?? 'roblox', dir: flags.dir && path.resolve(cwd, flags.dir) }];
    case 'init':
      needFolder();
      return ['init', base];
    default:
      throw new Error(`Unknown command "${command}". Run "wick help" for the list.`);
  }
}

/** JSON with short arrays of numbers kept on one line. */
export function format(value) {
  return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner) => `[${inner.replace(/\s*\n\s*/g, ' ')}]`);
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  if (!positional.length || positional[0] === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }
  if (positional[0] === 'mcp') {
    const { serveMcp } = await import('./mcp.js');
    await serveMcp({ local: Boolean(flags.local), folder: flags.folder });
    return 0;
  }
  let backend;
  try {
    const [method, params] = toRequest(positional, flags);
    backend = await openBackend({ local: Boolean(flags.local) });
    if (backend.kind === 'local' && !['status', 'regions', 'setRegion', 'removeRegion', 'init', 'newMacro'].includes(method)) {
      process.stderr.write('(The Wick app isn\'t running, so this uses its own engine.)\n');
    }
    const result = await backend.call(method, params);
    console.log(format(result));
    return 0;
  } catch (e) {
    process.stderr.write(`wick: ${e.message}\n`);
    return 1;
  } finally {
    await backend?.close();
  }
}
