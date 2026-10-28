# Architecture

> Pass 1 built the engine, the platform layer, the macro runtime, the simulator, the test bench and a first app window. Parts not built yet are marked *(planned)*. See the [roadmap](ROADMAP.md).

```
 AI agent (CLI / MCP)          You (UI)
          \                     /
           v                   v
   ┌───────────────────────────────────┐
   │  Wick app (Electron)               │  library, editor, recordings,
   │  - macro library + installer       │  calibration, telemetry,
   │  - wick CLI + MCP server           │  agent tools
   └─────────────────┬─────────────────┘
                     │ local IPC (commands, telemetry, frames on request)
   ┌─────────────────v─────────────────┐
   │  Wick engine (Rust)                │  hot loop, 60-120 Hz
   │  - window capture                  │
   │  - vision: regions, detectors,     │
   │    trackers, OCR                   │
   │  - macro runtime (sandboxed JS)    │
   │  - input + human profile           │
   │  - kill switch, focus guard        │
   └─────────────────┬─────────────────┘
          pixels in  │  OS input out
                     v
              Roblox window
        (never opened, read or injected)
```

## Why two processes

The app is the part people and agents talk to. It doesn't need to be fast, so it uses the same Electron stack as Fuse.

The engine runs the real-time loop: capture a frame, run the detectors the macro asked for, step the macro, send input. Keeping all of that in one native process, with the macro running inside it, means there's no IPC round trip on every tick. For the bar minigame, the delay between a frame arriving and the click going out is what decides whether the macro keeps up.

## Targets

Wick's product is Roblox-first, but the engine knows nothing about Roblox. Everything Roblox-specific lives in a **target**: an adapter that says which window a macro controls and what extra abilities it has.

```
Target
  find()        -> the window to capture and send input to, or none
  isFocused()   -> whether input is allowed right now
  viewport()    -> the game area inside the window, for region anchoring
  extras        -> optional abilities, each behind a manifest permission
```

| Target | Status | Window | Extras |
| --- | --- | --- | --- |
| `roblox` | v1 | The Roblox player window | *(planned)* `character.reset`, `game.rejoin`, place ID |
| `sim` | v1, dev and tests | Synthetic frames rendered inside the engine; no real window or input | Scenario controls (speeds, sizes, seed) |
| `testbench` | v1, dev | Wick's bar-minigame page, in a window the app opens | none |
| `window` | later | Any window the user picks | none |

Each macro declares one target in `wick.json`. The engine sends input only to that target's window, only while it is focused. Shared macros can't reach anything else, which is what keeps the sandbox meaningful.

The `sim` target makes the whole pipeline testable without a screen: it renders minigame frames from a deterministic simulation, feeds them through the same detectors and macro runtime, and applies the macro's clicks to the simulation. CI and agents both use it.

### Finding windows without touching the process

- **macOS:** `CGWindowListCopyWindowInfo` returns each window's owner name, PID and bounds without opening anything.
- **Windows:** `EnumWindows` plus the window title, and `CreateToolhelp32Snapshot` to map a PID to an executable name. Neither opens a handle to the Roblox process, so no `OpenProcess`, not even with limited query rights.

### The game area

Regions are anchored to the window's content area, not its frame:

- **macOS:** capture covers the whole window, including the title bar. The engine asks AppKit how tall a standard title bar is on this macOS version and subtracts it, unless the window fills a display (full screen). This matches Roblox in windowed and full-screen mode and the test bench window.
- **Windows:** the real client area from `GetClientRect` and `ClientToScreen`, relative to the captured frame bounds from `DWMWA_EXTENDED_FRAME_BOUNDS`.

## Engine

- **Capture:** ScreenCaptureKit (macOS) and Windows Graphics Capture (Windows), limited to the target window, at up to 120 fps. Window-only capture never includes Wick's own windows on top of it. macOS frames are delivered at the window's size in points (not Retina pixels), which halves the work with no loss for detection. Windows is per-monitor DPI aware, so capture and input both use physical pixels. On Windows 11 the capture border is turned off. Each frame is currently copied whole into the engine; copying only the regions in use is a later optimization.
- **Vision primitives** run natively so macro code never loops over raw pixels:
  - `color`: pixels within a per-channel RGB tolerance inside a region, reporting the extent and centroid of all matches together.
  - `track`: follows a detector result across frames and reports position, velocity (a least-squares fit over the last 60 ms), and how long it has been missing.
  - *(planned)* `template`: normalized cross-correlation against an image from the macro's `templates/`.
  - *(planned)* `ocr`: text from a region (Vision on macOS, Windows.Media.Ocr on Windows).
  - *(planned)* `similar`: compares the screen to a reference image (used for the start-point check).
