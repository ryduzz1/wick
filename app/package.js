// Sharing macros: `.wick` packages, installing from files and links, and
// updates.
//
// A `.wick` file is the macro folder as a zip, with a SHA-256 of its
// contents in the archive comment. The hash catches damage and changes
// made after export; it isn't a signature. What keeps an installed macro
// safe is the sandbox, its declared permissions, and the install screen,
// which shows everything (README, permissions and every file) before
// anything is written.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { addEditorFiles, listLibrary, slug, writeAgentGuide } from './library.js';
import { checkManifest, MacroError } from './macro-loader.js';

const MAX_FILES = 400;
const MAX_BYTES = 20 * 1024 * 1024;
const COMMENT_PREFIX = 'wick-sha256:';
// Made again on install, or personal to whoever exported it.
const LEAVE_OUT = new Set(['node_modules', 'AGENTS.md', 'CLAUDE.md', 'wick.d.ts']);

export const PERMISSION_TEXT = {
  'mouse.click': 'Click the mouse in the game window',
  'mouse.move': 'Move the mouse and turn the camera in the game window',
  keyboard: 'Press keys in the game window',
  'character.reset': 'Reset your character (Esc, R, Enter)',
  'game.rejoin': 'Rejoin the game after a disconnect',
};

// MARK: Files and hashes

/** A macro folder's files to share, by path with forward slashes, sorted. */
export function collectFiles(folder) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || LEAVE_OUT.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(folder, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  walk(folder);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The SHA-256 of a set of files: each path with the hash of its bytes. */
export function contentHash(files) {
  const h = crypto.createHash('sha256');
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    h.update(`${name}\0${crypto.createHash('sha256').update(data).digest('hex')}\n`);
  }
  return h.digest('hex');
}

/** Whether a path inside a package is safe to write under a folder. */
export function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 240) return false;
  if (name.includes('\\') || name.includes(':') || name.startsWith('/')) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}

// MARK: Zip

// A fixed timestamp (1980-01-01), so the same files make the same package.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function writeZip(files, comment = '') {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(central);
  const commentBytes = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...parts, cd, end, commentBytes]);
}

/** Reads a zip into files by path, with its comment. Folders are skipped. */
export function readZip(buffer) {
  const bad = (why) => new MacroError(`That isn't a package Wick can read: ${why}.`);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('not a zip file');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  let p = buffer.readUInt32LE(eocd + 16);
  const comment = buffer.subarray(eocd + 22, eocd + 22 + buffer.readUInt16LE(eocd + 20)).toString('utf8');
  if (count === 0xffff || cdSize === 0xffffffff || p + cdSize > buffer.length) throw bad('too large, or damaged');
  if (count > MAX_FILES * 4) throw bad('too many files');
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw bad('damaged file list');
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const csize = buffer.readUInt32LE(p + 20);
    const usize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw bad(`"${name}" is encrypted`);
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw bad('damaged entry');
    total += usize;
    if (total > MAX_BYTES) throw bad(`it unpacks to more than ${MAX_BYTES / 1024 / 1024} MB`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(usize, 1) });
    else throw bad(`"${name}" uses an unsupported compression`);
    if (data.length !== usize || zlib.crc32(data) !== crc) throw bad(`"${name}" is damaged`);
    files.set(name, data);
  }
  return { files, comment };
}

// MARK: Packages

/** Packs a macro folder into a `.wick` buffer. */
export function packMacro(folder) {
  const files = collectFiles(folder);
  if (!files.has('wick.json')) throw new MacroError('That folder has no wick.json, so it isn\'t a Wick macro.');
  if (files.size > MAX_FILES) throw new MacroError(`A macro can share at most ${MAX_FILES} files.`);
  const hash = contentHash(files);
  const manifest = JSON.parse(files.get('wick.json').toString('utf8'));
  return { buffer: writeZip(files, `${COMMENT_PREFIX}${hash}`), hash, manifest, files: files.size };
}

/** Writes `.wick` next to wherever the user chose. */
export function exportMacro(folder, file) {
  const pack = packMacro(folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pack.buffer);
  return { file, hash: pack.hash, bytes: pack.buffer.length, files: pack.files };
}

