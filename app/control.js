// The app's control socket: the `wick` CLI and MCP server send agent
// commands here, so they run in the app's engine and show up in its window.
// A Unix socket (mode 0600) on macOS and Linux, a named pipe on Windows;
// either way only the current user can connect.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Wick's app data folder, the same one Electron uses for the app. */
export function userDataDir() {
  if (process.env.WICK_USER_DATA) return process.env.WICK_USER_DATA;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'wick');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'wick');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'wick');
}

export function socketPath() {
  if (process.env.WICK_SOCKET) return process.env.WICK_SOCKET;
  if (process.platform === 'win32') {
    let user = 'user';
    try {
      user = os.userInfo().username.replace(/[^\w.-]/g, '_');
    } catch {}
    return `\\\\.\\pipe\\wick-${user}`;
  }
  return path.join(userDataDir(), 'wick.sock');
}

function lines(socket, onMessage) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // A garbled line from a client; ignore it.
      }
    }
  });
}

/** Serves `commands` on the control socket. Returns the server. */
export async function serve(commands, file = socketPath()) {
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A socket left behind by a crashed app blocks listening; remove it if nobody answers.
    if (fs.existsSync(file) && !(await reachable(file))) fs.rmSync(file, { force: true });
  }
  const server = net.createServer((socket) => {
    lines(socket, async (msg) => {
      const handler = Object.hasOwn(commands, msg.method) ? commands[msg.method] : null;
      let reply;
      try {
        if (!handler) throw new Error(`Unknown command "${msg.method}"`);
        reply = { id: msg.id, result: (await handler(msg.params ?? {})) ?? null };
      } catch (e) {
        reply = { id: msg.id, error: { message: e.message } };
      }
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, resolve);
  });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return server;
}

function reachable(file) {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Connects to a running app. Resolves to null when none is listening. */
export function connect(file = socketPath()) {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    const pending = new Map();
    let nextId = 1;
    socket.once('error', () => resolve(null));
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      socket.on('error', (e) => {
        for (const { reject } of pending.values()) reject(e);
        pending.clear();
      });
      socket.on('close', () => {
        for (const { reject } of pending.values()) reject(new Error('Wick closed the connection'));
        pending.clear();
      });
      lines(socket, (msg) => {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      });
      resolve({
        call(method, params = {}) {
          const id = nextId++;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            socket.write(`${JSON.stringify({ id, method, params })}\n`);
          });
        },
        close: () => socket.end(),
      });
    });
  });
}
