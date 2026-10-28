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
