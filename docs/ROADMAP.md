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

### Pass 6: Demonstrations, templates and text

- **Longer recordings:** up to 10 minutes. Keyframes are smaller and spaced out for long recordings, and the contact sheet is built from the saved PNGs instead of thumbnails kept in memory.
- **Your mouse:** `record --you` now logs mouse motion (summed per sample as `"mouse"` lines, with raw deltas so camera turns show up even while the game locks the cursor) and modifier keys on their own (shift, control, alt, command) on macOS. Windows logs motion from the low-level mouse hook.
- **Storyboards:** every recording gets `storyboard.md`, `storyboard.json` and `storyboard.png`: the recording split into steps at pauses, waits and scene changes, each with a label ("hold w 2.0 s, then mouse right 200, then press e"), its actions with times, and its start and end frames. `wick storyboard` and `wick_storyboard` rebuild and return it.

- **Simulated world** (`sim_world.rs`): with `"world": {}` the bar sits in a top-down world with walking along a heading that mouse turns rotate, a dock that starts rounds, a bag that fills with won rounds, and a vendor with a sell menu. A reset goes back to the spawn.
- **Scripted demonstrations:** the simulator's `demo` field plays a person's input into the game and reports it as heard, so `record --you` works headlessly. `--scenario FILE` on the CLI swaps in a simulator setup.
- **Routes:** `ctx.input.play(route, { until, settle, speed })` replays timed holds, presses, clicks and turns through the permissions and human profile, stopping and letting go of held keys when `until` is true. `wick route` and `wick_route` cut storyboard steps or a time range out of a recording and save them as `routes/NAME.js`.
- States that time out now let go of the keys and buttons they were holding.
- **Example:** `examples/fishing-trip`: spawn to dock, fish until the bag is full, walk to the vendor, sell, reset, repeat, with routes made from its `demo.json`.

- **Template matching:** `screen.find(region, { template })` finds a saved image by normalized cross-correlation on grayscale (coarse to fine), scaled with the window height. Templates live in `templates/` with their saved height in `templates.json`; `wick template save`, `wick templates` and `wick detect --template` (and the MCP tools) make and check them.
- **Text:** `screen.read(region)` reads text with Vision on macOS and Windows.Media.Ocr on Windows, on a worker thread a couple of times a second, with `.text`, `.lines`, `.number` and `.has()`. `wick read` and `wick_read` read once.

**Verification:** storyboard tests split a synthetic demonstration (walk with a camera turn, press E, wait for a scene change, ten clicks, walk) into exactly the expected five steps and labels, and an idle recording into one wait; a PNG round-trip test. World tests cover walking along a turned heading, filling the bag, a full bag not casting, the sell menu blocking movement and selling, reset to spawn, and the prompt. Session tests: a route stops where `until` fires, within reach of the dock; holds and a quarter turn replay to the expected position and heading; a timed-out state stops walking at the timeout; a scripted demonstration records into exactly the expected seven storyboard steps. A Node test runs the whole path through the command layer: record the fishing trip's demo, cut two routes from the storyboard, and run the macro on them with human input until it sells a bag without a timeout. (Run by hand, the example made two full trips in 70 s.) Template tests find an icon at its exact spot, at twice the size in a bigger window, with the brightness changed, and score it low when it's absent or outside the region; a session test cuts the sim's sell button out of a frame, and a macro finds it in the open menu and clicks it to sell. A Node test saves a template from the sim world, matches it with `detect` and loads it with the macro. An OCR test reads "Bag 3/5" and "Coins: 120" from a PNG fixture with Vision (and on Windows CI when a recognition language is installed). The Windows motion hook and OCR type-check with `cargo clippy --target x86_64-pc-windows-msvc`. The example-macro Node test now pins its human-profile seeds, which made it flaky before.

### Pass 7: Sharing

