// Reads a macro folder, checks its manifest, and strips TypeScript types so
// the engine receives plain JavaScript.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

export const TARGETS = ['roblox', 'testbench', 'sim'];
export const PERMISSIONS = ['mouse.click', 'mouse.move', 'keyboard', 'character.reset', 'game.rejoin'];
const SETTING_TYPES = ['number', 'integer', 'boolean', 'string'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.wick']);

export class MacroError extends Error {}

const fail = (message) => {
  throw new MacroError(message);
};

/** Returns a list of problems with a manifest; empty when it's valid. */
export function checkManifest(m) {
  const problems = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['wick.json must be a JSON object.'];
  if (m.wick !== 1) problems.push('"wick" must be 1 (the format version).');
  if (typeof m.id !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(m.id)) {
    problems.push('"id" must look like "author/macro-name" (lowercase letters, digits and dashes).');
  }
  if (typeof m.name !== 'string' || !m.name.trim()) problems.push('"name" is required.');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) problems.push('"version" must look like "1.0.0".');
  if (!TARGETS.includes(m.target)) problems.push(`"target" must be one of: ${TARGETS.join(', ')}.`);
  if (m.entry !== undefined && typeof m.entry !== 'string') problems.push('"entry" must be a file name.');
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) problems.push('"permissions" must be a list.');
    else for (const p of m.permissions) if (!PERMISSIONS.includes(p)) problems.push(`Unknown permission "${p}". Use: ${PERMISSIONS.join(', ')}.`);
  }
  if (m.settings !== undefined) {
    if (!m.settings || typeof m.settings !== 'object' || Array.isArray(m.settings)) problems.push('"settings" must be an object.');
    else for (const [key, s] of Object.entries(m.settings)) {
      if (!s || !SETTING_TYPES.includes(s.type)) problems.push(`Setting "${key}" needs a "type": ${SETTING_TYPES.join(', ')}.`);
    }
  }
  return problems;
}

/** Manifest defaults, overridden by the user's values where they're valid. */
export function resolveSettings(manifest, overrides = {}) {
  const out = {};
  for (const [key, s] of Object.entries(manifest.settings ?? {})) {
    let value = key in overrides ? overrides[key] : s.default;
    if (s.type === 'number' || s.type === 'integer') {
      value = Number(value);
      if (!Number.isFinite(value)) value = Number(s.default ?? 0);
      if (s.type === 'integer') value = Math.round(value);
      if (typeof s.min === 'number') value = Math.max(s.min, value);
      if (typeof s.max === 'number') value = Math.min(s.max, value);
    } else if (s.type === 'boolean') {
      value = Boolean(value);
    } else {
      value = value == null ? '' : String(value);
    }
    out[key] = value;
  }
  return out;
}

async function sourceFiles(folder, dir = folder, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(folder, path, out);
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Turns TypeScript into JavaScript by erasing types; positions stay the same. */
export function stripTypes(source, file) {
  try {
    return stripTypeScriptTypes(source, { mode: 'strip' });
  } catch (e) {
    fail(`${file}: ${e.message}. Wick macros can use type annotations, but not "enum", "namespace" or other TypeScript that needs compiling.`);
  }
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${label} isn't valid JSON: ${e.message}`);
  }
}

/** Loads a macro folder into the shape the engine's macro.run expects. */
export async function loadMacro(folder, { settings: overrides } = {}) {
  const manifest = await readJson(join(folder, 'wick.json'), 'wick.json');
  if (manifest === undefined) fail(`There's no wick.json in ${folder}.`);
  const problems = checkManifest(manifest);
  if (problems.length) fail(`wick.json has problems:\n- ${problems.join('\n- ')}`);
  const regions = (await readJson(join(folder, 'regions.json'), 'regions.json')) ?? {};
  const entry = manifest.entry ?? 'main.ts';
  const files = {};
  for (const path of await sourceFiles(folder)) {
    const key = relative(folder, path).split(sep).join('/');
    const source = await readFile(path, 'utf8');
    files[key] = key.endsWith('.ts') ? stripTypes(source, key) : source;
  }
  if (!(entry in files)) fail(`The entry file "${entry}" is missing.`);
  return {
    id: manifest.id,
    name: manifest.name,
    target: manifest.target,
    entry,
    files,
    permissions: manifest.permissions ?? [],
    regions,
    settings: resolveSettings(manifest, overrides),
    manifest,
  };
}
