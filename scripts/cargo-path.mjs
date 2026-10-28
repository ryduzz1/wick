// rustup installs to ~/.cargo/bin, which shells started outside a login
// session (editors, npm from some apps) may not have on PATH.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const cargoBin = join(homedir(), '.cargo', 'bin');
if (existsSync(cargoBin) && !process.env.PATH?.split(delimiter).includes(cargoBin)) {
  process.env.PATH = `${cargoBin}${delimiter}${process.env.PATH ?? ''}`;
}
