// The macro library: a folder of macros (default ~/Documents/Wick), plus
// creating, copying and editing the files the app is allowed to change.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MacroError, TARGETS } from './macro-loader.js';

const SDK = fileURLToPath(new URL('../sdk/wick.d.ts', import.meta.url));

export const ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

export const defaultLibrary = () => path.join(os.homedir(), 'Documents', 'Wick');

/** Lowercase letters, digits and dashes, as macro ids require. */
export function slug(text, fallback = 'macro') {
  const s = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

/** The author part of new macro ids: the user's account name, slugged. */
export function defaultAuthor() {
  try {
    return slug(os.userInfo().username, 'me');
  } catch {
    return 'me';
  }
}

const isMacro = (folder) => fs.existsSync(path.join(folder, 'wick.json'));

/** Macro folders directly inside the library, sorted by name. */
export function listLibrary(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .filter(isMacro)
    .sort((a, b) => a.localeCompare(b));
}

function freeFolder(dir, base) {
  let candidate = path.join(dir, base);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}-${i}`);
  return candidate;
}

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Types for editors, next to the macro so it works wherever the folder goes. */
function addEditorFiles(folder) {
  if (fs.existsSync(SDK)) fs.copyFileSync(SDK, path.join(folder, 'wick.d.ts'));
  writeJson(path.join(folder, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      paths: { wick: ['./wick.d.ts'] },
    },
  });
}

const STARTER = `import { macro, type Context } from "wick";

// A starting point: waits for a color to show up inside the "area" region,
// then logs where it is. Edit regions in Wick's live view, and see
// docs/API.md for everything ctx can do.
export default macro({
  async run(ctx: Context) {
    const marker = ctx.screen.track("area", { color: "#ffffff", tolerance: 30 });
    const found = await ctx.waitUntil(() => marker.seen, { timeout: 5000 });
    ctx.log(found ? \`Found it at x \${marker.x.toFixed(2)}, y \${marker.y.toFixed(2)}\` : "Not found within 5 seconds");
  },
});
`;

/** Creates a new macro from the starter template and returns its folder. */
export function createMacro(dir, { name, target = 'roblox', author = defaultAuthor() } = {}) {
  const title = String(name ?? '').trim() || 'New macro';
  if (!TARGETS.includes(target)) throw new MacroError(`Unknown target "${target}".`);
  fs.mkdirSync(dir, { recursive: true });
  const folder = freeFolder(dir, slug(title));
  fs.mkdirSync(folder);
  writeJson(path.join(folder, 'wick.json'), {
    wick: 1,
    id: `${author}/${path.basename(folder)}`,
    name: title,
    version: '0.1.0',
    description: '',
    author,
    target,
    entry: 'main.ts',
    permissions: [],
    settings: {},
  });
  writeJson(path.join(folder, 'regions.json'), { area: { anchor: 'center', x: 0, y: 0, w: 0.5, h: 0.3 } });
  fs.writeFileSync(path.join(folder, 'main.ts'), STARTER);
  fs.writeFileSync(path.join(folder, 'README.md'), `# ${title}\n\nWhat this macro does, which game it's for, and how to set it up.\n`);
  addEditorFiles(folder);
  writeAgentGuide(folder);
  return folder;
}

/** Copies a macro into the library under the user's own id, so it can be edited. */
export function copyMacro(source, dir, { author = defaultAuthor() } = {}) {
  if (!isMacro(source)) throw new MacroError('That folder isn\'t a Wick macro.');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'wick.json'), 'utf8'));
  const name = slug(manifest.id?.split('/')[1] ?? path.basename(source));
  fs.mkdirSync(dir, { recursive: true });
  const folder = freeFolder(dir, name);
  fs.cpSync(source, folder, {
    recursive: true,
    filter: (p) => !['.git', 'node_modules', '.wick'].includes(path.basename(p)),
  });
  writeJson(path.join(folder, 'wick.json'), {
    ...manifest,
    id: `${author}/${path.basename(folder)}`,
    author,
    version: manifest.version ?? '0.1.0',
  });
  addEditorFiles(folder);
  writeAgentGuide(folder);
  return folder;
}

export function readRegions(folder) {
  const file = path.join(folder, 'regions.json');
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const round = (v) => Math.round(v * 10000) / 10000;

/** Checks and writes regions.json. Returns the regions as written. */
export function saveRegions(folder, regions) {
  if (!regions || typeof regions !== 'object' || Array.isArray(regions)) throw new MacroError('Regions must be an object.');
  const out = {};
  for (const [name, r] of Object.entries(regions)) {
    if (!/^[A-Za-z_][\w-]{0,39}$/.test(name)) {
      throw new MacroError(`"${name}" isn't a usable region name. Start with a letter; use letters, digits, - and _.`);
    }
    if (!ANCHORS.includes(r.anchor ?? 'center')) throw new MacroError(`Region "${name}" has an unknown anchor "${r.anchor}".`);
    const [x, y, w, h] = [r.x ?? 0, r.y ?? 0, r.w, r.h].map(Number);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) throw new MacroError(`Region "${name}" needs numbers, with a positive w and h.`);
    out[name] = { anchor: r.anchor ?? 'center', x: round(x), y: round(y), w: round(w), h: round(h) };
  }
  writeJson(path.join(folder, 'regions.json'), out);
  return out;
}

/** Changes the fields of wick.json the app edits, keeping everything else. */
export function updateManifest(folder, changes) {
  const file = path.join(folder, 'wick.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['name', 'description', 'target', 'permissions']) {
    if (key in changes) manifest[key] = changes[key];
  }
  writeJson(file, manifest);
  return manifest;
}

const AGENT_GUIDE = `# Working on this Wick macro

This folder is a [Wick](https://github.com/ryduzz1/wick) macro: \`wick.json\` (manifest), \`regions.json\` (screen regions), and the entry file (usually \`main.ts\`). The macro API is typed in \`wick.d.ts\`.

You write the macro; you don't play the game. Use the \`wick\` CLI (or the Wick MCP server) from this folder. If \`wick\` isn't on the PATH, run it as \`{{CLI}}\`.

| Command | What it does |
| --- | --- |
| \`wick status\` | Whether Wick, the engine and each target are available. |
| \`wick observe [--region bar]\` | Saves a PNG of the target window (or one region) and prints its path. Look at it. |
| \`wick detect --region bar [--color '#3ccf5a' --tolerance 30] [--mask]\` | The region's main colors, and where a color matches. \`--mask\` saves an image of the matches. |
| \`wick regions\` / \`wick region set bar --anchor bottom-center --x 0 --y -0.18 --w 0.46 --h 0.06\` | List or edit regions. x/y place the center relative to the anchor; all four are in viewport heights. |
| \`wick probe --track tick:bar:#ffffff --clicks 5 --every 300 --seconds 2\` | Follows colors while sending timed input; prints each tracker's position over time. Use it to measure speeds, how far an input moves things, and latency. |
| \`wick act click [--at bar]\` / \`wick act press e\` | Sends one input to test something. |
| \`wick read --region bag\` | Reads the text in a region. In the macro, \`ctx.screen.read(region)\` gives \`.text\` and \`.number\`. |
| \`wick template save sell --region sellButton\` | Saves a tight region as \`templates/sell.png\`; find it in the macro with \`ctx.screen.find(region, { template: "sell" })\`, and check scores with \`wick detect --region R --template sell\`. Use it when one color can't pick something out. |
| \`wick record --seconds 120 [--you] [--run]\` | Saves keyframes, a change score per sample and every input to \`.wick/recordings/\`, plus a contact sheet and \`storyboard.md\` (the recording split into steps). \`--you\` logs the user's own clicks, keys and mouse: ask them to play one full loop of the task from a spot they can always get back to (like right after a respawn). |
| \`wick storyboard\` | The newest recording's steps again: what was held, pressed, clicked and turned, the waits, and the frames at each step's start and end. |
| \`wick route --steps 3-4 --name to-vendor\` | Saves those storyboard steps as \`routes/to-vendor.js\`, for \`ctx.input.play(route, { until })\`. |
| \`wick run [--seconds 20]\` | Runs this macro and prints the result and its log. On the \`sim\` target it runs instantly. |
| \`wick simulate [--seeds 5]\` | Runs this macro on several simulated games (bar minigame only). |
| \`wick telemetry\` | The last run's result again. |
| \`wick runs\` / \`wick runs show FILE\` | Saved live runs, and one in full with its log and the trace of its last seconds. |
| \`wick stop\` | Stops whatever is running. |

Every command takes \`--target roblox|testbench|sim\` (default: the manifest's target) and prints JSON. The same tools are available over MCP (\`wick mcp\`, set up in \`.mcp.json\`) as \`wick_observe\`, \`wick_probe\` and so on; \`wick_observe\` returns the image directly.

## Rules

- Input only reaches the target window while it's focused. If a command says the window doesn't have focus, ask the user to click it.
- F8 stops everything. Never try to work around it, and never touch the Roblox process: Wick only sees the screen and sends ordinary input.
- Macros run in a sandbox with only the Wick API: no files, network or timers outside \`ctx\`.

## How to approach a new game

1. **Look:** \`observe\`, then draw regions around the moving parts (\`region set\`).
2. **Detect:** \`detect\` each region to find the exact colors, and check matches with \`--mask\`.
3. **Measure:** \`probe\` to get the mechanics as numbers instead of guessing. For a task with several parts, \`record --you\` one loop of the user playing and read \`storyboard.md\` and the frames it names.
4. **Write** \`main.ts\` from those numbers. Anything with more than one step (cast, play, sell, repeat) should be a state machine with \`ctx.states()\`: one state per step, a \`timeout\` on each, a \`recover\` state that gets back to a known place, and a \`startPoint\` region checked before each loop. Walking between places is a route cut from the recording, ended by an \`until\` on what the screen shows on arrival. Inside a state, use the state's own \`ctx\`. See the types in \`wick.d.ts\`.
5. **Test:** \`run\` with a short limit, read the result and log, and fix what fails.
6. **Wrap up:** fill in \`settings\`, \`permissions\` and \`README.md\`.
`;

/** Writes AGENTS.md and CLAUDE.md into a macro folder, leaving existing ones alone. */
export function writeAgentGuide(folder) {
  const written = [];
  const agents = path.join(folder, 'AGENTS.md');
  const claude = path.join(folder, 'CLAUDE.md');
  if (!fs.existsSync(agents)) {
    fs.writeFileSync(agents, AGENT_GUIDE.replace('{{CLI}}', cliCommand()));
    written.push(agents);
  }
  if (!fs.existsSync(claude)) {
    fs.writeFileSync(claude, '@AGENTS.md\n');
    written.push(claude);
  }
  // Lets Claude Code (and other clients that read .mcp.json) find Wick's
  // tools when started in this folder. It points at this machine's Wick, so
  // it starts with a dot and is never included when a macro is shared.
  const mcp = path.join(folder, '.mcp.json');
  if (!fs.existsSync(mcp)) {
    fs.writeFileSync(mcp, `${JSON.stringify({ mcpServers: { wick: mcpServer() } }, null, 2)}\n`);
    written.push(mcp);
  }
  return written;
}

const BIN = fileURLToPath(new URL('../bin/wick.js', import.meta.url));

/** The shell command for the CLI on this machine. */
export function cliCommand() {
  const quote = (s) => (/[\s"']/.test(s) ? `"${s}"` : s);
  const env = process.versions.electron ? (process.platform === 'win32' ? 'set ELECTRON_RUN_AS_NODE=1 && ' : 'ELECTRON_RUN_AS_NODE=1 ') : '';
  return `${env}${quote(process.execPath)} ${quote(BIN)}`;
}

/** How to start `wick mcp` on this machine: with Node, or with Electron acting as Node. */
export function mcpServer() {
  return {
    command: process.execPath,
    args: [BIN, 'mcp'],
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  };
}
