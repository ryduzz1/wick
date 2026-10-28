// The live view: the captured frame with region, match and tracker layers.
// Regions can be moved, resized and drawn here; colors can be picked.
//
// Coordinates: "frame fractions" are 0–1 across the captured frame. Regions
// are stored as in regions.json (anchor, x, y, w, h in viewport heights), so
// they're converted with the viewport the engine reports in each preview.

const EMBER = [240, 138, 75];
const HANDLE = 5;

export const ANCHOR_POINTS = {
  'top-left': [0, 0], 'top-center': [0.5, 0], 'top-right': [1, 0],
  'center-left': [0, 0.5], center: [0.5, 0.5], 'center-right': [1, 0.5],
  'bottom-left': [0, 1], 'bottom-center': [0.5, 1], 'bottom-right': [1, 1],
};

const round = (v) => Math.round(v * 10000) / 10000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** A region spec as a rectangle in frame fractions. */
export function regionRect(r, vp, aspect) {
  const [fx, fy] = ANCHOR_POINTS[r.anchor ?? 'center'] ?? [0.5, 0.5];
  // One viewport height, as a fraction of the frame's width and height.
  const ux = (vp.h / aspect);
  const uy = vp.h;
  const cx = vp.x + vp.w * fx + (r.x ?? 0) * ux;
  const cy = vp.y + vp.h * fy + (r.y ?? 0) * uy;
  const w = r.w * ux;
  const h = r.h * uy;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The inverse of regionRect, keeping the given anchor. */
export function rectRegion(rect, anchor, vp, aspect) {
  const [fx, fy] = ANCHOR_POINTS[anchor] ?? [0.5, 0.5];
  const ux = vp.h / aspect;
  const uy = vp.h;
  return {
    anchor,
    x: round((rect.x + rect.w / 2 - vp.x - vp.w * fx) / ux),
    y: round((rect.y + rect.h / 2 - vp.y - vp.h * fy) / uy),
    w: round(rect.w / ux),
    h: round(rect.h / uy),
  };
}

/** The anchor closest to a rectangle's center: the viewport split in thirds. */
export function nearestAnchor(rect, vp) {
  const cx = (rect.x + rect.w / 2 - vp.x) / vp.w;
  const cy = (rect.y + rect.h / 2 - vp.y) / vp.h;
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center';
  const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'center';
  return row === 'center' && col === 'center' ? 'center' : `${row}-${col}`;
}

export class LiveView {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.scratch = document.createElement('canvas');
    this.maskCanvas = document.createElement('canvas');
    this.cb = callbacks;
    this.preview = null;
    this.pixels = null;
    this.regions = {};
    this.editable = false;
    this.selected = null;
    this.mode = 'select';
    this.layers = { regions: true, trackers: true, matches: true };
    this.color = null;
    this.drag = null;
    this.draft = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => this.cb.onHover?.(null));
    new ResizeObserver(() => this.render()).observe(canvas);
  }

  setPreview(p, rgba) {
    this.preview = p;
    this.scratch.width = p.width;
    this.scratch.height = p.height;
    this.pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, p.width * p.height * 4);
    this.scratch.getContext('2d').putImageData(new ImageData(this.pixels, p.width, p.height), 0, 0);
    this.maskDirty = true;
    this.render();
  }

  clear() {
    this.preview = null;
    this.pixels = null;
    this.render();
  }

  setRegions(regions, editable) {
    if (this.drag) return;
    this.regions = structuredClone(regions ?? {});
    this.editable = editable;
    if (this.selected && !this.regions[this.selected]) this.selected = null;
    this.maskDirty = true;
    this.render();
  }

  select(name) {
    this.selected = name && this.regions[name] ? name : null;
    this.maskDirty = true;
    this.cb.onSelect?.(this.selected);
    this.render();
  }

  setMode(mode) {
    this.mode = mode;
    this.canvas.style.cursor = mode === 'select' ? '' : 'crosshair';
    this.cb.onMode?.(mode);
  }

  setColor(color) {
    this.color = color;
    this.maskDirty = true;
    this.render();
  }

  setLayer(name, on) {
    this.layers[name] = on;
    this.render();
  }

  // MARK: Geometry

  layout() {
    const p = this.preview;
    const { width: w, height: h } = this.canvas;
    const scale = Math.min(w / p.width, h / p.height);
    const fw = p.width * scale;
    const fh = p.height * scale;
    return { ox: (w - fw) / 2, oy: (h - fh) / 2, fw, fh };
  }

  get viewport() {
    return this.preview?.viewport ?? { x: 0, y: 0, w: 1, h: 1 };
  }

  get aspect() {
    return this.preview ? this.preview.width / this.preview.height : 16 / 9;
  }

  rectOf(name) {
    return regionRect(this.regions[name], this.viewport, this.aspect);
  }

  toCanvas(rect) {
    const L = this.layout();
    return { x: L.ox + rect.x * L.fw, y: L.oy + rect.y * L.fh, w: rect.w * L.fw, h: rect.h * L.fh };
  }

  /** Pointer position in frame fractions. */
  point(e) {
    const box = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, box.width);
    const L = this.layout();
    return { fx: ((e.clientX - box.left) * dpr - L.ox) / L.fw, fy: ((e.clientY - box.top) * dpr - L.oy) / L.fh, dpr };
  }

  /** What's under the pointer: a handle of the selected region, a region, or nothing. */
  hit(e) {
    const { fx, fy, dpr } = this.point(e);
    const L = this.layout();
    const px = L.ox + fx * L.fw;
    const py = L.oy + fy * L.fh;
    if (this.selected && this.editable) {
      const c = this.toCanvas(this.rectOf(this.selected));
      const corners = { nw: [c.x, c.y], ne: [c.x + c.w, c.y], sw: [c.x, c.y + c.h], se: [c.x + c.w, c.y + c.h] };
      for (const [corner, [hx, hy]] of Object.entries(corners)) {
        if (Math.abs(px - hx) <= (HANDLE + 3) * dpr && Math.abs(py - hy) <= (HANDLE + 3) * dpr) return { name: this.selected, corner };
      }
    }
    const under = Object.keys(this.regions)
      .map((name) => ({ name, r: this.rectOf(name) }))
      .filter(({ r }) => fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h)
      .sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h);
    return under[0] ? { name: under[0].name } : null;
  }

  sample(fx, fy) {
    const p = this.preview;
    if (!p || fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
    const i = (Math.floor(fy * p.height) * p.width + Math.floor(fx * p.width)) * 4;
    return toHex([this.pixels[i], this.pixels[i + 1], this.pixels[i + 2]]);
  }

  // MARK: Pointer

  capture(e) {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }
  }

  down(e) {
    if (!this.preview || e.button !== 0) return;
    const { fx, fy } = this.point(e);
    if (this.mode === 'pick') {
      const hex = this.sample(fx, fy);
      if (hex) this.cb.onPick?.(hex);
      return;
    }
    if (this.mode === 'add') {
      if (!this.editable) return;
      this.capture(e);
      this.drag = { kind: 'add', start: { fx, fy } };
      this.draft = { x: fx, y: fy, w: 0, h: 0 };
      return;
    }
    const target = this.hit(e);
    if (!target) {
      this.select(null);
      return;
    }
    if (target.name !== this.selected) this.select(target.name);
    if (!this.editable) return;
    this.capture(e);
    this.drag = { kind: target.corner ? 'resize' : 'move', corner: target.corner, name: target.name, start: { fx, fy }, rect: this.rectOf(target.name), moved: false };
  }

  move(e) {
    if (!this.preview) return;
    const { fx, fy } = this.point(e);
    if (this.mode === 'pick') this.cb.onHover?.(this.sample(fx, fy));
    const d = this.drag;
    if (!d) {
      if (this.mode === 'select') {
        const target = this.editable ? this.hit(e) : null;
        const corner = target?.corner;
        this.canvas.style.cursor = corner ? (corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize') : target ? 'move' : '';
      }
      return;
    }
    const minW = 6 / this.layout().fw;
    const minH = 6 / this.layout().fh;
    if (d.kind === 'add') {
      const x = clamp(Math.min(d.start.fx, fx), 0, 1);
      const y = clamp(Math.min(d.start.fy, fy), 0, 1);
      this.draft = { x, y, w: clamp(Math.abs(fx - d.start.fx), 0, 1 - x), h: clamp(Math.abs(fy - d.start.fy), 0, 1 - y) };
      this.render();
      return;
    }
    const dx = fx - d.start.fx;
    const dy = fy - d.start.fy;
    let r = { ...d.rect };
    if (d.kind === 'move') {
      r.x = clamp(r.x + dx, 0, 1 - r.w);
      r.y = clamp(r.y + dy, 0, 1 - r.h);
    } else {
      let [x0, y0, x1, y1] = [r.x, r.y, r.x + r.w, r.y + r.h];
      if (d.corner.includes('w')) x0 = clamp(x0 + dx, 0, x1 - minW);
      else x1 = clamp(x1 + dx, x0 + minW, 1);
      if (d.corner.includes('n')) y0 = clamp(y0 + dy, 0, y1 - minH);
      else y1 = clamp(y1 + dy, y0 + minH, 1);
      r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    d.moved = true;
    this.regions[d.name] = rectRegion(r, this.regions[d.name].anchor ?? 'center', this.viewport, this.aspect);
    this.maskDirty = true;
    this.render();
  }

  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {}
    if (d.kind === 'add') {
      const rect = this.draft;
      this.draft = null;
      const L = this.layout();
      if (rect.w * L.fw < 6 || rect.h * L.fh < 6) {
        this.render();
        return;
      }
      let n = 1;
      while (this.regions[`region${n}`]) n++;
      const name = `region${n}`;
      this.regions[name] = rectRegion(rect, nearestAnchor(rect, this.viewport), this.viewport, this.aspect);
      this.setMode('select');
      this.select(name);
      this.cb.onRegionsChange?.(this.regions, name);
      return;
    }
    if (d.moved) this.cb.onRegionsChange?.(this.regions);
    this.render();
  }

  // MARK: Drawing

  /** Tints the pixels that match the current color inside the selected region (or the viewport). */
  updateMask() {
    this.maskDirty = false;
    const p = this.preview;
    const rgb = this.color && parseHex(this.color.hex);
    this.maskReady = false;
    if (!p || !rgb) {
      this.cb.onMatches?.(null);
      return;
    }
    const area = this.selected ? this.rectOf(this.selected) : this.viewport;
    const x0 = clamp(Math.floor(area.x * p.width), 0, p.width);
    const y0 = clamp(Math.floor(area.y * p.height), 0, p.height);
    const x1 = clamp(Math.ceil((area.x + area.w) * p.width), 0, p.width);
    const y1 = clamp(Math.ceil((area.y + area.h) * p.height), 0, p.height);
    this.maskCanvas.width = p.width;
    this.maskCanvas.height = p.height;
    const mask = new ImageData(p.width, p.height);
    const tol = this.color.tolerance;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * p.width + x) * 4;
        const px = this.pixels;
        if (Math.abs(px[i] - rgb[0]) <= tol && Math.abs(px[i + 1] - rgb[1]) <= tol && Math.abs(px[i + 2] - rgb[2]) <= tol) {
          mask.data[i] = EMBER[0];
          mask.data[i + 1] = EMBER[1];
          mask.data[i + 2] = EMBER[2];
          mask.data[i + 3] = 150;
          count++;
        }
      }
    }
    this.maskCanvas.getContext('2d').putImageData(mask, 0, 0);
    this.maskReady = true;
    const total = Math.max(1, (x1 - x0) * (y1 - y0));
    this.cb.onMatches?.({ pixels: count, coverage: count / total, area: this.selected ?? 'the game area' });
  }

  render() {
    const c = this.canvas;
    const box = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = this.g;
    g.fillStyle = '#111';
    g.fillRect(0, 0, w, h);
    if (!this.preview) return;
    const L = this.layout();
    g.imageSmoothingEnabled = true;
    g.drawImage(this.scratch, L.ox, L.oy, L.fw, L.fh);

    if (this.layers.matches && this.color) {
      if (this.maskDirty) this.updateMask();
      if (this.maskReady) {
        g.imageSmoothingEnabled = false;
        g.drawImage(this.maskCanvas, L.ox, L.oy, L.fw, L.fh);
        g.imageSmoothingEnabled = true;
      }
    }

    g.font = `${11 * dpr}px ui-monospace, monospace`;
    if (this.layers.regions) {
      for (const name of Object.keys(this.regions)) {
        const r = this.toCanvas(this.rectOf(name));
        const selected = name === this.selected;
        g.save();
        g.lineWidth = (selected ? 2 : 1.5) * dpr;
        g.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,.75)';
        if (!selected) g.setLineDash([6 * dpr, 4 * dpr]);
        g.strokeRect(r.x, r.y, r.w, r.h);
        g.restore();
        const tw = g.measureText(name).width + 8 * dpr;
        g.fillStyle = selected ? '#ffffff' : 'rgba(0,0,0,.7)';
        g.fillRect(r.x, r.y - 16 * dpr, tw, 15 * dpr);
        g.fillStyle = selected ? '#111111' : '#ffffff';
        g.fillText(name, r.x + 4 * dpr, r.y - 5 * dpr);
        if (selected && this.editable) {
          g.fillStyle = '#ffffff';
          for (const [hx, hy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
            g.fillRect(hx - HANDLE * dpr, hy - HANDLE * dpr, HANDLE * 2 * dpr, HANDLE * 2 * dpr);
          }
        }
      }
    }

    if (this.draft) {
      const r = this.toCanvas(this.draft);
      g.save();
      g.setLineDash([6 * dpr, 4 * dpr]);
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = '#f08a4b';
      g.strokeRect(r.x, r.y, r.w, r.h);
      g.restore();
    }

    const trackers = this.preview.overlay?.trackers ?? [];
    if (this.layers.trackers && trackers.length) {
      g.save();
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = '#f08a4b';
      for (const t of trackers) {
        if (!t.seen) continue;
        g.strokeRect(L.ox + t.left * L.fw, L.oy + t.top * L.fh, (t.right - t.left) * L.fw, (t.bottom - t.top) * L.fh);
        const cx = L.ox + t.x * L.fw;
        const cy = L.oy + t.y * L.fh;
        g.beginPath();
        g.moveTo(cx - 6 * dpr, cy);
        g.lineTo(cx + 6 * dpr, cy);
        g.moveTo(cx, cy - 6 * dpr);
        g.lineTo(cx, cy + 6 * dpr);
        g.stroke();
      }
      g.restore();
    }
  }
}
