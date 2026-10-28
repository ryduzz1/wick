// End-to-end tests against the real engine binary, on the `sim` target.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EngineClient } from '../app/engine-client.js';
import { loadMacro } from '../app/macro-loader.js';

const example = fileURLToPath(new URL('../examples/bar-minigame/', import.meta.url));
let engine;

before(async () => {
  engine = new EngineClient({ restart: false });
  const ready = new Promise((resolve) => engine.once('ready', resolve));
  engine.start();
  await ready;
});

after(async () => {
  await engine.stop();
});

const nextEvent = (name, match = () => true, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off(name, listener);
      reject(new Error(`No ${name} event within ${timeout} ms`));
    }, timeout);
    const listener = (params) => {
      if (!match(params)) return;
      clearTimeout(timer);
      engine.off(name, listener);
      resolve(params);
    };
    engine.on(name, listener);
  });

const inline = (main, extra = {}) => ({
  id: 'test/inline',
  name: 'Inline',
  entry: 'main.ts',
  files: { 'main.ts': main },
  permissions: ['mouse.click'],
  regions: { bar: { anchor: 'bottom-center', x: 0, y: -0.18, w: 0.46, h: 0.06 } },
  settings: {},
  ...extra,
});

test('answers basic requests', async () => {
  assert.equal(await engine.call('ping'), 'pong');
  const v = await engine.call('version');
  assert.equal(v.protocol, 1);
  const targets = await engine.call('targets.list');
  assert.deepEqual(targets.map((t) => t.id), ['roblox', 'testbench', 'sim']);
  await assert.rejects(engine.call('nope'), /Unknown method "nope"/);
});

test('the example macro keeps the tick in the zone on 20 simulated games', async () => {
  const spec = await loadMacro(example);
  const runs = await Promise.all(
    // Fixed human-profile seeds too, so the result doesn't vary run to run.
    Array.from({ length: 20 }, (_, i) => engine.call('sim.run', { macro: { ...spec, human: spec.human && { ...spec.human, seed: i + 1 } }, scenario: { seed: i + 1 }, seconds: 30 })),
  );
  for (const r of runs) assert.notEqual(r.end.reason, 'error', r.end.error);
  const scores = runs.map((r) => r.score.inZone);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  // Measured at about 0.90 average and 0.88 minimum when this test was written.
  assert.ok(avg >= 0.87, `average ${avg.toFixed(3)}`);
  assert.ok(min >= 0.82, `worst game ${min.toFixed(3)}`);
});

test('a macro that never clicks loses', async () => {
  const idle = inline('export default { async run(ctx) { await ctx.wait(1e9); } };');
  const r = await engine.call('sim.run', { macro: idle, seconds: 20 });
  assert.ok(r.score.inZone < 0.3, `idle scored ${r.score.inZone}`);
});

test('undeclared input stops the macro', async () => {
  const keys = inline('export default { async run(ctx) { ctx.input.press("e"); await ctx.wait(100); } };');
  const r = await engine.call('sim.run', { macro: keys, seconds: 2 });
  assert.equal(r.end.reason, 'error');
  assert.match(r.end.error, /"keyboard" without declaring it/);
  assert.equal(r.inputs, 0);
});

test('a live session streams previews and stats, and the kill switch stops a run', async () => {
  const spec = await loadMacro(example);
  await engine.call('session.start', { target: 'sim' });
  const preview = await nextEvent('preview', (p) => p.target === 'sim');
  assert.ok(preview.width > 0 && preview.height > 0);
  assert.equal(Buffer.from(preview.rgba, 'base64').length, preview.width * preview.height * 4);
  const stats = await nextEvent('session.stats', (s) => s.target === 'sim');
  assert.equal(stats.found, true);

  await engine.call('macro.run', { macro: spec });
  const overlay = await nextEvent('preview', (p) => p.overlay?.trackers?.some((t) => t.seen));
  assert.equal(overlay.overlay.regions[0].name, 'bar');

  const ended = nextEvent('macro.end');
  await engine.call('killswitch');
  const end = await ended;
  assert.equal(end.end.reason, 'stopped');
  assert.equal(end.end.detail, 'kill switch');
  await engine.call('session.stop');
});

test('macro.stop ends a run and reports its stats', async () => {
  const spec = await loadMacro(example);
  await engine.call('session.start', { target: 'sim' });
  await engine.call('macro.run', { macro: spec });
  await nextEvent('macro.stats');
  const ended = nextEvent('macro.end');
  await engine.call('macro.stop');
  const end = await ended;
  assert.equal(end.end.detail, 'stopped');
  assert.ok(end.elapsed > 0);
  await engine.call('session.stop');
});

test('bad macros fail to start with a clear message', async () => {
  await engine.call('session.start', { target: 'sim' });
  await assert.rejects(engine.call('macro.run', { macro: inline('', { entry: 'missing.ts' }) }), /entry file "missing.ts" is missing/);
  await assert.rejects(
    engine.call('macro.run', { macro: inline('', { permissions: ['everything'] }) }),
    /Unknown permission "everything"/,
  );
  await assert.rejects(
    engine.call('macro.run', { macro: inline('', { regions: { r: { anchor: 'middle', w: 1, h: 1 } } }) }),
    /unknown anchor "middle"/,
  );
  await engine.call('session.stop');
  await assert.rejects(engine.call('macro.stop'), /No session is running/);
});
