import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyMacro, createMacro, listLibrary, readRegions, saveRegions, slug, updateManifest } from '../app/library.js';
import { checkManifest, loadMacro } from '../app/macro-loader.js';
import { nearestAnchor, rectRegion, regionRect } from '../app/ui/live.js';

const example = fileURLToPath(new URL('../examples/bar-minigame/', import.meta.url));

async function withLibrary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wick-library-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const manifestOf = (folder) => JSON.parse(fs.readFileSync(join(folder, 'wick.json'), 'utf8'));

test('slugs names into ids', () => {
  assert.equal(slug('Fishing Loop!'), 'fishing-loop');
  assert.equal(slug('  Café  2 '), 'cafe-2');
  assert.equal(slug('???'), 'macro');
});

test('creates a macro that loads and runs on the simulator', () =>
  withLibrary(async (dir) => {
    const folder = createMacro(dir, { name: 'Fishing loop', target: 'sim', author: 'tester' });
    assert.equal(folder, join(dir, 'fishing-loop'));
    const manifest = manifestOf(folder);
    assert.deepEqual(checkManifest(manifest), []);
    assert.equal(manifest.id, 'tester/fishing-loop');
    assert.ok(fs.existsSync(join(folder, 'wick.d.ts')), 'types for editors');
    const spec = await loadMacro(folder);
    assert.deepEqual(Object.keys(spec.files), ['main.ts']);
    assert.ok(spec.regions.area);
    // A second macro with the same name gets its own folder.
    assert.equal(createMacro(dir, { name: 'Fishing loop', author: 'tester' }), join(dir, 'fishing-loop-2'));
    assert.deepEqual(listLibrary(dir), [join(dir, 'fishing-loop'), join(dir, 'fishing-loop-2')]);
  }));

test('copies an example under the user\'s id', () =>
  withLibrary(async (dir) => {
    const folder = copyMacro(example, dir, { author: 'tester' });
    const manifest = manifestOf(folder);
    assert.equal(manifest.id, 'tester/bar-minigame');
    assert.equal(manifest.name, 'Bar minigame');
    assert.deepEqual(manifest.permissions, ['mouse.click']);
    const spec = await loadMacro(folder);
    assert.ok(spec.files['main.ts'].includes('screen.track'));
    const tsconfig = JSON.parse(fs.readFileSync(join(folder, 'tsconfig.json'), 'utf8'));
    assert.deepEqual(tsconfig.compilerOptions.paths.wick, ['./wick.d.ts']);
  }));

test('saves regions, rounding and validating them', () =>
  withLibrary(async (dir) => {
    const folder = createMacro(dir, { name: 'R', author: 'tester' });
    const saved = saveRegions(folder, { bar: { anchor: 'bottom-center', x: 0.123456, y: -0.2, w: 0.4, h: 0.05 } });
    assert.deepEqual(saved.bar, { anchor: 'bottom-center', x: 0.1235, y: -0.2, w: 0.4, h: 0.05 });
    assert.deepEqual(readRegions(folder), saved);
    assert.throws(() => saveRegions(folder, { '1bad': { w: 1, h: 1 } }), /isn't a usable region name/);
    assert.throws(() => saveRegions(folder, { a: { anchor: 'middle', w: 1, h: 1 } }), /unknown anchor/);
    assert.throws(() => saveRegions(folder, { a: { w: 0, h: 1 } }), /positive w and h/);
  }));

test('updates only the manifest fields the app edits', () =>
  withLibrary(async (dir) => {
    const folder = createMacro(dir, { name: 'M', author: 'tester' });
    updateManifest(folder, { name: 'Renamed', permissions: ['keyboard'], id: 'evil/change' });
    const manifest = manifestOf(folder);
    assert.equal(manifest.name, 'Renamed');
    assert.deepEqual(manifest.permissions, ['keyboard']);
    assert.equal(manifest.id, 'tester/m');
  }));

test('region math matches the engine and round-trips', () => {
  // A 1000×600 frame whose viewport starts 28 px down (a title bar).
  const vp = { x: 0, y: 28 / 600, w: 1, h: 572 / 600 };
  const aspect = 1000 / 600;
  const spec = { anchor: 'bottom-center', x: 0, y: -0.18, w: 0.46, h: 0.06 };
  const rect = regionRect(spec, vp, aspect);
  // The engine: unit = 572 px; center = (500, 28 + 572 - 0.18 * 572).
  const unit = 572;
  const cx = 500;
  const cy = 28 + 572 - 0.18 * unit;
  assert.ok(Math.abs(rect.x * 1000 - (cx - 0.23 * unit)) < 1e-6);
  assert.ok(Math.abs(rect.y * 600 - (cy - 0.03 * unit)) < 1e-6);
  assert.ok(Math.abs(rect.w * 1000 - 0.46 * unit) < 1e-6);
  assert.deepEqual(rectRegion(rect, 'bottom-center', vp, aspect), spec);
  // Changing the anchor keeps the region in place.
  const moved = rectRegion(rect, 'top-left', vp, aspect);
  const again = regionRect(moved, vp, aspect);
  assert.ok(Math.abs(again.x - rect.x) < 1e-3 && Math.abs(again.y - rect.y) < 1e-3);
  assert.equal(nearestAnchor(rect, vp), 'bottom-center');
  assert.equal(nearestAnchor({ x: 0.01, y: 0.1, w: 0.1, h: 0.1 }, vp), 'top-left');
});
