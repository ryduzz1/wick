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

Anything still held when a run ends is released.

## Timing

| | |
| --- | --- |
| `loop.hz(rate, body, { until?, for? })` | Calls `body` up to `rate` times a second (at most once per frame) until `until()` returns true or `for` ms pass. Resolves when it stops; rejects if `body` throws. |
| `loop.repeat(times, body)` | Awaits `body(i)` `times` times, or forever when `times` is 0. Each pass counts as a loop in the app. |
| `wait(ms)` | Resolves after `ms`. |
| `waitUntil(check, { timeout? })` | Resolves `true` once `check()` returns true, or `false` after `timeout` ms. |
| `now()` | Milliseconds since the run started. |

## Other

| | |
| --- | --- |
| `settings` | The values of the manifest's `settings`, as the user set them in the app, read-only. |
| `log(...values)` | Writes a line to the run log. |

## What macros can't do

There is no `fetch`, `require`, `process`, `setTimeout`, file access, or any way to reach the network, other processes or the OS. Screen access is limited to the target window, and input to the target window while it's focused.
