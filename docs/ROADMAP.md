# Roadmap

Wick is built in passes. Each pass ends with working, tested code, a commit, and an update to this file. Every pass lists how it's checked: automated checks run in CI, and manual checks are steps for you to try on your own machine.

## Done

- Project setup: README, working agreement, and design docs for the architecture, the macro format and sharing, agent tools, and visual design.
- Scope decision: Roblox-first product on a target-based engine (see [targets](ARCHITECTURE.md#targets)).

### Pass 1: Engine, runtime and first app window (planned passes 1–4)

Built as one large pass:

- **Engine (`engine/`):** a Rust workspace. `wick-platform` is the OS layer; `wick-engine` is a binary speaking newline-delimited JSON-RPC over stdio (`ping`, `version`, `permissions`, `targets.list`, `session.*`, `macro.run`, `macro.stop`, `killswitch`, `sim.run`, `shutdown`).
- **Targets:** `roblox` and `testbench` (found by window owner, title or executable name, never a process handle), and `sim`, a deterministic bar-minigame simulation with adjustable drift, push, zone size, jumps, latency and seed.
- **Capture:** ScreenCaptureKit on macOS and Windows Graphics Capture on Windows, at up to 120 fps, with the game area worked out per platform.
- **Input:** clicks, holds, keys, absolute and relative mouse movement through CGEvent and SendInput, dropped unless the target is focused, and released when a run ends.
- **Kill switch:** F8, registered by the engine (event tap on macOS, `RegisterHotKey` on Windows), with an app-level fallback.
- **Vision:** anchored regions, the `color` detector, and trackers with position, extent, velocity and time missing.
- **Macro runtime:** QuickJS with the first API (`screen.track`, `input`, `loop.hz`, `loop.repeat`, `wait`, `waitUntil`, `settings`, `log`), documented in [API.md](API.md). The sandbox has no globals beyond the API, imports limited to the macro's own files, memory and per-step time limits, and undeclared permissions stop the macro.
- **App:** type stripping and `wick.json` validation; a window with the macro list, target picker, live view with region and tracker overlays, run controls, stats, a settings form, run log, simulator test, macOS permission onboarding and the kill-switch chip.
- **Test bench:** the minigame as a page the app opens in its own window.
- **Example:** `examples/bar-minigame/`, a hand-written macro.
- **Tooling:** `npm start`, `test`, `test:engine`, `check`, `smoke:app`, and CI on macOS and Windows.

**Verification:**

- 36 Rust tests: simulation, regions, vision, trackers, input scheduling, the runtime and sandbox (no `fetch`, `require` or `process`; imports outside the macro rejected; runaway steps stopped), and full headless runs.
- 14 Node tests: manifest and settings validation, type stripping, and end-to-end tests against the engine binary (live session previews, kill switch, `macro.stop`, error messages).
- The example keeps the tick in the zone about 90% of the time on average across 20 sim seeds, worst game about 88%. That's short of the 95% target set for this pass; CI checks for at least 87% average and 82% worst. The misses come from the zone jumping away, which the macro can't predict.
- `npm run check` (rustfmt, clippy with warnings as errors, syntax) is clean, and the Windows code type-checks with `cargo check --target x86_64-pc-windows-msvc`.
- The app smoke test opens the window, runs the example on the simulator and draws the live view.
- **Not yet tested by hand:** real capture and input on macOS (test bench and Roblox), and everything on Windows.

## Build plan

Left over from passes 1–4, to fold into the passes below: a `dist:dir` packaged build, `template` and `similar` detectors and a PNG fixture set, measured (rather than fixed) input latency on real windows, and a per-frame detector benchmark.

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
