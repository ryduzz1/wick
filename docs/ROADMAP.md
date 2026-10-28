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

### Pass 4: Recording, traces and human-like input (planned passes 7 and 8)

- **Human profile** (`engine/crates/wick-engine/src/human.rs`): a skewed reaction delay, hold spread, curved mouse paths that slow near the target and sometimes overshoot and correct, turns split into steps that add up exactly, occasional slips, and drift over a long session, all scaled by one precision value. Inputs keep their order. On by default at 0.85; **Settings** (⌘,) turns it off, sets precision and changes the library folder. Probes and agent inputs stay exact; `run` and `simulate` take `--exact`.
- **Recordings:** `session.record` and `sim.record` save keyframes, a change score per sample, every input and a contact sheet; `wick record` and `wick_record` expose them, with `--run` to run the macro meanwhile and `--you` to log the person's own clicks and keys while the game has focus (a pass-through event tap on macOS, low-level hooks on Windows, removed when the recording ends; Wick's own input is left out).
- **Traces:** live runs stream tracker positions and inputs; the app draws them as a trace graph (bands for wide trackers such as a zone, lines for narrow ones, ember ticks for inputs, values on hover).
- **Run history:** each live run is saved with how it ended, its stats, its log and the trace of its last 15 seconds. The **Runs** card lists them and opens one into the trace graph; `wick runs` and `wick_runs` give agents the same.

**Verification:** human profile tests check delay means and spreads against precision, session drift, hold spread, that paths curve, sometimes overshoot and always end on target, that turns add up, and that inputs never reorder; the example still averages over 80% in the zone on `sim` with the profile at 0.85. Recorder tests check keyframes, change scores, Wick and "you" inputs with positions, and the contact sheet. A trace test checks the tick's traced position against the simulator's true position on every frame (within 1% of the bar). Node tests cover `record` with `--run` on `sim` and run history (saving, listing, trimming, reading). The app smoke test runs a macro, checks the trace graph and the saved run, and changes a setting. The Windows hooks type-check with `cargo clippy --target x86_64-pc-windows-msvc`.

### Pass 5: State machines, looping and the Roblox target's extras (planned passes 9 and 10)

- **`ctx.states()`:** states that return the next state's name, per-state timeouts that stop the state's waits, loops and input, a recovery state, loop limits, a start-point check before each loop (`screen.similar`), and watchdogs (too many timeouts in a row, or too few clean loops out of the last 10). The app shows the current state in the run label, and timeouts and recoveries in the log and stats.
- **`screen.similar(region)`:** how much a region still looks like its reference, for start points and "is the menu open" checks.
- **Game actions:** `character.reset()` (Esc, R, Enter on Roblox) and `game.rejoin()` (the `roblox://` link for `game.placeId`, at most once a minute), each behind its permission. Roblox-specific code is in `roblox.rs`.
- **Simulator:** a looping game (prompt, cast, round) with injectable failures (stuck casts, a disconnect), simulated reset and rejoin, and per-macro simulator setup in `wick.json`. The live view, runs, tests and agent tools use the macro's setup.
- **Example:** `examples/fishing-loop`, a state machine that recovers from both failures.
- The human profile now keeps each key's hold in multi-key sequences.

**Verification:** sim tests run a state-machine macro for 40 seconds with a stuck cast and a disconnect: it plays at least 8 rounds, resets once, rejoins once and recovers at least twice; with a loop limit it stops after exactly 3 loops; without the reset permission it stops with a clear error. Simulator tests cover rounds, stuck casts and disconnects; Roblox tests check the reset key order and that rejoin needs a place ID. A Node test runs the fishing example through the command layer with human input and checks the same recoveries.

### Pass 6: Demonstrations (in progress)

- **Longer recordings:** up to 10 minutes. Keyframes are smaller and spaced out for long recordings, and the contact sheet is built from the saved PNGs instead of thumbnails kept in memory.
- **Your mouse:** `record --you` now logs mouse motion (summed per sample as `"mouse"` lines, with raw deltas so camera turns show up even while the game locks the cursor) and modifier keys on their own (shift, control, alt, command) on macOS. Windows logs motion from the low-level mouse hook.
- **Storyboards:** every recording gets `storyboard.md`, `storyboard.json` and `storyboard.png`: the recording split into steps at pauses, waits and scene changes, each with a label ("hold w 2.0 s, then mouse right 200, then press e"), its actions with times, and its start and end frames. `wick storyboard` and `wick_storyboard` rebuild and return it.

Still to do in this pass: a simulated world to test demonstrations end to end, routes (replaying a stretch of a recording through the human profile), template matching, and OCR.

**Verification so far:** storyboard tests split a synthetic demonstration (walk with a camera turn, press E, wait for a scene change, ten clicks, walk) into exactly the expected five steps and labels, and an idle recording into one wait; a PNG round-trip test; a Node test records the sim with the macro running and reads its storyboard back through the command layer. The Windows motion hook type-checks with `cargo clippy --target x86_64-pc-windows-msvc`. The example-macro Node test now pins its human-profile seeds, which made it flaky before.

## Still to test by hand

Kept for the end-to-end test once the app is finished:

- macOS: capture and input on the test bench and in Roblox; F8 from another app; the permission prompts on a fresh install.
- The live view editor on a real window: drag, resize, draw and color picking.
- Agent tools on a real window: `observe`, `detect`, `probe` and `act` on the test bench; Claude Code building a macro from a new folder.
- Human input: watch the mouse paths and click timing on the test bench at a few precision values; the example should still keep up at 0.85.
- `wick record --you` on the test bench: your clicks and keys show up in `record.jsonl` with the right positions, Wick's own clicks are marked `wick`, and nothing is logged while another window has focus.
- `wick record --you --seconds 120` in a Roblox game: mouse turns while right-dragging or in shift lock show up as `"mouse"` lines, shift on its own is heard, and `storyboard.md` splits a walk–interact–wait loop into sensible steps.
- The trace graph and the Runs card during and after a live run on the test bench.
- `character.reset()` in a Roblox game that allows macros: the menu opens, R and Enter land, and the macro carries on once you respawn.
- `game.rejoin()` after a real disconnect: whether the `roblox://` link rejoins in the open client on macOS and Windows.
- Everything on Windows.

## Build plan

Left over from earlier passes, to fold into the passes below: a `dist:dir` packaged build, `template` and `similar` detectors and a PNG fixture set, measured (rather than fixed) input latency on real windows, and a per-frame detector benchmark.

### Pass 7: Sharing

- `wick pack` and Export: `.wick` files with a content hash.
- Install from a file, a `wick://install` link, or a GitHub repo or Gist URL.
- Install screen with README, target, game, permissions and source; updates that keep settings and ask again for new permissions.
- Calibration: overlay on first run, drag to fix regions, click to fix colors, saved per user.

**Checks:** tests for pack and install round trips, tampered-package rejection, and settings kept across updates. Manual: export a macro, install it on another account or machine, and calibrate it.

### Pass 8: Polish and release (planned passes 11 and 12)

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
- Fully automatic teach-by-demo: write the whole macro from a recording with no agent in the loop.

## Out of scope

- Reading, writing or injecting into the Roblox process, for any purpose. Wick works only from the screen and OS input.
