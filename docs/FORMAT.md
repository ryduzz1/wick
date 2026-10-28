# Macro format and sharing

> Proposed format, version 1. Nothing here is built yet.

A macro is a folder. Everything needed to run it is inside, and everything personal to one user (calibration, settings, recordings) lives outside it. That split is what makes a macro shareable: you can zip the folder, send it, and the other person's copy behaves the same once calibrated to their screen.

```
bar-minigame/
  wick.json          manifest: name, version, game, permissions, settings
  main.ts            entry point
  regions.json       named screen regions, resolution-independent
  templates/         images for template matching (PNG)
  start.png          snapshot of the starting point (optional)
  README.md          shown on the install screen
```

## `wick.json`

```json
{
  "wick": 1,
  "id": "ryduzz1/bar-minigame",
  "name": "Bar minigame",
  "version": "1.2.0",
  "description": "Keeps the tick inside the moving zone.",
  "author": "ryduzz1",
  "target": "roblox",
  "game": { "name": "Example Game", "placeId": 1234567890 },
  "entry": "main.ts",
  "permissions": ["mouse.click"],
  "settings": {
    "precision": { "type": "number", "min": 0, "max": 1, "default": 0.85, "label": "Precision" },
    "maxLoops": { "type": "integer", "min": 0, "default": 0, "label": "Loops (0 = forever)" }
  }
}
```

- `target` is the window the macro controls: `roblox` for real macros, `sim` or `testbench` while developing. See [targets](ARCHITECTURE.md#targets). The macro can't send input anywhere else.
- `id` is `author/name`. Updates match on `id`; a new `version` replaces the code and keeps the user's settings and calibration.
- `game.placeId` lets Wick warn you when you run a macro in a different game. It never blocks.
- `settings` describes options the user can change in the UI without editing code. The macro reads them through `ctx.settings`.

## `regions.json`

Regions are stored relative to the Roblox viewport, not in pixels, so they survive different screen sizes and window sizes. Each region picks an anchor, because Roblox UI is laid out from edges and corners:

```json
{
  "bar": { "anchor": "bottom-center", "x": 0, "y": -0.18, "w": 0.40, "h": 0.03 },
  "prompt": { "anchor": "center", "x": 0.05, "y": 0.10, "w": 0.12, "h": 0.05 }
}
```

`x`, `y`, `w` and `h` are fractions of the viewport height, so a region keeps its shape on wide and narrow windows.

## `main.ts`

```ts
import { macro } from "wick";

export default macro({
  async run(ctx) {
    const { screen, input, loop, settings } = ctx;
    const zone = screen.track("bar", { color: "#3ccf5a", tolerance: 30 });
    const tick = screen.track("bar", { color: "#ffffff", tolerance: 15, thin: true });

    await loop.hz(120, () => {
      if (!zone.seen || !tick.seen) return;
      const predicted = tick.x + tick.velocity * input.latency;
      if (predicted < zone.center) input.click({ minGap: 40 });
    }, { until: () => !screen.visible("bar") });
  },
});
```

Bigger macros are state machines: each state has a check, a timeout and a recovery step, and `ctx.loop.repeat(n)` runs the whole thing n times or forever. The API reference will live in `docs/API.md` once the engine exists.

## Sharing

- **Export:** `.wick` is the macro folder zipped, plus a SHA-256 of the contents in the archive comment. One file, easy to send or attach.
- **Install:** drag a `.wick` onto Wick, open a `wick://install?url=…` link, or paste a GitHub repo or Gist URL. A repo can hold one macro at its root or many in subfolders.
- **Install screen:** shows the README, the game, the permissions, and the full source, before anything runs.
- **Updates:** macros installed from a URL or repo can check for new versions. An update that adds a permission asks again.
- **Library index (later):** a public GitHub repo of `index.json` entries pointing to macro repos, browsable in the app. No Wick server.

## Calibration

The first time you run a shared macro, Wick overlays its regions on your Roblox window and runs each detector once. If something is off (a region misplaced by a different UI scale, a color shifted by graphics settings), you drag the region or click the right color, and Wick saves the correction. It can also ask an agent to fix it.

Calibration is saved per macro and per user under Wick's app data, never in the macro folder, so exporting a macro never includes your adjustments.

## Permissions and the sandbox

Macros are code from other people, so they run with nothing but the Wick API:

- No filesystem, network, child processes, clipboard, timers outside `loop`, or OS APIs.
- Screen access only through declared regions of the target window.
- Input only to the target window while it is focused, through the human profile, with the kill switch always active.

The manifest lists the kinds of input a macro uses, and the install screen shows them in plain words:

| Permission | Meaning |
| --- | --- |
| `mouse.click` | Click mouse buttons |
| `mouse.move` | Move the mouse or turn the camera |
| `keyboard` | Press keys |
| `character.reset` | Reset your character (Esc → R → Enter) |
| `game.rejoin` | Rejoin the game after a disconnect |

A macro that uses an input it didn't declare is stopped and reported.

## Per-user data

Stored in Wick's app data directory, keyed by macro `id`:

- `settings.json`: the user's values for the manifest's `settings`.
- `calibration.json`: region and color corrections.
- `runs/`: run logs and telemetry.
- `recordings/`: clips and traces.
