// Sharing: .wick packages, installs, updates and the sources they come from.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyMacro } from '../app/library.js';
import {
  collectFiles,
  contentHash,
  fetchSource,
  inspect,
  install,
  installInfo,
  macrosIn,
  openPackage,
  packMacro,
  readZip,
  resolveSource,
  safePath,
  writeZip,
} from '../app/package.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let dir;
let macro;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wick-package-'));
  macro = copyMacro(join(root, 'examples', 'fishing-trip'), join(dir, 'author'), { author: 'tester' });
  fs.mkdirSync(join(macro, '.wick', 'recordings'), { recursive: true });
  fs.writeFileSync(join(macro, '.wick', 'recordings', 'x.txt'), 'local only');
});

after(() => rm(dir, { recursive: true, force: true }));

test('packs a macro without local or generated files, the same way every time', () => {
  const a = packMacro(macro);
  const b = packMacro(macro);
  assert.ok(a.buffer.equals(b.buffer), 'deterministic');
  const { files, declaredHash } = openPackage(a.buffer);
  assert.equal(declaredHash, a.hash);
  assert.equal(contentHash(files), a.hash);
  const names = [...files.keys()];
  assert.ok(names.includes('wick.json') && names.includes('main.ts') && names.includes('routes/to-dock.js'));
  for (const left of ['AGENTS.md', 'CLAUDE.md', 'wick.d.ts', '.wick/recordings/x.txt']) assert.ok(!names.includes(left), left);
  assert.deepEqual(files.get('main.ts'), fs.readFileSync(join(macro, 'main.ts')));
});

test('notices a package changed after export', () => {
  const { buffer } = packMacro(macro);
  const { files, comment } = readZip(buffer);
  files.set('main.ts', Buffer.from('export default { async run() {} };'));
  const changed = openPackage(writeZip(files, comment));
  const info = inspect(changed.files, { declaredHash: changed.declaredHash });
  assert.equal(info.intact, false);
  const original = openPackage(buffer);
  assert.equal(inspect(original.files, { declaredHash: original.declaredHash }).intact, true);
});