/**
 * The macros inside a set of files: one at the root, or one per folder
 * that has a wick.json (as in a GitHub repo of several macros, or a
 * repo zip with a top folder). Each comes back with its paths relative to
 * its own folder.
 */
export function macrosIn(files) {
  const roots = [...files.keys()]
    .filter((name) => name === 'wick.json' || name.endsWith('/wick.json'))
    .map((name) => name.slice(0, -'wick.json'.length))
    .sort((a, b) => a.length - b.length);
  // A macro nested inside another one belongs to it.
  const top = roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(o))).sort();
  return top.map((prefix) => {
    const own = new Map();
    for (const [name, data] of files) {
      if (name.startsWith(prefix)) own.set(name.slice(prefix.length), data);
    }
    return { folder: prefix.replace(/\/$/, ''), files: own };
  });
}

const textLike = (name) => /\.(ts|js|mjs|json|md|txt)$/i.test(name);

/** The library folder of an installed macro with this id, if any. */
export function findInstalled(libraryDir, id) {
  for (const folder of listLibrary(libraryDir)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(folder, 'wick.json'), 'utf8')).id === id) return folder;
    } catch {}
  }
  return null;
}

export function installInfo(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, '.wick', 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What the install screen shows: the manifest, README, permissions, every
 * file, whether the contents match the package's hash, and whether this
 * would update an installed copy (and ask for new permissions).
 */
export function inspect(files, { libraryDir, declaredHash = null } = {}) {
  const problems = [];
  for (const name of files.keys()) if (!safePath(name)) problems.push(`"${name}" isn't a safe file name.`);
  if (files.size > MAX_FILES) problems.push(`It has more than ${MAX_FILES} files.`);
  let manifest = null;
  try {
    manifest = JSON.parse(files.get('wick.json')?.toString('utf8') ?? 'null');
  } catch (e) {
    problems.push(`wick.json isn't valid JSON: ${e.message}`);
  }
  if (!manifest) problems.push('There\'s no wick.json.');
  else problems.push(...checkManifest(manifest));
  const entry = manifest?.entry ?? 'main.ts';
  if (manifest && !files.has(entry)) problems.push(`The entry file "${entry}" is missing.`);
  const hash = contentHash(files);
  const permissions = manifest?.permissions ?? [];
  const existingFolder = manifest?.id && libraryDir ? findInstalled(libraryDir, manifest.id) : null;
  let existing = null;
  if (existingFolder) {
    const old = JSON.parse(fs.readFileSync(path.join(existingFolder, 'wick.json'), 'utf8'));
    existing = { folder: existingFolder, version: old.version ?? null, permissions: old.permissions ?? [], hash: installInfo(existingFolder)?.hash ?? null };
  }
  return {
    manifest,
    readme: files.get('README.md')?.toString('utf8') ?? null,
    permissions: permissions.map((p) => ({ name: p, text: PERMISSION_TEXT[p] ?? p })),
    files: [...files].map(([name, data]) => ({ name, bytes: data.length, text: textLike(name) && data.length < 200_000 ? data.toString('utf8') : null })),
    hash,
    intact: declaredHash == null ? null : declaredHash === hash,
    existing,
    sameAsInstalled: Boolean(existing?.hash && existing.hash === hash),
    addedPermissions: existing ? permissions.filter((p) => !existing.permissions.includes(p)) : [],
    problems,
  };
}

/** Reads a `.wick` buffer: its files and whether they match its hash. */
export function openPackage(buffer) {
  const { files, comment } = readZip(buffer);
  const declaredHash = comment.startsWith(COMMENT_PREFIX) ? comment.slice(COMMENT_PREFIX.length).trim() : null;
  return { files, declaredHash };
}

/**
 * Writes a macro into the library: a new folder, or over the installed copy
 * with the same id. Settings and calibration live in app data, keyed by
 * id, so an update keeps them. Local data in `.wick/` stays too.
 */
export function install(files, libraryDir, { source = null } = {}) {
  const info = inspect(files, { libraryDir });
  if (info.problems.length) throw new MacroError(`This macro can't be installed:\n- ${info.problems.join('\n- ')}`);
  const { manifest } = info;
  let folder = info.existing?.folder;
  if (folder) {
    for (const entry of fs.readdirSync(folder)) {
      if (!entry.startsWith('.')) fs.rmSync(path.join(folder, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(libraryDir, { recursive: true });
    const base = slug(manifest.id?.split('/')[1] ?? manifest.name);
    folder = path.join(libraryDir, base);
    for (let i = 2; fs.existsSync(folder); i++) folder = path.join(libraryDir, `${base}-${i}`);
    fs.mkdirSync(folder);
  }
  for (const [name, data] of files) {
    const file = path.join(folder, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  addEditorFiles(folder);
  writeAgentGuide(folder);
  fs.mkdirSync(path.join(folder, '.wick'), { recursive: true });
  const record = { source, hash: info.hash, version: manifest.version ?? null, installedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(folder, '.wick', 'install.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { folder, updated: Boolean(info.existing), previousVersion: info.existing?.version ?? null, version: manifest.version ?? null, addedPermissions: info.addedPermissions };
}

// MARK: Sources

/**
 * Where to download a macro from: a `.wick` link, a `wick://install?url=…`
 * link, a GitHub repo (optionally a branch and subfolder), or a Gist.
 */
export function resolveSource(input, { allowHttp = false } = {}) {
  let text = String(input ?? '').trim();
  if (text.startsWith('wick://')) {
    const url = new URL(text);
    if (url.hostname !== 'install' && url.pathname.replace(/^\/+/, '') !== 'install') throw new MacroError('Wick links look like wick://install?url=….');
    text = url.searchParams.get('url') ?? '';
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new MacroError('That isn\'t a link Wick can install from.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && local && url.protocol === 'http:')) throw new MacroError('Wick only installs from https links.');
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'github.com' && parts.length >= 2) {
    const [owner, repo, kind, ref, ...sub] = parts;
    const name = repo.replace(/\.git$/, '');
    const branch = kind === 'tree' && ref ? ref : null;
    return {
      kind: 'github',
      url: url.href,
      download: `https://api.github.com/repos/${owner}/${name}/zipball${branch ? `/${encodeURIComponent(branch)}` : ''}`,
      subfolder: branch ? sub.join('/') : '',
    };
  }
  if (url.hostname === 'gist.github.com' && parts.length >= 1) {
    return { kind: 'gist', url: url.href, download: `https://api.github.com/gists/${parts.at(-1)}` };
  }
  return { kind: 'package', url: url.href, download: url.href };
}

async function download(url, fetchImpl, accept) {
  const res = await fetchImpl(url, { headers: { accept, 'user-agent': 'Wick' }, redirect: 'follow' });
  if (!res.ok) throw new MacroError(`Couldn't download ${url} (${res.status}).`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new MacroError('That download is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new MacroError('That download is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads a source and returns the macros in it, each with its files and
 * the hash its package declared (for `.wick` files).
 */
export async function fetchSource(input, { fetch: fetchImpl = globalThis.fetch, allowHttp = false } = {}) {
  const source = resolveSource(input, { allowHttp });
  if (source.kind === 'gist') {
    const gist = JSON.parse((await download(source.download, fetchImpl, 'application/vnd.github+json')).toString('utf8'));
    const files = new Map();
    for (const f of Object.values(gist.files ?? {})) {
      const content = f.truncated ? (await download(f.raw_url, fetchImpl, '*/*')).toString('utf8') : f.content;
      files.set(f.filename, Buffer.from(content ?? '', 'utf8'));
    }
    return { source, macros: [{ folder: '', files, declaredHash: null }] };
  }
  const buffer = await download(source.download, fetchImpl, source.kind === 'github' ? 'application/vnd.github+json' : 'application/octet-stream');
  const { files, declaredHash } = openPackage(buffer);
  let macros = macrosIn(files).map((m) => ({ ...m, declaredHash: source.kind === 'package' && m.folder === '' ? declaredHash : null }));
  if (source.kind === 'github') {
    // Repo zips put everything in a top folder named after the commit.
    macros = macros.map((m) => ({ ...m, folder: m.folder.split('/').slice(1).join('/') }));
    if (source.subfolder) macros = macros.filter((m) => m.folder === source.subfolder || m.folder.startsWith(`${source.subfolder}/`));
  }
  if (!macros.length) throw new MacroError('There\'s no Wick macro (no wick.json) at that link.');
  return { source, macros };
}
