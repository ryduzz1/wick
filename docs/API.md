# Macro API

A macro's entry file (usually `main.ts`) default-exports `macro({ async run(ctx) { ... } })`. Everything a macro can do goes through `ctx`. Types are in [`sdk/wick.d.ts`](../sdk/wick.d.ts); point your editor at it with a `tsconfig.json` like the one in [`examples/bar-minigame`](../examples/bar-minigame).

```ts
import { macro, type Context } from "wick";

export default macro({
  async run(ctx: Context) {
    const marker = ctx.screen.track("bar", { color: "#ffffff" });
    await ctx.loop.hz(60, () => {
      if (marker.seen && marker.x < 0.5) ctx.input.click({ minGap: 50 });
    });
  },
});
```

Macros are TypeScript with types erased, so use annotations freely but not `enum`, `namespace` or other syntax that needs compiling. They can import `"wick"` and their own files (`"./helpers.ts"`), nothing else.

## How a run works

The engine steps the macro once per captured frame. Each step it updates every tracker from the new frame, advances time, runs any `loop.hz` bodies and timers that are due, and then sends the input the macro queued. One step may run for at most 250 ms; a macro that takes longer is stopped. Keep work inside a step small, and wait with `loop.hz`, `wait` or `waitUntil` instead of looping.

Times are in milliseconds since the run started, and `ctx.now()` returns the current one.

## `ctx.screen`

| | |
| --- | --- |
| `track(region, { color, tolerance?, minPixels? })` | Starts following a color inside a region from `regions.json`. `color` is `#rrggbb`; `tolerance` (default 30) is the largest difference allowed on any channel; `minPixels` (default 3) is the fewest matches that count as found. Returns a tracker. |
| `similar(region, { threshold? })` | Starts comparing a region to how it looks on the next frame. Returns a check with `score` (the share of the region that still looks the same, 0 to 1), `matches` (`score` ≥ `threshold`, default 0.9) and `retake()`. Use it to tell whether you're back where you started. |
| `width`, `height` | The game viewport's size in frame pixels. |

### Trackers

Positions are fractions of the region: 0 at its left or top edge, 1 at its right or bottom edge.

| | |
| --- | --- |
| `seen` | Whether it was found in the latest frame. |
| `x`, `y` | Centroid of the matching pixels. |
| `left`, `right`, `top`, `bottom` | Extent of every matching pixel together, so a shape split by something drawn over it still reports its full size. |
| `center`, `middle` | Middle of that extent, horizontally and vertically. |
| `width`, `height` | Size of the extent. |
| `velocity` (`vx`), `vy` | Speed over the last ~60 ms, in region widths or heights per second. |
| `pixels`, `coverage` | How many pixels matched, and what fraction of the region that is. |
| `missingFor` | Milliseconds since it was last seen; 0 while visible. |

A tracker reads `seen: false` until the first frame after it's created.

## `ctx.input`

Each kind of input needs a permission in `wick.json`; using one that isn't declared stops the macro. Input is only sent while the target window has focus and is otherwise dropped (and counted).

| | Permission | |
| --- | --- | --- |
| `click({ button?, at?, hold?, minGap? })` | `mouse.click` | Clicks `button` (`left`, `right`, `middle`; default left), holding it `hold` ms (default 30). With `at`, moves there first. With `minGap`, skips the click and returns `false` if the last click with that button was less than `minGap` ms ago. |
| `mouseDown(button?)`, `mouseUp(button?)` | `mouse.click` | Presses or releases a button. |
| `move(at)` | `mouse.move` | Moves the cursor to a point. |
| `turn(dx, dy?)` | `mouse.move` | Moves the mouse by a relative amount, which is how games read camera turns. |
| `press(key, { hold? })` | `keyboard` | Taps a key, holding it `hold` ms (default 40). |
| `keyDown(key)`, `keyUp(key)` | `keyboard` | Presses or releases a key. |
| `latency` | | Estimated seconds between sending input and the game reacting. Exact on the simulator; a fixed 40 ms estimate on real windows for now. |
| `focused` | | Whether the target window has focus. |

A point (`at`) is a region name, or `{ region, x, y }` with `x` and `y` as fractions of the region (default 0.5, its center). Without a region, it's relative to the whole viewport.

Keys are lowercase names: `a`–`z`, `0`–`9`, `f1`–`f12`, `space`, `enter`, `escape`, `tab`, `backspace`, `shift`, `control`, `alt`, `command`, `up`, `down`, `left`, `right`, `minus`, `equal`, `comma`, `period`, `slash`, `semicolon`, `quote`, `backquote`, `leftbracket`, `rightbracket`, `backslash`.

Anything still held when a run ends is released, and so is anything a state was holding when it timed out.

### Routes

