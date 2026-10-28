// Builds wick-engine in release mode. The app and tests use the release
// build because the simulator runs far slower in debug.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './cargo-path.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const exe = process.platform === 'win32' ? 'wick-engine.exe' : 'wick-engine';
const built = join(root, 'engine', 'target', 'release', exe);

const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
if (cargo.status !== 0) {
  if (existsSync(built)) {
    console.warn('cargo not found; using the existing engine build.');
    process.exit(0);
  }
  console.error('wick-engine needs Rust to build. Install it from https://rustup.rs, then run this again.');
  process.exit(1);
}

const result = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', join(root, 'engine', 'Cargo.toml'), '-p', 'wick-engine'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);
