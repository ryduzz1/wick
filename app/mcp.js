// `wick mcp`: the agent tools as an MCP server over stdio, for Claude Code
// and other MCP clients. Each tool calls the same command as the CLI.

import fs from 'node:fs';
import path from 'node:path';
import { findFolder, openBackend } from './cli.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const target = { type: 'string', enum: ['roblox', 'testbench', 'sim'], description: 'Window to work with. Defaults to the macro\'s target.' };
const folder = { type: 'string', description: 'Absolute path of the macro folder. Defaults to the folder the server was started in.' };
const region = { type: 'string', description: 'A region name from regions.json.' };
const at = {
  description: 'Where to click or move: a region name, or { region, x, y } with x and y as fractions of the region (default 0.5).',
  anyOf: [{ type: 'string' }, { type: 'object', properties: { region: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } }],
};
const command = {
  type: 'object',
  description: 'One input: { t: "click", at?, button?, hold? } | { t: "press", key, hold? } | { t: "keyDown"|"keyUp", key } | { t: "mouseDown"|"mouseUp", button? } | { t: "move", at } | { t: "turn", dx, dy }.',
  properties: { t: { type: 'string', enum: ['click', 'mouseDown', 'mouseUp', 'move', 'turn', 'press', 'keyDown', 'keyUp'] }, at, button: { type: 'string', enum: ['left', 'right', 'middle'] }, key: { type: 'string' }, hold: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' } },
  required: ['t'],
};

const TOOLS = [
  { name: 'wick_status', method: 'status', description: 'Engine version, macOS permissions, and which targets (Roblox, test bench, simulator) are open and focused.', properties: {} },
  { name: 'wick_observe', method: 'observe', description: 'Screenshot of the target window, or of one region, returned as an image and saved as a PNG.', properties: { folder, target, region } },
  {
    name: 'wick_detect',
    method: 'detect',
    description: 'The main colors in a region (or the whole game area), and, with a color, where it matches: pixel count, extent and centroid as fractions of the region. With mask: true, returns an image with matches painted orange. With template, also how well that saved template matches and where (screen.find counts 0.8 and up as seen).',
    properties: { folder, target, region, color: { type: 'string', description: '#rrggbb' }, tolerance: { type: 'number', description: 'Largest per-channel difference that still matches (default 30).' }, minPixels: { type: 'number' }, mask: { type: 'boolean' }, template: { type: 'string' } },
  },
  {
    name: 'wick_save_template',
    method: 'saveTemplate',
    description: 'Save a region of the target window as templates/NAME.png, for ctx.screen.find(region, { template: NAME }). Use it for things one color can\'t pick out: a button, an icon, an item. Draw a tight region around the thing first, save, then search a larger region for it. Templates scale with the window height.',
    properties: { folder, target, name: { type: 'string' }, region },
    required: ['name', 'region'],
  },
  {
    name: 'wick_read',
    method: 'read',
    description: 'Read the text in a region (or the whole game window) with the system\'s text recognition (Vision on macOS, Windows.Media.Ocr on Windows): all the text, and each line with its box as fractions of the region. Use it for counters, item names and menu labels; draw a tight region around the text for the best results.',
    properties: { folder, target, region, fast: { type: 'boolean', description: 'Faster, less accurate recognition (macOS).' } },
  },
  { name: 'wick_templates', method: 'templates', description: 'The macro\'s saved templates.', properties: { folder } },
  { name: 'wick_act', method: 'act', description: 'Send one input to the target window, to test something. Only works while that window has focus.', properties: { folder, target, command }, required: ['command'] },
  {
    name: 'wick_probe',
    method: 'probe',
    description: 'Run an experiment: follow colors in regions for some seconds while sending timed inputs, and return each tracker\'s position over time (fractions of its region). Use it to measure speeds, how far an input moves something, and latency, instead of guessing.',
    properties: {
      folder,
      target,
      track: { type: 'array', description: 'What to follow.', items: { type: 'object', properties: { name: { type: 'string' }, region: { type: 'string' }, color: { type: 'string' }, tolerance: { type: 'number' }, minPixels: { type: 'number' } }, required: ['name', 'region', 'color'] } },
      inputs: { type: 'array', description: 'Inputs to send, by time in ms since the probe started.', items: { type: 'object', properties: { time: { type: 'number' }, command }, required: ['time', 'command'] } },
      clicks: { type: 'object', description: 'Shorthand for evenly spaced clicks.', properties: { count: { type: 'number' }, every: { type: 'number' }, start: { type: 'number' }, at, button: { type: 'string' } } },
      seconds: { type: 'number', description: 'How long to run, up to 60 (default 3).' },
      sampleHz: { type: 'number', description: 'Samples per second in the result (default 60).' },
      regions: { type: 'object', description: 'Extra regions just for this probe, by name: { anchor, x, y, w, h }.' },
    },
    required: ['track'],
  },
  {
    name: 'wick_record',
    method: 'record',
    description: 'Record the target window for up to 10 minutes: keyframes (PNG), a change score per sample and every input in record.jsonl, a contact sheet of the moments that changed most (returned as an image), and storyboard.md, which splits the recording into steps (holds, presses, clicks, mouse turns, waits, screen changes) with each step\'s start and end frame. With you: true, the person\'s own clicks, keys and mouse motion in the game window are logged too: ask them to play one full loop of what the macro should do while it records, starting from a spot they can always get back to (like right after a respawn). With run: true, the macro runs meanwhile.',
    properties: {
      folder,
      target,
      region,
      seconds: { type: 'number', description: 'How long, up to 600 (default 5).' },
      fps: { type: 'number', description: 'Samples per second, 1 to 30 (default 10).' },
      you: { type: 'boolean' },
      run: { type: 'boolean' },
      exact: { type: 'boolean' },
      live: { type: 'boolean', description: 'On sim, record in real time instead of instantly.' },
    },
  },
  {
    name: 'wick_storyboard',
    method: 'storyboard',
    description: 'A recording split into steps, rebuilt from its log: for each step its time range, a label like "hold w 2.1 s, then press e", the actions with times, whether the screen changed all at once at its end, and its start and end keyframes. Returns the storyboard sheet (each step\'s last frame, in order) as an image. Defaults to the newest recording.',
    properties: { folder, recording: { type: 'string', description: 'The recording folder (the "dir" a record call returned).' } },
  },
  {
    name: 'wick_route',
    method: 'route',
    description: 'Turn part of a recording into a route the macro replays with ctx.input.play(route, { until }): storyboard steps ("3" or "3-5") or a time range in seconds. The route keeps the holds, presses, clicks and mouse turns with their timing (times from the route\'s first input). With name, saves it as routes/NAME.js in the macro folder and returns how to import it. Routes get the macro from one known place to another; end them with an until check on what should be on screen there.',
    properties: { folder, recording: { type: 'string' }, steps: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' }, name: { type: 'string' } },
  },
  {
    name: 'wick_pack',
    method: 'pack',
    description: 'Pack the macro into a .wick file to share. Local data and generated editor files are left out; the package carries a SHA-256 of its contents.',
    properties: { folder, out: { type: 'string', description: 'Where to write it (default: next to the macro folder).' } },
  },
  {
    name: 'wick_install',
    method: 'install',
    description: 'Install a macro from a .wick file or link, a wick://install link, a GitHub repo (or repo folder) or a Gist. Without yes: true it only reports what it would install (name, permissions, files, whether it updates an installed copy and asks for new permissions). Only install with yes after the person has agreed: installed macros are other people\'s code.',
    properties: { source: { type: 'string' }, yes: { type: 'boolean' }, macro: { type: 'string', description: 'Which folder, when the source has several macros.' } },
    required: ['source'],
  },
  {
    name: 'wick_calibration',
    method: 'calibration',
    description: 'This user\'s corrections to the macro (kept in app data, never exported): region corrections by name, and color swaps. With color "#from=#to", swap a color the macro tracks for the one this user\'s game shows (find it with wick_detect); "#from=" clears it. reset: true clears everything. Also lists the colors written in the macro\'s code.',
    properties: { folder, color: { type: 'string' }, reset: { type: 'boolean' } },
  },
  { name: 'wick_regions', method: 'regions', description: 'The macro\'s regions. x and y place each region\'s center relative to its anchor; x, y, w and h are in viewport heights.', properties: { folder } },
  {
    name: 'wick_set_region',
    method: 'setRegion',
    description: 'Create or change a region in regions.json. Anchors: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right.',
    properties: { folder, name: { type: 'string' }, anchor: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
    required: ['name'],
  },
  { name: 'wick_remove_region', method: 'removeRegion', description: 'Delete a region from regions.json.', properties: { folder, name: { type: 'string' } }, required: ['name'] },
  {
    name: 'wick_run',
    method: 'run',
    description: 'Run the macro and wait for it to finish or hit the time limit. Returns how it ended, stats and its log. On the sim target it runs instantly unless live is true.',
    properties: { folder, target, seconds: { type: 'number', description: 'Time limit (default 30).' }, live: { type: 'boolean' }, exact: { type: 'boolean', description: 'Send exact input instead of the app\'s human-like profile.' }, settings: { type: 'object' } },
  },
  { name: 'wick_simulate', method: 'simulate', description: 'Run the macro on several simulated bar-minigame games and report how often the tick stayed in the zone.', properties: { folder, seeds: { type: 'number' }, seconds: { type: 'number' }, exact: { type: 'boolean' } } },
  { name: 'wick_telemetry', method: 'telemetry', description: 'The last run\'s result and log.', properties: {} },
  { name: 'wick_runs', method: 'runs', description: 'The macro\'s saved live runs, newest first: how each ended, stats and score. With file, one run in full, including its log and the trace of its last 15 seconds, to find out why it failed.', properties: { folder, file: { type: 'string' }, last: { type: 'number' } } },
  { name: 'wick_stop', method: 'stop', description: 'Stop the running macro.', properties: {} },
  { name: 'wick_new_macro', method: 'newMacro', description: 'Create a new macro folder from the starter template, in the Wick library unless dir is given.', properties: { name: { type: 'string' }, target, dir: { type: 'string' } }, required: ['name'] },
];

const NEEDS_FOLDER = new Set(['observe', 'detect', 'act', 'probe', 'record', 'storyboard', 'route', 'saveTemplate', 'templates', 'read', 'pack', 'calibration', 'regions', 'setRegion', 'removeRegion', 'run', 'simulate', 'runs']);

/** Tool results as MCP content: the JSON, plus any PNG the command saved. */
function content(result) {
  const out = [{ type: 'text', text: JSON.stringify(result, null, 1) }];
  for (const file of [result?.mask, result?.path, result?.storyboard?.sheet]) {
    if (typeof file === 'string' && file.endsWith('.png') && fs.existsSync(file)) {
      out.push({ type: 'image', mimeType: 'image/png', data: fs.readFileSync(file).toString('base64') });
    }
  }
  return out;
}

export async function serveMcp({ local = false, folder: folderOption } = {}, input = process.stdin, output = process.stdout) {
  const defaultFolder = folderOption ? path.resolve(folderOption) : findFolder(process.cwd());
  // One backend, opened on first use; calls that arrive together share it.
  let backend = null;
  const write = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

  async function handle(msg) {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'wick', version: VERSION },
          instructions: 'Wick tools for building Roblox macros from the outside: look at the game window, measure it, edit regions, and run the macro. Input only reaches the target window while it has focus, and F8 stops everything.',
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) } })),
        };
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === msg.params?.name);
        if (!tool) throw Object.assign(new Error(`Unknown tool "${msg.params?.name}"`), { code: -32602 });
        const args = { ...(msg.params.arguments ?? {}) };
        if (NEEDS_FOLDER.has(tool.method) && !args.folder && defaultFolder) args.folder = defaultFolder;
        try {
          backend ??= openBackend({ local });
          return { content: content(await (await backend).call(tool.method, args)) };
        } catch (e) {
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
    }
  }

  const inFlight = new Set();
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      if (msg.id === undefined) continue; // A notification.
      const job = handle(msg).then(
        (result) => write({ id: msg.id, result }),
        (e) => write({ id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
      );
      inFlight.add(job);
      job.finally(() => inFlight.delete(job));
    }
  });
  await once(input, 'end');
  // Let calls that are still running answer before shutting down.
  while (inFlight.size) await Promise.allSettled([...inFlight]);
  if (backend) await (await backend.catch(() => null))?.close();
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}
