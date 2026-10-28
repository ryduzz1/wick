# Macro format and sharing

> Format version 1. Folders, `wick.json`, `regions.json`, the entry file, settings, permissions, the simulator setup, templates, routes, `.wick` packages, installing, updates and calibration work today; `start.png` and the public library index are planned. See the [roadmap](ROADMAP.md).

A macro is a folder. Everything needed to run it is inside, and everything personal to one user (calibration, settings, recordings) lives outside it. That split is what makes a macro shareable: you can zip the folder, send it, and the other person's copy behaves the same once calibrated to their screen.

```
bar-minigame/
  wick.json          manifest: name, version, game, permissions, settings
  main.ts            entry point
  regions.json       named screen regions, resolution-independent
  templates/         images for screen.find (PNG), with templates.json
  routes/            routes for input.play, cut from recordings (JS)
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

Setting types are `number`, `integer`, `boolean` and `string`. Numbers are clamped to `min` and `max`.

- `target` is the window the macro controls: `roblox` for real macros, `sim` or `testbench` while developing. See [targets](ARCHITECTURE.md#targets). The macro can't send input anywhere else.
- `id` is `author/name`. Updates match on `id`; a new `version` replaces the code and keeps the user's settings and calibration.
- `game.placeId` is the place `game.rejoin()` joins, and lets Wick warn you when you run a macro in a different game. It never blocks.
- `simulator` (optional) describes the simulated game the macro is tested on; see [below](#simulator).
- `settings` describes options the user can change in the UI without editing code. The macro reads them through `ctx.settings`.

## `regions.json`

Regions are stored relative to the Roblox viewport, not in pixels, so they survive different screen sizes and window sizes. Each region picks an anchor, because Roblox UI is laid out from edges and corners:

```json
{
  "bar": { "anchor": "bottom-center", "x": 0, "y": -0.18, "w": 0.40, "h": 0.03 },
  "prompt": { "anchor": "center", "x": 0.05, "y": 0.10, "w": 0.12, "h": 0.05 }
}
```

`x` and `y` place the region's center relative to its anchor, and `w` and `h` give its size. All four are fractions of the viewport height, so a region keeps its shape on wide and narrow windows.

## `templates/` and `templates.json`

Each `templates/NAME.png` is an image `screen.find(region, { template: "NAME" })` looks for. `templates.json` records the window height each one was saved at, so it can be scaled to the window it runs in:

```json
{ "sell-button": { "viewportHeight": 1080, "region": "sellButton" } }
```

`wick template save NAME --region R` writes both. The app sends templates to the engine with the macro; macro code never reads files.

## `routes/`

Routes cut from recordings by `wick route --name NAME` are saved as `routes/NAME.js`, a module whose default export is the list of actions, so a macro imports them like any other file (`import toVendor from "./routes/to-vendor.js"`). See [API.md](API.md#routes).

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

Bigger macros are state machines: each state has a check, a timeout and a recovery step, and `ctx.loop.repeat(n)` runs the whole thing n times or forever. The full API is in [API.md](API.md).

## Sharing

- **Export:** `.wick` is the macro folder zipped, plus a SHA-256 of the contents in the archive comment (`wick-sha256:<hash>`). One file, easy to send or attach. The hash covers every file's name and contents, so the same folder always packs to the same file. Dot files, `node_modules`, and the generated `AGENTS.md`, `CLAUDE.md` and `wick.d.ts` are left out. The Export button, `wick pack` and `wick_pack` make one.
- **Install:** drop a `.wick` (or a link) onto Wick, double-click a `.wick`, open a `wick://install?url=…` link, or use Install macro (⇧⌘I) to pick a file or paste a link to a `.wick`, a GitHub repo (optionally `/tree/<branch>/<subfolder>`) or a Gist. A repo can hold one macro at its root or many in subfolders; with many, Wick asks which. Links must be `https`.
- **Install screen:** shows the name, version, author and target, whether the files still match the package's hash, the permissions in plain words, the README, and every file's source, before anything is written. A package that changed after export, or has unsafe paths or a broken manifest, can't be installed.
- **Updates:** a macro installed from a link has Check for updates. It installs over the old folder in place (matched on `id`), keeps `.wick/` (recordings, local data), settings and calibration, and marks any permission the new version adds. Wick records where each macro came from in `.wick/install.json`.
- **Library index (later):** a public GitHub repo of `index.json` entries pointing to macro repos, browsable in the app. No Wick server.
- **Library index (later):** a public GitHub repo of `index.json` entries pointing to macro repos, browsable in the app. No Wick server.

