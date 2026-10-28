// Builds the engine, then packages the app with electron-builder.
//   npm run dist:dir   an unpacked app in dist/ to try locally
//   npm run dist       installers (dmg and zip, or nsis and zip)
// Signing happens only when credentials are set (see docs/RELEASING.md);
// otherwise the build is unsigned, which is fine for trying it locally.
// Extra arguments go to electron-builder, e.g. `npm run dist -- --publish always`.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const run = (cmd, args, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, [join(root, 'scripts', 'build-engine.mjs')]);

const args = process.argv.slice(2);
const env = { ...process.env };
const signing = process.platform === 'darwin' ? env.CSC_LINK || env.CSC_NAME : env.WIN_CSC_LINK || env.CSC_LINK;
if (!signing) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  if (process.platform === 'darwin') args.push('-c.mac.identity=null');
}
if (!args.some((a) => a.startsWith('--publish'))) args.push('--publish', 'never');
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', ...args], env);
