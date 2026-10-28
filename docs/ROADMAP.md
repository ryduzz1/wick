# Roadmap

Wick is built in passes. Each pass ends with working, tested code, a commit, and an update to this file. Every pass lists how it's checked: automated checks run in CI, and manual checks are steps for you to try on your own machine.

## Done

- Project setup: README, working agreement, and design docs for the architecture, the macro format and sharing, agent tools, and visual design. No code yet.
- Scope decision: Roblox-first product on a target-based engine (see [targets](ARCHITECTURE.md#targets)).

## Build plan

### Pass 1: Skeleton

Set up the two halves and the pipe between them.

- `engine/`: Rust workspace with a `wick-engine` binary that speaks JSON-RPC over stdin/stdout (`ping`, `version`, `shutdown`).
- `app/`: Electron app in plain JS that starts the engine, restarts it if it crashes, and shows an empty window styled per [DESIGN.md](DESIGN.md).
- `package.json` scripts matching Fuse: `start`, `test`, `check`, `dist:dir`.
- GitHub Actions on macOS and Windows: build the engine, run Rust and Node tests.

**Checks:** CI green on both platforms. Manual: `npm start` opens the window and shows the engine version.

### Pass 2: Targets, capture and the kill switch

- The `Target` trait and three targets: `roblox`, `sim` (a deterministic bar-minigame simulation with adjustable drift, click push, zone size, jump interval and seed), and `testbench`.
- `testbench/`: the same minigame as a standalone web page, for testing real capture and input end to end.
- Window finding without process handles, focus detection, and viewport detection.
- Window capture at 60+ fps on macOS (ScreenCaptureKit) and Windows (Windows Graphics Capture), with DPI and Retina scaling handled.
- Engine-registered kill-switch hotkey.
- macOS permission checks for Screen Recording and Accessibility, with an onboarding screen.

**Checks:** Rust tests for the simulation and viewport math. Manual: the app finds the Roblox and test-bench windows, shows capture fps above 60, and the kill switch fires.

### Pass 3: Vision

- Regions with anchors, resolved against the viewport.
- Detectors: `color` (masks, blobs, extents), `template` (normalized cross-correlation), `similar` (screen-to-image comparison), `visible`.
- Trackers: position, velocity and last-seen time across frames.
- A fixture set of PNG frames (sim renders plus real captures you provide) with expected results.

**Checks:** detector tests against fixtures; benchmark for per-frame detector time on a typical region (target: under 1 ms). Manual: none yet.

### Pass 4: Input and the macro runtime

- Input on both platforms: clicks, keys, holds, absolute and relative mouse movement, dropped unless the target is focused.
- Measured input latency, exposed as `input.latency`.
- QuickJS runtime in the engine with the first API: `screen`, `input`, `loop`, `wait`, `settings`, `log`. Written up in `docs/API.md`.
- The sandbox: no globals beyond the API, an in-memory module loader limited to the macro folder, undeclared permissions stop the macro.
- Type stripping in the app; `wick.json` validation.
- `examples/bar-minigame/`: a hand-written macro for the bar minigame.

**Checks:** the example macro keeps the tick in the zone at least 95% of the time on the `sim` target across 20 seeds, headless, in CI. Sandbox tests: a macro that tries `fetch`, `require`, file access or an undeclared input is stopped. Manual: the example macro runs against the test-bench page.

### Pass 5: App shell

- Library: list, open, create, delete, and settings per macro, with a library folder you choose (default `~/Documents/Wick`).
- Macro page: Run and Stop, run states, stat tiles, the macro's settings form, and a run log.
- Live view: the captured frame with region, mask and tracker overlays; drag and resize regions.
- Kill-switch chip and toasts.

**Checks:** Node tests for the library and settings storage; a smoke test that launches the app and runs the example on `sim`. Manual: create a macro, draw a region on the test bench, run and stop it.

### Pass 6: Agent tools

- `wick` CLI and `wick mcp` (MCP over stdio), both talking to the app through the local socket.
- Commands: `observe`, `act`, `probe`, `detect preview`, `region set`, `run`, `stop`, `telemetry`.
- A generated `AGENTS.md` and `CLAUDE.md` in every macro folder.

**Checks:** CLI tests against `sim`, including a `probe` that measures drift speed and click push within 5% of the simulation's true values. Manual: ask Claude Code, started in a new macro folder, to build the bar-minigame macro from scratch on the test bench.

### Pass 7: Recording and traces

- `record`: PNG keyframes, change detection, and synchronized input and tracker logs (JSONL).
- Trace graphs in the app, for live runs, recordings and run logs.
- Run logs kept per run, with the detector log around each failure.

**Checks:** tests that a sim recording's trace matches the simulation's ground truth. Manual: record a clip of the test bench and view its trace.

### Pass 8: Human profile

- Reaction delay spread, timing and hold jitter, curved mouse paths with overshoot, occasional mistakes, slow drift over a session, and the precision slider.
- Profiles applied to every output, with a "raw" option for testing.

**Checks:** statistical tests that sampled delays and paths match their configured distributions; the example macro still passes at precision 0.85 on `sim`. Manual: watch mouse paths in the test bench.

### Pass 9: State machines, looping and the Roblox target's extras

- `states()` API: each state with a check, a timeout and a recovery step; `loop.repeat(n)`, with 0 meaning forever.
- Start-point snapshot and check before every loop.
- Roblox extras: `character.reset`, and `game.rejoin` through the `roblox://` link when the disconnect dialog is detected.
- Watchdogs: stop or alert when the success rate drops or a state keeps timing out.

**Checks:** sim tests with injected failures (zone disappears, "disconnect") that verify recovery. Manual: a looping macro in a real game that allows macros, including a forced reset.

### Pass 10: Sharing

- `wick pack` and Export: `.wick` files with a content hash.
- Install from a file, a `wick://install` link, or a GitHub repo or Gist URL.
- Install screen with README, target, game, permissions and source; updates that keep settings and ask again for new permissions.
- Calibration: overlay on first run, drag to fix regions, click to fix colors, saved per user.

**Checks:** tests for pack and install round trips, tampered-package rejection, and settings kept across updates. Manual: export a macro, install it on another account or machine, and calibrate it.

### Pass 11: Polish

- The mini window over Roblox.
- OCR (Vision on macOS, Windows.Media.Ocr on Windows).
- Logo, icon, onboarding, empty states, keyboard shortcuts, and a full pass against [DESIGN.md](DESIGN.md).

**Checks:** OCR fixture tests. Manual: a full first-run walkthrough on both platforms.

### Pass 12: Release

- Signed and notarized macOS build, Windows installer, auto-update, engine bundled with the app.
- Release script and `docs/RELEASING.md`, as in Fuse.

**Checks:** a release build installs and runs on clean macOS and Windows machines.

## Later

- `window` target: control any window the user picks.
- Public library index.
- Block or graph editor on top of the same API.
- Teach-by-demo: infer a macro's rules from a recording of you playing.

## Out of scope

- Reading, writing or injecting into the Roblox process, for any purpose. Wick works only from the screen and OS input.
