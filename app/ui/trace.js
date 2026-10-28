// The trace graph: tracker positions over the last few seconds of a run,
// with the macro's inputs as ticks along the bottom. Wide trackers (like a
// zone) draw as a band between their edges; narrow ones (like a tick) as a
// line. Grays plus ember for inputs, per docs/DESIGN.md.

const WINDOW_MS = 10_000;
const KEEP_MS = 60_000;
const WIDE = 0.05;

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class TraceGraph {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onHover?: (text: string) => void, onLegend?: (items: object[]) => void }} [hooks]
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.clear();
    canvas.addEventListener('pointermove', (e) => this.hover(e));
    canvas.addEventListener('pointerleave', () => {
      this.hoverAt = null;
      this.hooks.onHover?.('');
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  clear() {
    this.samples = [];
    this.inputs = [];
    this.trackers = [];
    this.hoverAt = null;
    this.draw();
  }

  get empty() {
    return this.samples.length === 0;
  }

  /** Adds one `macro.trace` batch. */
  push({ samples = [], inputs = [], trackers = [] }) {
    this.samples.push(...samples);
    this.inputs.push(...inputs);
    if (JSON.stringify(trackers) !== JSON.stringify(this.trackers)) {
      this.trackers = trackers;
      this.hooks.onLegend?.(this.legend());
    }
    const last = this.samples.at(-1)?.[0] ?? 0;
    const cut = (list) => {
      let i = 0;
      while (i < list.length && list[i][0] < last - KEEP_MS) i++;
      if (i) list.splice(0, i);
    };
    cut(this.samples);
    cut(this.inputs);
    this.draw();
  }

  /** Whether each tracker reads as a band (wide) or a line, from recent widths. */
  wide() {
    return this.trackers.map((_, i) => {
      const widths = this.samples.slice(-120).map((s) => s[1][i]).filter(Boolean).map((p) => p[2] - p[1]);
      return widths.length > 0 && widths.reduce((a, b) => a + b, 0) / widths.length > WIDE;
    });
  }

  legend() {
    const wide = this.wide();
    let lines = 0;
    return this.trackers.map((t, i) => ({ ...t, style: wide[i] ? 'band' : lines++ === 0 ? 'line' : 'dashed' }));
  }

  hover(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.hoverAt = (e.clientX - rect.left) / rect.width;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const pad = { top: 8 * dpr, bottom: 16 * dpr };
    const plotH = h - pad.top - pad.bottom;
    const end = this.samples.at(-1)?.[0] ?? 0;
    const start = end - WINDOW_MS;
    const X = (t) => ((t - start) / WINDOW_MS) * w;
    // 0 (the region's left edge) at the bottom, 1 at the top.
    const Y = (v) => pad.top + (1 - v) * plotH;
    const text = css('--text');
    const muted = css('--muted');

    // Guides at 0, ½ and 1 of the region.
    g.strokeStyle = css('--border');
    g.lineWidth = 1;
    for (const v of [0, 0.5, 1]) {
      g.beginPath();
      g.moveTo(0, Math.round(Y(v)) + 0.5);
      g.lineTo(w, Math.round(Y(v)) + 0.5);
      g.stroke();
    }
    if (this.empty) return;

    const visible = this.samples.filter((s) => s[0] >= start - 100);
    const legend = this.legend();
    legend.forEach((item, i) => {
      if (item.style === 'band') {
        g.fillStyle = muted;
        g.globalAlpha = 0.16;
        for (let k = 1; k < visible.length; k++) {
          const p = visible[k][1][i];
          if (!p) continue;
          const x0 = X(visible[k - 1][0]);
          g.fillRect(x0, Y(p[1]), X(visible[k][0]) - x0 + 0.5, Y(p[2]) - Y(p[1]));
        }
        g.globalAlpha = 1;
        g.strokeStyle = muted;
        g.lineWidth = dpr;
        for (const edge of [1, 2]) this.line(g, visible, i, edge, X, Y);
      } else {
        g.strokeStyle = item.style === 'line' ? text : muted;
        g.lineWidth = 1.5 * dpr;
        g.setLineDash(item.style === 'dashed' ? [4 * dpr, 3 * dpr] : []);
        this.line(g, visible, i, 0, X, Y);
        g.setLineDash([]);
      }
    });

    // The macro's inputs.
    g.strokeStyle = css('--ember');
    g.lineWidth = 1.5 * dpr;
    for (const [t] of this.inputs) {
      if (t < start) continue;
      const x = Math.round(X(t)) + 0.5;
      g.beginPath();
      g.moveTo(x, h - pad.bottom + 4 * dpr);
      g.lineTo(x, h - 2 * dpr);
      g.stroke();
    }

    if (this.hoverAt != null) {
      const t = start + this.hoverAt * WINDOW_MS;
      const near = visible.reduce((best, s) => (Math.abs(s[0] - t) < Math.abs(best[0] - t) ? s : best), visible[0]);
      if (near) {
        const x = Math.round(X(near[0])) + 0.5;
        g.strokeStyle = muted;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, pad.top);
        g.lineTo(x, h - pad.bottom);
        g.stroke();
        const parts = legend.map((item, i) => {
          const p = near[1][i];
          if (!p) return `${item.region}: not seen`;
          return item.style === 'band' ? `${item.region} ${p[1].toFixed(3)}–${p[2].toFixed(3)}` : `${item.region} x ${p[0].toFixed(3)}`;
        });
        this.hooks.onHover?.(`${(near[0] / 1000).toFixed(2)} s · ${parts.join(' · ')}`);
      }
    }
  }

  /** One polyline through field `f` of tracker `i`, broken where it wasn't seen. */
  line(g, samples, i, f, X, Y) {
    g.beginPath();
    let open = false;
    for (const [t, points] of samples) {
      const p = points[i];
      if (!p) {
        open = false;
        continue;
      }
      if (open) g.lineTo(X(t), Y(p[f]));
      else g.moveTo(X(t), Y(p[f]));
      open = true;
    }
    g.stroke();
  }
}