`input.play(route, { until?, settle?, speed? })` replays a route: a list of timed actions, usually cut from a recording of the person playing with `wick route` (see [AI-AGENTS.md](AI-AGENTS.md#teaching-a-loop)). It goes through the same permissions and human profile as other input, and resolves to `{ reached, ms }`.

```ts
import toVendor from "./routes/to-vendor.js";

const r = await ctx.input.play(toVendor, { until: () => prompt.seen, settle: 1000 });
if (!r.reached) return "recover";
```

| Action | |
| --- | --- |
| `{ t, do: "hold", key, ms }` | Holds a key for `ms`. |
| `{ t, do: "press", key, ms? }` | Taps a key. |
| `{ t, do: "keyDown" \| "keyUp", key }` | Presses or releases a key. |
| `{ t, do: "click", button?, at?, region?, ms? }` | Clicks; `at` is `[x, y]` as fractions of the viewport (or of `region`), or a point. |
| `{ t, do: "turn", dx, dy?, ms? }` | Turns the camera, spread over `ms`. |
| `{ t, do: "wait", ms }` | Nothing; makes the route last longer. |

`t` is ms from the start of the route. When `until` returns true the route stops, letting go of any keys it holds, and `reached` is true. Without `until`, `reached` is true once the route ends. `settle` keeps checking `until` for that many ms after the last action, and `speed` scales the timing (2 plays twice as fast).

Routes are only as good as the place they start from: begin each one from somewhere the macro can always get back to (the spawn after `character.reset()`, or a spot a check confirms), and end it with an `until` on something the screen shows on arrival. A route that doesn't arrive is a reason to recover, not to keep walking.

## Timing

| | |
| --- | --- |
| `loop.hz(rate, body, { until?, for? })` | Calls `body` up to `rate` times a second (at most once per frame) until `until()` returns true or `for` ms pass. Resolves when it stops; rejects if `body` throws. |
| `loop.repeat(times, body)` | Awaits `body(i)` `times` times, or forever when `times` is 0. Each pass counts as a loop in the app. |
| `wait(ms)` | Resolves after `ms`. |
| `waitUntil(check, { timeout? })` | Resolves `true` once `check()` returns true, or `false` after `timeout` ms. |
| `now()` | Milliseconds since the run started. |

## State machines

Anything that repeats, like fish, sell, repeat, is easiest to write as states. Each state does one step and returns the name of the next one. Give a state a `timeout`, and if it hasn't finished by then, the machine stops it and goes to a recovery state instead, so a stuck macro fixes itself rather than waiting forever.

```ts
const stats = await ctx.states({
  cast: { timeout: 4000, async run(s) { await s.waitUntil(() => prompt.seen); s.input.press("e"); return "bite"; } },
  bite: { timeout: 3000, async run(s) { await s.waitUntil(() => bar.seen); return "play"; } },
  play: { timeout: 10_000, async run(s) { /* the minigame */ return "cast"; } },
  recover: { timeout: 15_000, async run(s) { await s.character.reset(); await s.waitUntil(() => prompt.seen); return "cast"; } },
}, { recover: "recover", startPoint: "hud", loops: 0 });
```

| Option | |
| --- | --- |
| `start` | The state each loop starts from (default: the first). Every return to it counts as a loop. |
| `loops` | Stop after this many loops; 0 runs until a state returns `"done"`. |
| `recover` | Where timeouts and failed start-point checks go, unless the state has its own `onTimeout`. Without one, a timeout stops the macro with an error. |
| `startPoint` | A region name (or `{ region, threshold?, wait? }`) that must look the way it did at the first loop before each later loop begins. It waits up to `wait` ms (default 2000), then goes to `recover`. |
| `watchdog` | `maxTimeouts` (default 3): stop after that many timeouts or failed checks in a row. `minSuccess` (default off): stop when fewer than that share of the last 10 loops went without a timeout. |

Each state's `run` gets its own `ctx`. Use it, not the outer one, for waits, loops and input inside the state: when the state times out, its waits and loops stop and its input is ignored. `states()` resolves with `{ loops, timeouts, recoveries }`. The app shows the current state while it runs, and the run's log notes every timeout and recovery.

## Game actions

| | Permission | |
| --- | --- | --- |
| `character.reset()` | `character.reset` | Resets your character. On Roblox: Esc, R, Enter, with pauses for the menu. Resolves after the keys are sent; wait for your HUD or prompt to come back. |
| `game.rejoin()` | `game.rejoin` | Rejoins the game in `wick.json`'s `game.placeId` through Roblox's `roblox://` link. At most once a minute. |

On the simulator both work on its looping game (see [FORMAT.md](FORMAT.md#simulator)); on the test bench they aren't available.

## Other

| | |
| --- | --- |
| `settings` | The values of the manifest's `settings`, as the user set them in the app, read-only. |
| `log(...values)` | Writes a line to the run log. |

## What macros can't do

There is no `fetch`, `require`, `process`, `setTimeout`, file access, or any way to reach the network, other processes or the OS. Screen access is limited to the target window, and input to the target window while it's focused.
