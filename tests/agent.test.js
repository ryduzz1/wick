// The agent tools: command layer, CLI parsing, control socket and MCP server,
// against a real engine on the simulator.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs, parseAt, parseTrack, toRequest } from '../app/cli.js';
import { createCommands, normalizeCommand } from '../app/commands.js';
import { connect, serve } from '../app/control.js';
import { EngineClient } from '../app/engine-client.js';
import { copyMacro } from '../app/library.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const example = join(root, 'examples', 'bar-minigame');
let engine;
let commands;
let dir;
let folder;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wick-agent-'));
  folder = copyMacro(example, dir, { author: 'tester' });
  engine = new EngineClient({ restart: false });
  const ready = new Promise((resolve) => engine.once('ready', resolve));
  engine.start();
  await ready;
  let current = null;
  commands = createCommands({
    engine,
    async ensureSession(target) {
      if (current === target) return;
      await engine.call('session.start', { target });
      current = target;
    },
  });
});

after(async () => {
  await engine.stop();
  await rm(dir, { recursive: true, force: true });
});

test('normalizes the short input forms', () => {
  assert.deepEqual(normalizeCommand({ t: 'click' }), { t: 'click', button: 'left', at: null, hold: 30 });
  assert.deepEqual(normalizeCommand({ t: 'click', at: 'bar' }).at, { region: 'bar', x: 0.5, y: 0.5 });
  assert.deepEqual(normalizeCommand({ t: 'press', key: 'E' }), { t: 'press', key: 'e', hold: 40 });
  assert.throws(() => normalizeCommand({ t: 'jump' }), /Unknown input "jump"/);
  assert.throws(() => normalizeCommand({ t: 'move' }), /needs "at"/);
});

test('parses command lines', () => {
  assert.deepEqual(parseArgs(['probe', '--track', 'a:b:#fff', '--track', 'c:d:#000:9', '--seconds=2', '--local']), {
    positional: ['probe'],
    flags: { track: ['a:b:#fff', 'c:d:#000:9'], seconds: '2', local: true },
  });
  assert.deepEqual(parseAt('bar:0.2,0.8'), { region: 'bar', x: 0.2, y: 0.8 });
  assert.deepEqual(parseAt('0.5,0.5'), { x: 0.5, y: 0.5 });
  assert.deepEqual(parseTrack('tick:bar:#ffffff:40'), { name: 'tick', region: 'bar', color: '#ffffff', tolerance: 40 });
  const [method, params] = toRequest(['region', 'set', 'zone'], { x: '0.1', anchor: 'center' }, folder);
  assert.equal(method, 'setRegion');
  assert.equal(params.folder, folder);
  assert.equal(params.x, 0.1);
  assert.throws(() => toRequest(['run'], {}, tmpdir()), /inside a macro folder/);
});

test('detect finds the zone and lists the main colors', async () => {
  const r = await commands.detect({ folder, target: 'sim', region: 'bar', color: '#3ccf5a', mask: true });
  assert.equal(r.match.found, true);
  assert.ok(r.palette.some((p) => p.color === '#3ccf5a'));
  assert.ok(fs.existsSync(r.mask), 'mask image saved');
  assert.ok(r.mask.startsWith(join(folder, '.wick')), 'saved in the macro\'s .wick folder');
});

test('observe saves the window and a region', async () => {
  const whole = await commands.observe({ folder, target: 'sim' });
  assert.equal(whole.width, 960);
  const part = await commands.observe({ folder, target: 'sim', region: 'bar' });
  assert.ok(part.width < 300 && part.height < 50, `${part.width}×${part.height}`);
  assert.ok(fs.readFileSync(part.path).subarray(1, 4).toString() === 'PNG');
});

test('probe measures the simulator\'s drift', async () => {
  const r = await commands.probe({ folder, target: 'sim', track: [{ name: 'tick', region: 'bar', color: '#ffffff', tolerance: 40 }], seconds: 1, sampleHz: 120 });
  const { t, x } = r.trackers.tick;
  const speed = ((x[10] - x.at(-1)) / ((t.at(-1) - t[10]) / 1000)) * (0.46 / 0.42);
  assert.ok(Math.abs(speed - 0.25) / 0.25 < 0.05, `drift ${speed}`);
});

test('act sends input to the simulator', async () => {
  const r = await commands.act({ folder, target: 'sim', command: { t: 'click', at: 'bar' } });
  assert.equal(r.sent, 2, 'move and press now; the release comes later');
});

