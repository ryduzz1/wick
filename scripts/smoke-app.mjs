// Launches the app with a hidden window, waits for it to load and reach the
// engine, and fails on renderer errors. Prints what the window showed.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const userData = mkdtempSync(join(tmpdir(), 'wick-smoke-'));

// WICK_SMOKE_APP runs a packaged build instead (the app's executable), to
// check the bundled engine, examples and CLI: npm run smoke:dist.
const packaged = process.env.WICK_SMOKE_APP;
const child = spawn(packaged || electron, packaged ? [] : [root], {
  cwd: root,
  env: { ...process.env, WICK_SMOKE: '1', WICK_USER_DATA: userData, WICK_LIBRARY: join(userData, 'library') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
const timer = setTimeout(() => child.kill(), 45_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  rmSync(userData, { recursive: true, force: true });
  const line = output.split('\n').find((l) => l.startsWith('WICK_SMOKE '));
  if (!line) {
    console.error('The app exited without a smoke report.\n', output);
    process.exit(1);
  }
  const report = JSON.parse(line.slice('WICK_SMOKE '.length));
  console.log(JSON.stringify(report, null, 2));
  process.exit(code === 0 && report.ok ? 0 : 1);
});
