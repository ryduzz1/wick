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

### Pass 2: Library and editor (planned pass 5)

- **Library:** macros in a library folder (default `~/Documents/Wick`), plus folders you open and the bundled examples, grouped in the sidebar. **New macro** (⌘N) creates one from a starter template; **Make a copy** turns an example into your own; library macros move to the Trash, opened ones are removed from the list.
- **Live view editor:** select, drag and resize regions on the captured frame, draw new ones (the anchor is picked from where you draw), and pick colors from the frame. Matching pixels for the current color are tinted ember, with a count.
- **Panels:** regions (rename, change anchor without moving, delete), color (hex, tolerance, a ready-to-paste `screen.track` line), and macro details (name, description, target, permissions).
- **Live reload:** the app watches the macro folder, so edits from an editor or an agent show up right away. **Edit code** opens the entry file.
- New macros include `wick.d.ts` and a `tsconfig.json` so editors type-check them.
- One accent color throughout (ember), and the logo matches Fuse's style.

**Verification:** library tests (create, copy, region validation and rounding, manifest edits) and region-math tests that check the UI's conversion against the engine's. The app smoke test now creates a macro through the dialog, drags its region on the live view, checks the saved `regions.json`, and checks color matches.

### Pass 3: Agent tools (planned pass 6)

- **Engine:** `session.probe` (follow colors while sending timed input, returning each tracker's track over time), `sim.probe` (the same on the simulator, instantly), `session.detect` (matches plus a palette of the region's main colors, and a mask image), cropped `session.snapshot`, and `session.act` for single inputs. Agent input is focus-gated and released by the kill switch like a macro's.
- **Command layer** (`app/commands.js`) shared by the app's control socket, the `wick` CLI and the MCP server: status, observe, detect, act, probe, regions, run, simulate, telemetry, stop, new, init.
- **Control socket:** the app serves the commands on a user-only Unix socket (a named pipe on Windows), so agents work through the open app and their actions appear in its window and log. Without the app, the CLI starts its own engine.
- **`wick mcp`:** the same tools over MCP, with screenshots and masks returned as images.
- **Agent files:** every new or copied macro gets `AGENTS.md`, `CLAUDE.md` and `.mcp.json`.

**Verification:** probe tests measure the simulator's drift and click push within 5% of the true values (the pass's target). Agent tests cover input normalization, CLI parsing, detect, observe, probe, act, regions, run, simulate and telemetry on `sim`, the control socket, the MCP server end to end (including image results), and CLI errors. The app smoke test runs the CLI against the open app and checks it used the app's engine.

## Still to test by hand

Kept for the end-to-end test once the app is finished:

- macOS: capture and input on the test bench and in Roblox; F8 from another app; the permission prompts on a fresh install.
- The live view editor on a real window: drag, resize, draw and color picking.
- Agent tools on a real window: `observe`, `detect`, `probe` and `act` on the test bench; Claude Code building a macro from a new folder.
- Everything on Windows.

## Build plan

Left over from passes 1–4, to fold into the passes below: a `dist:dir` packaged build, `template` and `similar` detectors and a PNG fixture set, measured (rather than fixed) input latency on real windows, a per-frame detector benchmark, and choosing the library folder in the app.

### Pass 4: Recording, traces and human-like input (planned passes 7 and 8)

- `record`: PNG keyframes, change detection, and synchronized input and tracker logs (JSONL).
- Trace graphs in the app, for live runs, recordings and run logs.
- Run logs kept per run, with the detector log around each failure.

**Checks:** tests that a sim recording's trace matches the simulation's ground truth. Manual: record a clip of the test bench and view its trace.

#### Human profile

- Reaction delay spread, timing and hold jitter, curved mouse paths with overshoot, occasional mistakes, slow drift over a session, and the precision slider.
- Profiles applied to every output, with a "raw" option for testing.

**Checks:** statistical tests that sampled delays and paths match their configured distributions; the example macro still passes at precision 0.85 on `sim`. Manual: watch mouse paths in the test bench.

### Pass 5: State machines, looping and the Roblox target's extras

- `states()` API: each state with a check, a timeout and a recovery step; `loop.repeat(n)`, with 0 meaning forever.
- Start-point snapshot and check before every loop.
- Roblox extras: `character.reset`, and `game.rejoin` through the `roblox://` link when the disconnect dialog is detected.
- Watchdogs: stop or alert when the success rate drops or a state keeps timing out.

**Checks:** sim tests with injected failures (zone disappears, "disconnect") that verify recovery. Manual: a looping macro in a real game that allows macros, including a forced reset.

### Pass 6: Sharing

- `wick pack` and Export: `.wick` files with a content hash.
- Install from a file, a `wick://install` link, or a GitHub repo or Gist URL.
- Install screen with README, target, game, permissions and source; updates that keep settings and ask again for new permissions.
- Calibration: overlay on first run, drag to fix regions, click to fix colors, saved per user.

**Checks:** tests for pack and install round trips, tampered-package rejection, and settings kept across updates. Manual: export a macro, install it on another account or machine, and calibrate it.

### Pass 7: Polish and release (planned passes 11 and 12)

- The mini window over Roblox.
- OCR (Vision on macOS, Windows.Media.Ocr on Windows).
- Logo, icon, onboarding, empty states, keyboard shortcuts, and a full pass against [DESIGN.md](DESIGN.md).

**Checks:** OCR fixture tests. Manual: a full first-run walkthrough on both platforms.

#### Release

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