test('record saves keyframes, a log and a contact sheet', async () => {
  const r = await commands.record({ folder, target: 'sim', region: 'bar', seconds: 2, fps: 10, run: true });
  assert.ok(r.dir.startsWith(join(folder, '.wick', 'recordings')));
  assert.ok(r.samples >= 19, `${r.samples} samples`);
  assert.ok(r.inputs.wick > 0, 'the macro clicked');
  assert.ok(fs.existsSync(r.path), 'contact sheet');
  const lines = fs.readFileSync(r.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.by === 'wick' && l.input === 'mouseDown'));
  assert.ok(lines.filter((l) => l.frame).every((l) => fs.existsSync(join(r.dir, l.frame))));
  assert.ok(r.run.score.inZone > 0.5, 'the macro played while recording');
});

test('regions can be set and removed', () => {
  commands.setRegion({ folder, name: 'prompt', anchor: 'center', x: 0.1, w: 0.2, h: 0.05 });
  assert.deepEqual(commands.regions({ folder }).prompt, { anchor: 'center', x: 0.1, y: 0, w: 0.2, h: 0.05 });
  commands.removeRegion({ folder, name: 'prompt' });
  assert.equal(commands.regions({ folder }).prompt, undefined);
});

test('run and simulate on the simulator, then telemetry', async () => {
  const run = await commands.run({ folder, target: 'sim', seconds: 5 });
  assert.equal(run.end.reason, 'stopped');
  assert.ok(run.score.inZone > 0.8, `in zone ${run.score.inZone}`);
  assert.deepEqual(commands.telemetry().end, run.end);
  const sim = await commands.simulate({ folder, seeds: 3, seconds: 10 });
  assert.equal(sim.scores.length, 3);
  assert.ok(sim.average > 0.8);
});

test('the control socket serves commands', async () => {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\wick-test-${process.pid}` : join(dir, 'test.sock');
  const server = await serve(commands, socket);
  try {
    const client = await connect(socket);
    assert.ok(client);
    const status = await client.call('status');
    assert.equal(status.engine.protocol, 1);
    await assert.rejects(client.call('nope'), /Unknown command "nope"/);
    client.close();
  } finally {
    server.close();
  }
  assert.equal(await connect(join(dir, 'missing.sock')), null);
});

test('the MCP server lists tools and answers calls with images', async () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wick_observe', arguments: { target: 'sim', region: 'bar' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wick_regions', arguments: {} } },
  ].map((m) => JSON.stringify(m)).join('\n');
  const child = execFile(process.execPath, [join(root, 'bin', 'wick.js'), 'mcp', '--local'], { cwd: folder });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stdin.end(`${input}\n`);
  await new Promise((resolve) => child.on('exit', resolve));
  const replies = Object.fromEntries(Buffer.concat(out.map((d) => Buffer.from(d))).toString().trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(replies[1].result.serverInfo.name, 'wick');
  assert.ok(replies[2].result.tools.some((t) => t.name === 'wick_probe'));
  assert.deepEqual(replies[3].result.content.map((c) => c.type), ['text', 'image']);
  assert.ok(JSON.parse(replies[4].result.content[0].text).bar, 'defaults to the folder it started in');
});

test('the CLI prints JSON and fails clearly', async () => {
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [join(root, 'bin', 'wick.js'), 'regions'], { cwd: folder });
  assert.ok(JSON.parse(stdout).bar);
  await assert.rejects(run(process.execPath, [join(root, 'bin', 'wick.js'), 'region', 'set'], { cwd: folder }), /Name the region/);
});

test('run history keeps each run with its log and trace', async () => {
  const { RunHistory } = await import('../app/runs.js');
  const history = new RunHistory(join(dir, 'runs'));
  history.onEvent('macro.state', { state: 'running', id: 'me/bar' }, 'sim');
  history.onEvent('macro.log', { text: 'hello', at: 5 });
  history.onEvent('macro.trace', { trackers: [{ id: 1, region: 'bar', color: '#ffffff' }], samples: [[0, [[0.5, 0.4, 0.6]]], [20_000, [null]]], inputs: [[10, 'left']] });
  const file = history.onEvent('macro.end', { end: { reason: 'error', error: 'boom' }, elapsed: 20_000, inputs: 1, dropped: 0 });
  assert.ok(fs.existsSync(file));
  const [summary] = history.list('me/bar');
  assert.equal(summary.end.error, 'boom');
  assert.equal(summary.trace, undefined, 'lists leave out the trace');
  const full = history.read('me/bar', summary.file);
  assert.deepEqual(full.trace.samples, [[20_000, [null]]], 'keeps only the last 15 seconds');
  assert.equal(full.logs[0].text, 'hello');
  assert.throws(() => history.read('me/bar', '../x.json'), /Not a run file/);
});