test('refuses unsafe paths and broken manifests', () => {
  assert.equal(safePath('main.ts'), true);
  assert.equal(safePath('routes/to-dock.js'), true);
  for (const bad of ['../evil.js', '/etc/passwd', 'a/../../b', 'C:\\x', '.hidden', 'a/.git/config', '']) assert.equal(safePath(bad), false, bad);
  const files = collectFiles(macro);
  files.set('../evil.js', Buffer.from('x'));
  assert.match(inspect(files).problems.join('\n'), /"\.\.\/evil\.js" isn't a safe file name/);
  const broken = new Map([['wick.json', Buffer.from('{"wick": 1}')]]);
  assert.ok(inspect(broken).problems.length > 0);
  assert.throws(() => install(broken, join(dir, 'never')), /can't be installed/);
  assert.equal(fs.existsSync(join(dir, 'never')), false, 'nothing written');
  assert.throws(() => readZip(Buffer.from('not a zip at all, just text that goes on')), /isn't a package/);
});

test('installs, then updates in place keeping local data and noting new permissions', () => {
  const lib = join(dir, 'library');
  const { buffer } = packMacro(macro);
  const first = openPackage(buffer);
  const before = inspect(first.files, { libraryDir: lib, declaredHash: first.declaredHash });
  assert.equal(before.existing, null);
  assert.ok(before.permissions.some((p) => p.name === 'keyboard' && /keys/.test(p.text)));
  assert.ok(before.files.find((f) => f.name === 'main.ts').text.includes('ctx.states'));
  const installed = install(first.files, lib, { source: { kind: 'file', url: 'trip.wick' } });
  assert.equal(installed.updated, false);
  assert.ok(fs.existsSync(join(installed.folder, 'routes', 'to-vendor.js')));
  assert.ok(fs.existsSync(join(installed.folder, 'wick.d.ts')), 'editor files made again');
  assert.ok(fs.existsSync(join(installed.folder, 'AGENTS.md')));
  assert.equal(installInfo(installed.folder).hash, before.hash);
  fs.writeFileSync(join(installed.folder, '.wick', 'mine.txt'), 'keep me');

  // Version 0.2.0 drops demo.json and asks to rejoin games.
  const next = new Map(first.files);
  const manifest = JSON.parse(next.get('wick.json'));
  next.set('wick.json', Buffer.from(JSON.stringify({ ...manifest, version: '0.2.0', permissions: [...manifest.permissions, 'game.rejoin'] })));
  next.delete('demo.json');
  const update = inspect(next, { libraryDir: lib });
  assert.equal(update.existing.folder, installed.folder);
  assert.equal(update.existing.version, '0.1.0');
  assert.deepEqual(update.addedPermissions, ['game.rejoin']);
  assert.equal(inspect(first.files, { libraryDir: lib }).sameAsInstalled, true);
  const updated = install(next, lib);
  assert.equal(updated.folder, installed.folder);
  assert.deepEqual([updated.updated, updated.previousVersion, updated.version], [true, '0.1.0', '0.2.0']);
  assert.equal(fs.existsSync(join(installed.folder, 'demo.json')), false, 'removed files go');
  assert.equal(fs.readFileSync(join(installed.folder, '.wick', 'mine.txt'), 'utf8'), 'keep me');
});

test('reads links to packages, repos and gists', () => {
  assert.deepEqual(resolveSource('https://example.com/trip.wick'), { kind: 'package', url: 'https://example.com/trip.wick', download: 'https://example.com/trip.wick' });
  assert.equal(resolveSource('wick://install?url=https%3A%2F%2Fexample.com%2Ftrip.wick').download, 'https://example.com/trip.wick');
  assert.deepEqual(resolveSource('https://github.com/someone/macros'), { kind: 'github', url: 'https://github.com/someone/macros', download: 'https://api.github.com/repos/someone/macros/zipball', subfolder: '' });
  const sub = resolveSource('https://github.com/someone/macros/tree/main/fishing/trip');
  assert.equal(sub.download, 'https://api.github.com/repos/someone/macros/zipball/main');
  assert.equal(sub.subfolder, 'fishing/trip');
  assert.equal(resolveSource('https://gist.github.com/someone/abc123').download, 'https://api.github.com/gists/abc123');
  assert.throws(() => resolveSource('http://example.com/x.wick'), /only installs from https/);
  assert.throws(() => resolveSource('file:///etc/passwd'), /only installs from https/);
  assert.throws(() => resolveSource('nonsense'), /isn't a link/);
});

test('finds the macros in a repo with several', async () => {
  const files = collectFiles(macro);
  const repo = new Map();
  for (const [name, data] of files) {
    repo.set(`someone-macros-abc123/trip/${name}`, data);
    repo.set(`someone-macros-abc123/other/${name}`, data);
  }
  repo.set('someone-macros-abc123/README.md', Buffer.from('# Macros'));
  assert.deepEqual(macrosIn(repo).map((m) => m.folder), ['someone-macros-abc123/other', 'someone-macros-abc123/trip']);
  const zip = writeZip(repo);
  const fake = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/someone/macros/zipball/main');
    return new Response(zip);
  };
  const all = await fetchSource('https://github.com/someone/macros/tree/main', { fetch: fake });
  assert.deepEqual(all.macros.map((m) => m.folder), ['other', 'trip']);
  const one = await fetchSource('https://github.com/someone/macros/tree/main/trip', { fetch: fake });
  assert.deepEqual(one.macros.map((m) => m.folder), ['trip']);
  assert.ok(one.macros[0].files.has('wick.json'));
});

test('downloads a package and a gist', async () => {
  const { buffer, hash } = packMacro(macro);
  const pkg = await fetchSource('https://example.com/trip.wick', { fetch: async () => new Response(buffer) });
  assert.equal(pkg.macros[0].declaredHash, hash);
  const gist = {
    files: {
      'wick.json': { filename: 'wick.json', content: fs.readFileSync(join(macro, 'wick.json'), 'utf8') },
      'main.ts': { filename: 'main.ts', truncated: true, raw_url: 'https://gist.githubusercontent.com/raw/main.ts' },
    },
  };
  const fake = async (url) => (url.endsWith('/gists/abc') ? Response.json(gist) : new Response('export default {};'));
  const fromGist = await fetchSource('https://gist.github.com/someone/abc', { fetch: fake });
  assert.equal(fromGist.macros[0].files.get('main.ts').toString(), 'export default {};');
  await assert.rejects(fetchSource('https://example.com/x.wick', { fetch: async () => new Response('nope', { status: 404 }) }), /404/);
});
