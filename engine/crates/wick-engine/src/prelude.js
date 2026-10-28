// The macro API, evaluated once in each macro's QuickJS context before the
// macro loads. The engine talks to it through three globals:
//   __wick_init(json)  start the macro
//   __wick_step(json)  new frame: time, tracker states, focus; runs due timers
//   __wick_drain()     returns {status, error, cmds} and clears the queue
(() => {
  "use strict";

  const queue = [];
  const trackers = new Map();
  const similars = new Map();
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

  class Similar {
    #score = null;
    constructor(id, region, threshold) {
      this.id = id;
      this.region = region;
      this.threshold = threshold;
    }
    _set(score) {
      this.#score = score;
    }
    /** Share of the region that looks like the reference, 0 to 1; NaN until the reference is taken. */
    get score() { return this.#score ?? NaN; }
    get matches() { return this.#score != null && this.#score >= this.threshold; }
    retake() {
      this.#score = null;
      queue.push({ t: "similarRetake", id: this.id });
    }
  }

  const screen = {
    similar(region, options = {}) {
      if (typeof region !== "string") fail("screen.similar(region) needs a region name");
      const id = nextId++;
      const s = new Similar(id, region, options.threshold ?? 0.9);
      similars.set(id, s);
      queue.push({ t: "similar", id, region });
      return s;
    },
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

  // A state's timers belong to its scope, so a timeout can stop them.
  class Cancelled extends Error {
    constructor(state) {
      super(`State "${state}" was stopped`);
      this.name = "Cancelled";
    }
  }

  const timing = (scope) => {
    const add = (tm) => {
      if (scope?.cancelled) throw new Cancelled(scope.name);
      tm.scope = scope;
      timers.push(tm);
    };
    const wait = (ms) => new Promise((resolve, reject) => add({ kind: "wait", at: now + Number(ms), resolve, reject }));
    const waitUntil = (check, options = {}) =>
      new Promise((resolve, reject) =>
        add({
          kind: "until",
          check,
          deadline: options.timeout != null ? now + options.timeout : Infinity,
          resolve,
          reject,
        }),
      );
    const loop = Object.freeze({
      hz(rate, body, options = {}) {
        if (!(rate > 0)) fail("loop.hz(rate, fn) needs a rate above 0");
        if (typeof body !== "function") fail("loop.hz(rate, fn) needs a function");
        return new Promise((resolve, reject) =>
          add({
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
    });
    return { wait, waitUntil, loop };
  };

  const cancel = (scope) => {
    scope.cancelled = true;
    for (let i = 0; i < timers.length; i++) {
      if (timers[i].scope === scope) {
        const [tm] = timers.splice(i--, 1);
        tm.reject?.(new Cancelled(scope.name));
      }
    }
  };

  // Input from a stopped state is ignored.
  const scopedInput = (scope) => {
    const out = {};
    for (const key of Object.keys(input)) {
      const desc = Object.getOwnPropertyDescriptor(input, key);
      if (typeof desc.value === "function") {
        out[key] = (...args) => (scope.cancelled ? false : input[key](...args));
      }
    }
    Object.defineProperty(out, "latency", { get: () => latency });
    Object.defineProperty(out, "focused", { get: () => focused });
    return Object.freeze(out);
  };

  const special = (name) => queue.push({ t: "special", name });

  const log = (...args) => queue.push({ t: "log", text: args.map(format).join(" ") });

  const makeCtx = (scope) => {
    const t = timing(scope);
    const character = Object.freeze({
      reset() {
        if (scope?.cancelled) return Promise.reject(new Cancelled(scope.name));
        special("character.reset");
        return t.wait(1400);
      },
    });
    const game = Object.freeze({
      rejoin() {
        if (!scope?.cancelled) special("game.rejoin");
        return Promise.resolve();
      },
    });
    return Object.freeze({
      screen,
      input: scope ? scopedInput(scope) : input,
      loop: t.loop,
      wait: t.wait,
      waitUntil: t.waitUntil,
      log,
      settings,
      character,
      game,
      states,
      now: () => now,
    });
  };

  // State machines: see docs/API.md#state-machines.
  async function states(defs, options = {}) {
    if (!defs || typeof defs !== "object") fail("states(defs, options) needs an object of states");
    const names = Object.keys(defs);
    if (!names.length) fail("states() needs at least one state");
    for (const name of names) {
      if (typeof defs[name]?.run !== "function") fail(`State "${name}" needs a run(ctx) function`);
    }
    const start = options.start ?? names[0];
    const known = (name, where) => {
      if (!(name in defs)) fail(`${where} names an unknown state "${name}". States: ${names.join(", ")}`);
    };
    known(start, "start");
    if (options.recover != null) known(options.recover, "recover");
    for (const name of names) if (defs[name].onTimeout != null) known(defs[name].onTimeout, `State "${name}" onTimeout`);
    const dog = { maxTimeouts: 3, minSuccess: 0, ...(options.watchdog ?? {}) };
    const point = options.startPoint == null ? null : typeof options.startPoint === "string" ? { region: options.startPoint } : options.startPoint;
    const check = point ? screen.similar(point.region, { threshold: point.threshold ?? 0.9 }) : null;
    const limit = options.loops > 0 ? options.loops : Infinity;
    const t = timing(null);
    const stats = { loops: 0, timeouts: 0, recoveries: 0 };
    const results = [];
    let inARow = 0;
    let loopFailed = false;
    let name = start;
    let first = true;
    const note = (event, extra = {}) => queue.push({ t: "state", name, event, ...extra });
    const failLoop = (why) => {
      loopFailed = true;
      inARow++;
      if (inARow > dog.maxTimeouts) throw new Error(`Watchdog: ${inARow} timeouts or failed checks in a row, the last in "${name}" (${why}).`);
    };
    const goRecover = (why, target) => {
      failLoop(why);
      const next = target ?? options.recover;
      if (next == null) throw new Error(`${why}. Add a "recover" state (or onTimeout) to handle it.`);
      if (next === options.recover) stats.recoveries++;
      note("recover", { why, next });
      return next;
    };

    for (;;) {
      if (name === start) {
        if (!first) {
          results.push(!loopFailed);
          if (results.length > 10) results.shift();
          stats.loops++;
          if (stats.loops >= limit) return stats;
          const ok = results.filter(Boolean).length / results.length;
          if (dog.minSuccess > 0 && results.length >= 10 && ok < dog.minSuccess) {
            throw new Error(`Watchdog: only ${Math.round(ok * 100)}% of the last ${results.length} loops went cleanly (minimum ${Math.round(dog.minSuccess * 100)}%).`);
          }
          loopFailed = false;
          if (check && !(await t.waitUntil(() => check.matches, { timeout: point.wait ?? 2000 }))) {
            name = goRecover(`Not back at the start point ("${point.region}" ${(check.score * 100).toFixed(0)}% alike)`);
            continue;
          }
        }
        queue.push({ t: "loop", index: stats.loops });
        first = false;
      }
      note("enter");
      const def = defs[name];
      const scope = { name, cancelled: false };
      const running = Promise.resolve().then(() => def.run(makeCtx(scope)));
      let outcome;
      if (def.timeout > 0) {
        let timer;
        const timeout = new Promise((resolve) => {
          timer = { kind: "wait", at: now + def.timeout, resolve: () => resolve({ timedOut: true }) };
          timers.push(timer);
        });
        outcome = await Promise.race([running.then((next) => ({ next })), timeout]);
        timer.at = -Infinity;
        timer.resolve = () => {};
      } else {
        outcome = { next: await running };
      }
      if (outcome.timedOut) {
        cancel(scope);
        running.catch(() => {});
        stats.timeouts++;
        note("timeout", { after: def.timeout });
        name = goRecover(`State "${name}" timed out after ${def.timeout} ms`, def.onTimeout);
        continue;
      }
      inARow = 0;
      const next = outcome.next;
      if (next == null || next === "done") return stats;
      if (!(next in defs)) throw new Error(`State "${name}" went to unknown state "${next}". States: ${names.join(", ")}`);
      name = next;
    }
  }

  const ctx = makeCtx(null);

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
    for (const id in s.similar ?? {}) similars.get(Number(id))?._set(s.similar[id]);
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