- **Packages:** `.wick` files are deterministic zips with a content hash in the comment; `wick pack`, `wick_pack` and the macro's Export button make them. Installs refuse unsafe paths, more than 400 files or 20 MB, bad CRCs, broken manifests, and packages whose contents no longer match their hash.
- **Sources:** a `.wick` file, a `wick://install?url=` link, an `https` link to a `.wick`, a GitHub repo (branch and subfolder too, with a picker when it holds several macros) or a Gist.
- **Install screen:** name, version, author, target, an intact/changed badge, update and new-permission notices, problems in soft red, permissions in plain words, the README and every file's source as text. Nothing is written until Install.
- **In the app:** Install macro in the sidebar and File menu (⇧⌘I), drag and drop of `.wick` files and links, double-clicked `.wick` files and `wick://` links forwarded to the running Wick (single instance; held until the window is ready). Only the packaged app registers `wick://`, so development runs don't change system settings.
- **Updates:** Check for updates on macros installed from a link; updates install in place, keep `.wick/`, settings and calibration, and flag added permissions.
- **Calibration:** installed macros keep region moves as per-user calibration (they can't add, rename or delete the author's regions), and a Calibration card lists the colors in the macro's code with a picker to map each to what the user's game shows. Runs and simulator tests use the calibrated regions and colors. `wick calibration` and `wick_calibration` for agents.
- Not done: an automatic first-run calibration walkthrough (the regions show on the live view, but Wick doesn't yet step through each detector on first run), and the public library index (moved to Later).

**Verification:** 7 package tests (deterministic packing, tamper detection, unsafe paths and broken manifests, install then in-place update keeping local data and noting a new permission, link parsing, repos with several macros, package and Gist downloads with a fake fetch); Node tests through the command layer for pack/install/update and color calibration; the app smoke test exports the fishing trip, opens it on the install screen through the same path a double-clicked file takes, checks the badges, permissions and files, installs it, checks the library and Calibration card, and calibrates a color with the picker. Screenshots of the install screen and Calibration card checked by eye.

### Pass 8: Polish and packaged builds

- **Packaged builds:** electron-builder config in `package.json`; `npm run dist:dir` and `npm run dist` (via `scripts/dist.mjs`, which builds the engine and signs only when credentials are set). The app bundles the engine, the examples and a `wick` CLI script (`Resources/bin/wick`, `wick.cmd`), declares `wick://` and the `.wick` document type, and the engine path falls back to `process.resourcesPath` so the CLI and MCP server work from the packaged app without Node.
- **Release workflow:** `.github/workflows/release.yml` builds, tests and smoke-tests the packaged app on macOS and Windows; by hand it uploads unsigned artifacts, on a `v*` tag it uploads to a draft release, and it signs and notarizes when the secrets in [RELEASING.md](RELEASING.md) exist.
- **Mini window:** an always-on-top panel over the game during runs on Roblox or the test bench: name, state dot and label (time, loops, current state), Stop, `F8 to stop`. It's a non-activating panel that never takes focus, excluded from capture with content protection, remembers its position, shows how a run ended, and can be turned off in Settings.
- **Shortcuts:** a Macro menu (Run ⌘R, Stop ⌘., Test on simulator ⌘T, Export ⌘E, Check for updates, Show folder, Edit code) and a Help menu (Get started, Check for Wick updates, GitHub). All listed in DESIGN.md.
- **Onboarding:** a first-run Get started card (permissions, try an example on the simulator, run on Roblox, make your own with an agent) that ticks steps off as they happen; reopen it from Help.
- **Settings:** mini window on or off, the `wick` command with how to put it on PATH, and Check for Wick updates.
- **Wick updates:** packaged builds check the latest GitHub release once per launch and show a sidebar notice linking to it.
- **No bundled examples:** the app starts with an empty library (an empty state offers New macro and Install macro), and packaged builds don't include `examples/`. The examples stay in the repo for tests and docs and can still be opened as folders. The read-only example handling (Make a copy, the Examples group) is gone.
- Not done, and needing the maintainer: signing and notarizing (an Apple Developer ID and a Windows certificate) and silent auto-update, which on macOS requires a signed build. Not done: a universal (arm64 + x64) macOS build; `start.png` snapshots for start points.

**Verification:** `npm run dist:dir` builds an unsigned `Wick.app` in about 7 s; `npm run smoke:dist` runs the full app smoke test against it (bundled engine, examples, asar paths, install and calibration) and the bundled `wick` command. The smoke test now starts from an empty sidebar with no examples, and also checks the mini window shows the running macro with "F8 to stop", and that the Get started card appears on a fresh profile. Screenshots of the mini window and Get started card checked by eye. The first Release workflow run (by hand, unsigned) passed on macOS and Windows: tests, the installers (dmg/zip, NSIS/zip), and the packaged smoke test, which is the first time the whole app, install screen and mini window ran on Windows.

### Fixes from first use on a real game

- On macOS, Wick can only see windows on the current screen, so a fullscreen Roblox in another Space disappears when you switch away. Agent tools used to hand back the last frame with a zero-size viewport (so every region collapsed); `observe`, `detect` and `read` now refuse and say to switch to the game, or keep it windowed.
- Roblox on macOS keeps a small window of its own (the menu button) in front of the game window, so Wick never saw the game as focused: a `record --you` heard none of the player's input, and a macro's input would have been dropped. Focus is now compared by process (the app with keyboard focus) on macOS and Windows.
- Pressing Run left Wick in front, so a macro's first click (Fish, in the first real macro) was dropped and the macro waited forever for what that click should have started. A run now waits for the game to have focus before its first step (its clock starts then, and it logs that it's waiting), and Run brings the game's window to the front (`open -a` on its app on macOS, `SetForegroundWindow` on Windows). Tested on the simulator with a game that gets focus late; bringing Roblox to the front is untested by hand.
- A Sol's RNG fishing minigame draws its target zone in a different color every round, which one `color` can't follow. `screen.track` (and `wick detect`, `wick probe` and the MCP tools) now take `except: [colors]`, which follows anything that isn't one of those colors: list the bar's background and fill and what's left is the zone. Tested in the engine (unit test, and the simulator's bar game played with the zone found this way) and against a recorded real minigame (offline replay of the detection; not yet run live).