## Calibration

An installed macro's regions show on the live view over your game. If one is off (a different UI scale), drag it to fit; if a color the macro tracks looks different in your game (graphics settings, a shader), pick it in the Calibration card by clicking what your game shows. Wick keeps both as corrections: moved regions replace the macro's by name, and picked colors swap the macro's color for yours whenever it tracks it. `wick calibration` and `wick_calibration` do the same for agents.

Calibration is saved per macro id and per user in Wick's app data (`calibration/<id>.json`), never in the macro folder, so exports never include it and updates keep it. Reset puts the macro back to its own regions and colors.

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

## Simulator

The `sim` target plays a bar minigame. A macro can ask for a different setup in `wick.json`, which Wick uses whenever it runs or tests the macro on the simulator:

```json
"simulator": { "roundMs": 2500, "stuckRounds": [3], "disconnectAtMs": 30000 }
```

| Field | Default | |
| --- | --- | --- |
| `roundMs` | 0 | Round length. With a value, the game loops: a yellow prompt (top center) waits for E, the bar appears `castMs` later, and the prompt returns when the round ends. 0 is one endless round. |
| `castMs` | 800 | From E to the bar. |
| `winShare` | 0.6 | A round is won when the tick was in the zone this share of it. |
| `stuckRounds` | none | Rounds (from 1) whose cast never lands until the character is reset. |
| `disconnectAtMs` | none | When a disconnect dialog covers the game; `game.rejoin()` brings it back after `rejoinMs` (3000). |
| `resetMs` | 1500 | How long a character reset takes. |
| `drift`, `push`, `pushMs`, `zone`, `jumpMs`, `jumpRange`, `latencyMs`, `seed` | | The minigame's own tuning. |

A blue HUD sits at the bottom left except while resetting or rejoining. The simulator's score then reports rounds started, played and won, resets and rejoins.

### The world

With `"world": {}`, the bar is part of a small top-down world (rounds default to 2.5 s). The character (orange, with a dark mark showing its heading) starts at the spawn facing up. W and S walk along the heading, A and D strafe, and mouse turns rotate the heading. At the dock, E casts and a round plays; each won round adds a fish to the bag, the slots at the bottom left. At the vendor (the red stall), E opens a sell menu: its green button sells the bag and Escape closes it. The yellow prompt shows whenever the character is close enough to the dock or the vendor to use it, and a character reset puts it back at the spawn.

| `world` field | Default | |
| --- | --- | --- |
| `bag` | 5 | Fish the bag holds. |
| `speed` | 0.3 | Walking speed, in viewport heights per second. |
| `turnRate` | 0.004 | Radians of heading per pixel of mouse turn. |
| `spawn`, `dock`, `vendor` | `[0.89, 0.62]`, `[0.89, 0.22]`, `[1.45, 0.62]` | Positions, in viewport heights from the top left. |
| `reach` | 0.08 | How close counts as being there. |
| `price` | 10 | Coins per fish. |

The score adds a `world` object: the bag, fish caught and sold, sales, coins, where the character is and which way it faces, and how far it walked.

### Scripted demonstrations

`"demo"` is a list of route actions (see [API.md](API.md#routes)) that a scripted person plays: their input reaches the game and is heard like a real person's, so `wick record --you --target sim --scenario demo.json` makes a demonstration, storyboard and routes without anyone playing. `examples/fishing-trip/demo.json` is one.

## Per-user data

Stored in Wick's app data directory, keyed by macro `id`:

- `settings.json`: the user's values for the manifest's `settings`.
- `calibration/<id>.json`: region and color corrections.
- `runs/`: run logs and telemetry.
- `recordings/`: clips and traces.
