// Starts wick-engine and talks to it with newline-delimited JSON-RPC.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.platform === 'win32' ? 'wick-engine.exe' : 'wick-engine';

/** The engine binary: bundled with a packaged app, or from a local build. */
export function enginePath({ resourcesPath = process.resourcesPath } = {}) {
  const candidates = [
    process.env.WICK_ENGINE,
    resourcesPath && join(resourcesPath, exe),
    join(root, 'engine', 'target', 'release', exe),
    join(root, 'engine', 'target', 'debug', exe),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

export class EngineClient extends EventEmitter {
  #child = null;
  #buffer = '';
  #nextId = 1;
  #pending = new Map();
  #restarts = 0;
  #stopping = false;

  constructor({ path, restart = true } = {}) {
    super();
    this.path = path ?? enginePath();
    this.restart = restart;
  }

  get running() {
    return this.#child !== null;
  }

  start() {
    if (this.#child) return;
    if (!this.path) throw new Error('wick-engine is missing. Build it with "npm run build:engine".');
    this.#stopping = false;
    const child = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => this.emit('stderr', text));
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => this.#exited(child, code, signal));
  }

  #read(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('stderr', `Unreadable engine output: ${line.slice(0, 200)}\n`);
        continue;
      }
      if ('id' in message && this.#pending.has(message.id)) {
        const { resolve, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        if (message.method === 'ready') this.#restarts = 0;
        this.emit('event', message.method, message.params);
        this.emit(message.method, message.params);
      }
    }
  }

  #exited(child, code, signal) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#buffer = '';
    for (const { reject } of this.#pending.values()) reject(new Error('The engine stopped'));
    this.#pending.clear();
    this.emit('exit', { code, signal });
    if (this.#stopping || !this.restart) return;
    // Back off if it keeps crashing: 0.5s, 1s, 2s ... up to 10s.
    const delay = Math.min(10_000, 500 * 2 ** this.#restarts++);
    setTimeout(() => {
      if (!this.#stopping && !this.#child) this.start();
    }, delay).unref?.();
  }

  call(method, params = {}) {
    if (!this.#child) return Promise.reject(new Error('The engine isn\'t running'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async stop() {
    if (!this.#child) return;
    this.#stopping = true;
    const child = this.#child;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    this.call('shutdown').catch(() => {});
    const timer = setTimeout(() => child.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }
}
