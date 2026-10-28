// Runs the app smoke test against the packaged build from `npm run dist:dir`,
// then checks the bundled `wick` command answers from the packaged app.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');
const unpacked = existsSync(dist) ? readdirSync(dist).find((d) => /^(mac|win)(-\w+)?-unpacked$|^mac(-\w+)?$/.test(d)) : null;
if (!unpacked) {
  console.error('No packaged build in dist/. Run "npm run dist:dir" first.');
  process.exit(1);
}
const mac = process.platform === 'darwin';
const app = mac ? join(dist, unpacked, 'Wick.app', 'Contents', 'MacOS', 'Wick') : join(dist, unpacked, 'Wick.exe');
const cli = mac ? join(dist, unpacked, 'Wick.app', 'Contents', 'Resources', 'bin', 'wick') : join(dist, unpacked, 'resources', 'bin', 'wick.cmd');

const version = spawnSync(cli, ['help'], { encoding: 'utf8', shell: !mac, env: { ...process.env, WICK_ENGINE: '' } });
if (version.status !== 0 || !/wick/i.test(version.stdout)) {
  console.error('The bundled wick command failed.\n', version.stdout, version.stderr);
  process.exit(1);
}
console.log(`bundled wick command: ok (${cli})`);

const smoke = spawnSync(process.execPath, [join(root, 'scripts', 'smoke-app.mjs')], { stdio: 'inherit', env: { ...process.env, WICK_SMOKE_APP: app } });
process.exit(smoke.status ?? 1);