- **Macro runtime:** embedded QuickJS (via `rquickjs`), one runtime per run with a 64 MB memory limit and a 250 ms limit per step. The API itself is a small JavaScript prelude (`prelude.js`) that queues commands; the engine drains them after each step. The runtime exposes only the Wick API; see [API.md](API.md) and [FORMAT.md](FORMAT.md#permissions-and-the-sandbox).
- **Input:** CGEvent (macOS) and SendInput (Windows). Input is dropped unless the target window is focused. Camera turns use relative mouse movement (CGEvent delta fields; SendInput without `MOUSEEVENTF_ABSOLUTE`), since Roblox reads deltas when the mouse is locked. *(Planned:)* every output will first pass through the human profile. Every output a macro sends first passes through the human profile. Anything still held when a run ends is released.
- **Human profile** (`human.rs`): reaction delay with a skewed spread, hold-time spread, curved mouse paths that ease out near the target and sometimes overshoot and correct, camera turns split into eased steps, occasional slips, and slow drift over a session. A precision value from 0 to 1 scales all of it so a tight minigame can still pass; inputs never swap order. It's on by default at 0.85 (Settings, ⌘,). Agent probes and single inputs are always exact, and `run`/`simulate` take `--exact`.
- **Recorder** (`record.rs`): samples the target (or one region) at up to 30 fps, scores how much each sample changed, saves keyframes when something changed or every second, and logs every input in `record.jsonl`: Wick's own (tagged on macOS with an event field, flagged as injected on Windows) and, when asked, the person's clicks and keys while the target has focus, from a pass-through event tap on macOS or low-level hooks on Windows that are removed when the recording ends. It ends with a contact sheet of the moments that changed most.
- **Traces:** a live run streams each frame's tracker positions and the macro's inputs (`macro.trace`, batched every 50 ms); the app draws them and keeps the last 15 seconds with each saved run.
- **Safety:** a global F8 kill switch, registered by the engine itself so it works even if the app's UI hangs: a keyboard event tap on macOS (needs Accessibility, which input needs anyway) and `RegisterHotKey` on Windows. If the engine can't register it, the app registers F8 as an Electron global shortcut instead. Plus a focus guard, and a saved history of each live run: how it ended, its stats, its log, and the trace of its last 15 seconds.

## App

Built: the macro library (your library folder, folders you open and the bundled examples), a target picker, the live view with region and tracker overlays and an editor for regions and colors, run controls and states, stat tiles, a live trace graph, run history, a settings form generated from the manifest, the run log, a simulator test, app settings (human input and the library folder), macOS permission onboarding and the kill-switch chip. The agent surface, the `wick` CLI and an MCP server, calls the same command layer (see [AI-AGENTS.md](AI-AGENTS.md)).

*(Planned)*:

- Install, update, export and calibrate shared macros.
- Telemetry: success rate, loop count and state timings per run.

## Platform permissions

- **macOS:** Screen Recording (capture) and Accessibility (input). Wick explains both and checks them at launch. macOS grants these to the app that launched the engine, so the engine is always started by the Wick app, never directly from a terminal. The `wick` CLI talks to the running app for the same reason.
- **Windows:** none needed. Roblox may ignore a synthetic click that isn't preceded by mouse movement, so the input layer will send a 1 px move before clicks if testing confirms that.

## Decisions

- **Macro runtime:** QuickJS embedded in the engine (`rquickjs`), so the per-tick loop never crosses a process boundary. Macro files are loaded from memory by the engine's own module loader; relative imports work only inside the macro folder.
- **TypeScript:** the app strips types with Node's built-in `stripTypeScriptTypes` (no bundler dependency). Macros use erasable TypeScript only: no `enum` or `namespace`.
- **App ↔ engine:** newline-delimited JSON-RPC 2.0 over the engine's stdin/stdout. Stats arrive 4 times a second. Live-view frames are sent as base64 RGBA, scaled to at most 480 px wide, 8 times a second, with the overlay data alongside. That's simple and fast enough for now; a shared-memory ring buffer can replace it if it isn't. Snapshots for agents are written as PNG files and returned by path (`session.snapshot`).
- **CLI and MCP ↔ app:** a local socket (Unix socket on macOS, named pipe on Windows) with a token from the app's data directory, the same pattern as Fuse's loopback bridge.
- **Vision:** CPU first, on region crops only. A GPU path is only worth it if profiling shows a need.
- **App code:** plain JavaScript ES modules and CSS with no runtime npm dependencies, tested with `node --test`, as in Fuse. The engine is a Rust workspace in `engine/`.

## Code layout

```
engine/crates/wick-platform   OS layer: window list, capture, input, hotkey, permissions
  native/macos.m              ScreenCaptureKit, CGEvent and event tap, built by build.rs
  src/windows.rs              Graphics Capture, SendInput, RegisterHotKey, Toolhelp
engine/crates/wick-engine     targets, vision, trackers, simulator, runtime, sessions, JSON-RPC,
                              human profile, probes and recordings
app/                          Electron main process, engine client, macro loader, library,
                              run history, command layer, control socket, CLI, MCP server, UI
bin/wick.js                   the wick command
testbench/                    the bar minigame as a page, opened by the app
examples/                     example macros, bundled with the app
sdk/wick.d.ts                 types for macro authors
tests/                        end-to-end tests against the engine binary
```
