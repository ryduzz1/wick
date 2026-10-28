// The mini window: a small always-on-top panel shown over the game while a
// macro runs, so the main window can stay out of the way. It never takes
// focus (input keeps going to the game) and is left out of screen capture,
// so macros never see it. See docs/DESIGN.md#mini-window.

import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';

const WIDTH = 280;
const HEIGHT = 72;

export class MiniWindow {
  /**
   * @param {object} options
   * @param {string} options.directory  the app folder (for the page and preload)
   * @param {() => {x: number, y: number} | null} options.position  the saved position
   * @param {(at: {x: number, y: number}) => void} options.savePosition
   * @param {() => void} options.stop  stops the running macro
   * @param {() => void} options.showMain  brings the main window forward
   */
  constructor(options) {
    this.options = options;
    this.window = null;
    this.ready = null;
    this.hideTimer = null;
    this.state = null;
    ipcMain.on('wick:mini', (event, action) => {
      if (!this.window || event.sender !== this.window.webContents) return;
      if (action === 'stop') options.stop();
      if (action === 'main') options.showMain();
    });
  }

  #create() {
    const at = this.#position();
    const win = new BrowserWindow({
      ...at,
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: true,
      title: 'Wick',
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: { preload: path.join(this.options.directory, 'mini-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Keeps it out of every capture, Wick's own included.
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('moved', () => {
      const [x, y] = win.getPosition();
      this.options.savePosition({ x, y });
    });
    win.on('closed', () => {
      this.window = null;
      this.ready = null;
    });
    this.ready = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.loadFile(path.join(this.options.directory, 'ui', 'mini.html'));
    this.window = win;
  }

  /** The saved position if it's still on a screen, otherwise the top right. */
  #position() {
    const saved = this.options.position();
    const fits = saved && screen.getAllDisplays().some(({ workArea: a }) => saved.x >= a.x && saved.y >= a.y && saved.x + WIDTH <= a.x + a.width && saved.y + HEIGHT <= a.y + a.height);
    if (fits) return { x: saved.x, y: saved.y };
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - WIDTH - 16, y: a.y + 16 };
  }

  async #send(update) {
    this.state = { ...this.state, ...update };
    if (!this.window) return;
    await this.ready;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('wick:mini', this.state);
  }

  /** A macro started: show the panel. */
  async start({ name, target, hotkey = 'F8' }) {
    clearTimeout(this.hideTimer);
    this.state = { name, target, hotkey, phase: 'running', elapsed: 0, loops: null, step: null, found: true, focused: true, end: null };
    if (!this.window) this.#create();
    await this.#send({});
    this.window?.showInactive();
  }

  update(update) {
    if (this.state?.phase === 'running') this.#send(update);
  }

  /** The macro ended: show how, then hide after a moment. */
  end(end, elapsed) {
    if (!this.state || !this.window) return;
    this.#send({ phase: 'ended', end, elapsed: elapsed ?? this.state.elapsed });
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), 4000);
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.state = null;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  /** What the panel shows, for the smoke test. */
  async text() {
    if (!this.window?.isVisible()) return null;
    await this.ready;
    return this.window.webContents.executeJavaScript(`document.body.innerText`);
  }

  destroy() {
    clearTimeout(this.hideTimer);
    this.window?.destroy();
  }
}
