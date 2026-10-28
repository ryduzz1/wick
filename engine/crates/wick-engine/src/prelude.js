// The macro API, evaluated once in each macro's QuickJS context before the
// macro loads. The engine talks to it through three globals:
//   __wick_init(json)  start the macro
//   __wick_step(json)  new frame: time, tracker states, focus; runs due timers
//   __wick_drain()     returns {status, error, cmds} and clears the queue
(() => {
  "use strict";

  const queue = [];
  const trackers = new Map();
  const timers = [];
  const lastClick = new Map();
  const settings = {};
  let nextId = 1;
  let now = 0;
  let latency = 0.04;
  let focused = true;
  let viewport = { width: 0, height: 0 };
  let status = "starting";
  let error = null;

  const fail = (message) => {
    throw new TypeError(message);
  };

  const describe = (e) => {
    if (e && typeof e === "object" && "message" in e) {
      const stack = typeof e.stack === "string" ? e.stack.trim() : "";
      return stack ? `${e.name || "Error"}: ${e.message}\n${stack}` : `${e.name || "Error"}: ${e.message}`;
    }
    return String(e);
  };

  const format = (v) => {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  const point = (at, name) => {
    if (at == null) return null;
    if (typeof at === "string") at = { region: at };
    if (typeof at !== "object") fail(`${name}: "at" must be a region name or { region, x, y }`);
    return { region: at.region ?? null, x: at.x ?? 0.5, y: at.y ?? 0.5 };
  };

  class Tracker {
    #state = { seen: false, missingFor: 0 };
    constructor(id, region) {
      this.id = id;
      this.region = region;
    }
    _set(state) {
      this.#state = state;
    }
    get seen() { return this.#state.seen; }
    get x() { return this.#state.x ?? NaN; }
    get y() { return this.#state.y ?? NaN; }
    get left() { return this.#state.left ?? NaN; }
    get right() { return this.#state.right ?? NaN; }
    get top() { return this.#state.top ?? NaN; }
    get bottom() { return this.#state.bottom ?? NaN; }
    get center() { return this.#state.center ?? NaN; }
    get middle() { return this.#state.middle ?? NaN; }
    get width() { return this.#state.width ?? 0; }
    get height() { return this.#state.height ?? 0; }
    get velocity() { return this.#state.vx ?? 0; }
    get vx() { return this.#state.vx ?? 0; }
    get vy() { return this.#state.vy ?? 0; }
    get pixels() { return this.#state.pixels ?? 0; }
    get coverage() { return this.#state.coverage ?? 0; }
    get missingFor() { return this.#state.missingFor ?? 0; }
  }

  const screen = {
    track(region, options = {}) {
      if (typeof region !== "string") fail("screen.track(region, options) needs a region name");
      if (typeof options.color !== "string") fail(`screen.track("${region}") needs a color, like { color: "#3ccf5a" }`);
      const id = nextId++;
      const tracker = new Tracker(id, region);
      trackers.set(id, tracker);
      queue.push({
        t: "track",
        id,
        region,
        color: options.color,
        tolerance: options.tolerance ?? 30,
        minPixels: options.minPixels ?? 3,
      });
      return tracker;
    },
    get width() { return viewport.width; },
    get height() { return viewport.height; },
  };

  const input = {
    get latency() { return latency; },
    get focused() { return focused; },
    click(options = {}) {
      const button = options.button ?? "left";
      const gap = options.minGap ?? 0;
      const last = lastClick.get(button);
      if (last !== undefined && now - last < gap) return false;
      lastClick.set(button, now);
      queue.push({ t: "click", button, at: point(options.at, "input.click"), hold: options.hold ?? 30 });
      return true;
    },
    mouseDown(button = "left") { queue.push({ t: "mouseDown", button }); },
    mouseUp(button = "left") { queue.push({ t: "mouseUp", button }); },
    move(at) { queue.push({ t: "move", at: point(at, "input.move") ?? fail("input.move needs a point") }); },
    turn(dx, dy = 0) { queue.push({ t: "turn", dx: Number(dx), dy: Number(dy) }); },
    press(key, options = {}) { queue.push({ t: "press", key: String(key), hold: options.hold ?? 40 }); },
    keyDown(key) { queue.push({ t: "keyDown", key: String(key) }); },
    keyUp(key) { queue.push({ t: "keyUp", key: String(key) }); },
  };

  const wait = (ms) => new Promise((resolve) => timers.push({ kind: "wait", at: now + Number(ms), resolve }));

  const waitUntil = (check, options = {}) =>
    new Promise((resolve, reject) =>
      timers.push({
        kind: "until",
        check,
        deadline: options.timeout != null ? now + options.timeout : Infinity,
        resolve,
        reject,
      }),
    );

  const loop = {
    hz(rate, body, options = {}) {
      if (!(rate > 0)) fail("loop.hz(rate, fn) needs a rate above 0");
      if (typeof body !== "function") fail("loop.hz(rate, fn) needs a function");
      return new Promise((resolve, reject) =>
        timers.push({
          kind: "loop",
          interval: 1000 / rate,
          last: -Infinity,
          body,
          until: options.until,
          end: options.for != null ? now + options.for : Infinity,
          resolve,
          reject,
        }),
      );
    },
    async repeat(times, body) {
      const count = times > 0 ? times : Infinity;
      for (let i = 0; i < count; i++) {
        queue.push({ t: "loop", index: i });
        await body(i);
      }
    },
  };

  const log = (...args) => queue.push({ t: "log", text: args.map(format).join(" ") });

  const ctx = Object.freeze({ screen, input, loop, wait, waitUntil, log, settings, now: () => now });

  // Returns true when the timer is finished and should be removed.
  const runTimer = (tm) => {
    switch (tm.kind) {
      case "wait":
        if (now >= tm.at) {
          tm.resolve();
          return true;
        }
        return false;
      case "until":
        if (tm.check()) {
          tm.resolve(true);
          return true;
        }
        if (now >= tm.deadline) {
          tm.resolve(false);
          return true;
        }
        return false;
      case "loop":
        if ((tm.until && tm.until()) || now >= tm.end) {
          tm.resolve();
          return true;
        }
        if (now - tm.last >= tm.interval - 0.5) {
          tm.last = now;
          tm.body();
        }
        return false;
    }
    return true;
  };

  globalThis.__wick_init = (json) => {
    const init = JSON.parse(json);
    Object.assign(settings, init.settings ?? {});
    Object.freeze(settings);
    latency = init.latency ?? latency;
    status = "running";
    (async () => {
      const mod = await import(init.entry);
      const def = mod.default;
      if (!def || typeof def.run !== "function") {
        throw new TypeError(`${init.entry} must "export default macro({ async run(ctx) { ... } })"`);
      }
      await def.run(ctx);
    })().then(
      () => {
        status = "done";
      },
      (e) => {
        status = "error";
        error = describe(e);
      },
    );
  };

  globalThis.__wick_step = (json) => {
    const s = JSON.parse(json);
    now = s.now;
    latency = s.latency;
    focused = s.focused;
    viewport = s.viewport;
    for (const id in s.trackers) trackers.get(Number(id))?._set(s.trackers[id]);
    for (let i = 0; i < timers.length; i++) {
      const tm = timers[i];
      let finished;
      try {
        finished = runTimer(tm);
      } catch (e) {
        tm.reject ? tm.reject(e) : null;
        finished = true;
      }
      if (finished) timers.splice(i--, 1);
    }
  };

  globalThis.__wick_drain = () => {
    const out = JSON.stringify({ status, error, cmds: queue });
    queue.length = 0;
    return out;
  };
})();