## Still to test by hand

Kept for the end-to-end test once the app is finished:

- macOS: capture and input on the test bench and in Roblox; F8 from another app; the permission prompts on a fresh install.
- The live view editor on a real window: drag, resize, draw and color picking.
- Agent tools on a real window: `observe`, `detect`, `probe` and `act` on the test bench; Claude Code building a macro from a new folder.
- Human input: watch the mouse paths and click timing on the test bench at a few precision values; the example should still keep up at 0.85.
- `wick record --you` on the test bench: your clicks and keys show up in `record.jsonl` with the right positions, Wick's own clicks are marked `wick`, and nothing is logged while another window has focus.
- `screen.read` and `wick read` on real game text (counters, item names) on macOS and Windows, and `screen.find` on a real button at a couple of window sizes.
- Teach a loop for real: record one trip in a Roblox game with `--you`, cut routes with `wick route`, and check that `ctx.input.play` walks the same way with the human profile on (camera turns included).
- `wick record --you --seconds 120` in a Roblox game: mouse turns while right-dragging or in shift lock show up as `"mouse"` lines, shift on its own is heard, and `storyboard.md` splits a walk–interact–wait loop into sensible steps.
- The trace graph and the Runs card during and after a live run on the test bench.
- `character.reset()` in a Roblox game that allows macros: the menu opens, R and Enter land, and the macro carries on once you respawn.
- `game.rejoin()` after a real disconnect: whether the `roblox://` link rejoins in the open client on macOS and Windows.
- Sharing: export a macro, send it to another account or machine, and install it by double-clicking the `.wick`, by dropping it on Wick, and from a GitHub repo link; then update it from a newer push and check settings and calibration survive. (`wick://` links and double-click need the packaged build from Pass 8.)
- Calibration on a real window: drag an installed macro's region to fit, pick a shifted color in the Calibration card, run it, and Reset.
- The mini window over Roblox (windowed and fullscreen): it stays on top, clicking Stop doesn't break the game's focus for the next run, it doesn't show up in Wick's live view, and its position is remembered.
- The packaged app: install the dmg (right-click → Open while unsigned) and the Windows installer, grant permissions to "Wick", double-click a `.wick`, open a `wick://install?url=` link, and run `Resources/bin/wick` / `wick.cmd` from a terminal.
- The Sol's RNG fishing macro (in the maintainer's library, not the repo) at a fishing spot: casts, reels, closes the "Fish Caught!" popup, and stops after three missed Fish buttons. Selling and walking back are next, once there's a way to tell the bag is full.
- Run brings Roblox to the front on macOS and Windows, and the run starts only once it has focus.
- Everything on Windows.

## Build plan

Left over from earlier passes: measured (rather than fixed) input latency on real windows, and a per-frame detector benchmark.

### Release (needs the maintainer)

- A Developer ID certificate and notarization for macOS, and a Windows code-signing certificate (see [RELEASING.md](RELEASING.md)); then silent auto-update with electron-updater.
- A universal macOS build (arm64 and x64 engines).

**Checks:** a release build installs and runs on clean macOS and Windows machines.

## Later

- `window` target: control any window the user picks.
- Public library index.
- Block or graph editor on top of the same API.
- Fully automatic teach-by-demo: write the whole macro from a recording with no agent in the loop.

## Out of scope

- Reading, writing or injecting into the Roblox process, for any purpose. Wick works only from the screen and OS input.
