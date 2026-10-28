// Static checks: Rust formatting and lints, and JavaScript syntax.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './cargo-path.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const shell = process.platform === 'win32';
let failed = false;

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell });
  if (result.status !== 0) {
    console.error(`✗ ${label}`);
    failed = true;
  } else {
    console.log(`✓ ${label}`);
  }
}

const manifest = join(root, 'engine', 'Cargo.toml');
run('cargo fmt', 'cargo', ['fmt', '--manifest-path', manifest, '--all', '--check']);
run('cargo clippy', 'cargo', ['clippy', '--manifest-path', manifest, '--all-targets', '--', '-D', 'warnings']);

const scripts = ['app', 'app/ui', 'bin', 'scripts', 'tests'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => /\.(m?js|cjs)$/.test(f))
    .map((f) => join(root, dir, f)),
);
for (const file of scripts) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr);
    failed = true;
  }
}
console.log(failed ? '' : `✓ node --check (${scripts.length} files)`);
process.exit(failed ? 1 : 0);
