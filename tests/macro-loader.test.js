import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkManifest, humanProfile, loadMacro, resolveSettings } from '../app/macro-loader.js';

const example = fileURLToPath(new URL('../examples/bar-minigame/', import.meta.url));

const manifest = (extra = {}) => ({
  wick: 1,
  id: 'me/test',
  name: 'Test',
  version: '1.0.0',
  target: 'sim',
  ...extra,
});

async function folder(files) {
  const dir = await mkdtemp(join(tmpdir(), 'wick-macro-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('accepts a valid manifest', () => {
  assert.deepEqual(checkManifest(manifest({ permissions: ['mouse.click'] })), []);
});

test('explains manifest problems', () => {
  const problems = checkManifest({ wick: 2, id: 'Bad Id', target: 'nowhere', permissions: ['root'], settings: { a: {} } });
  assert.ok(problems.some((p) => p.includes('"wick" must be 1')));
  assert.ok(problems.some((p) => p.includes('author/macro-name')));
  assert.ok(problems.some((p) => p.includes('"target"')));
  assert.ok(problems.some((p) => p.includes('Unknown permission "root"')));
  assert.ok(problems.some((p) => p.includes('Setting "a"')));
});

test('resolves settings with defaults, overrides and limits', () => {
  const m = { settings: { gap: { type: 'number', default: 40, min: 10, max: 100 }, on: { type: 'boolean', default: true }, n: { type: 'integer', default: 2 } } };
  assert.deepEqual(resolveSettings(m), { gap: 40, on: true, n: 2 });
  assert.deepEqual(resolveSettings(m, { gap: 500, on: false, n: 2.6 }), { gap: 100, on: false, n: 3 });
  assert.deepEqual(resolveSettings(m, { gap: 'abc' }), { gap: 40, on: true, n: 2 });
});

test('loads the example and strips its types', async () => {
  const m = await loadMacro(example);
  assert.equal(m.id, 'wick/bar-minigame');
  assert.equal(m.entry, 'main.ts');
  assert.deepEqual(m.permissions, ['mouse.click']);
  assert.ok(m.regions.bar);
  assert.equal(m.settings.minGap, 60);
  assert.ok(!m.files['main.ts'].includes('ctx: Context'), 'type annotations are removed');
  assert.ok(m.files['main.ts'].includes('screen.track("bar"'));
  assert.ok(!Object.keys(m.files).some((f) => f.endsWith('.d.ts') || f.endsWith('.json')));
});

test('loads nested files and ignores dot folders', async () => {
  const dir = await folder({
    'wick.json': manifest(),
    'main.ts': 'import { f } from "./lib/f"; export default { async run() { f(); } };',
    'lib/f.ts': 'export const f = (): number => 1;',
    '.wick/cache.js': 'nope',
  });
  try {
    const m = await loadMacro(dir);
    assert.deepEqual(Object.keys(m.files).sort(), ['lib/f.ts', 'main.ts']);
    assert.ok(!m.files['lib/f.ts'].includes(': number'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects TypeScript that needs compiling', async () => {
  const dir = await folder({ 'wick.json': manifest(), 'main.ts': 'enum Mode { A, B }\nexport default { async run() {} };' });
  try {
    await assert.rejects(loadMacro(dir), /not "enum"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports a missing entry or manifest', async () => {
  const noEntry = await folder({ 'wick.json': manifest(), 'other.ts': '' });
  const noManifest = await folder({ 'main.ts': '' });
  try {
    await assert.rejects(loadMacro(noEntry), /entry file "main.ts" is missing/);
    await assert.rejects(loadMacro(noManifest), /no wick.json/);
  } finally {
    await rm(noEntry, { recursive: true, force: true });
    await rm(noManifest, { recursive: true, force: true });
  }
});

test('turns the input preference into a human profile', () => {
  assert.deepEqual(humanProfile(undefined, 3), { precision: 0.85, seed: 3 });
  assert.deepEqual(humanProfile({ precision: 2 }, 1), { precision: 1, seed: 1 });
  assert.equal(humanProfile({ human: false }), null);
});
