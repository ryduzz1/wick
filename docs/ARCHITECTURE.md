# Architecture

> Proposed design. Nothing here is built yet; open decisions are marked.

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
| `roblox` | v1 | The Roblox player window | `character.reset`, `game.rejoin`, place ID, Roblox UI anchors |
| `sim` | v1, dev and tests | Synthetic frames rendered inside the engine; no real window or input | Scenario controls (speeds, sizes, seed) |
| `testbench` | v1, dev | Wick's bar-minigame page in a browser window | none |
| `window` | later | Any window the user picks | none |

Each macro declares one target in `wick.json`. The engine sends input only to that target's window, only while it is focused. Shared macros can't reach anything else, which is what keeps the sandbox meaningful.

The `sim` target makes the whole pipeline testable without a screen: it renders minigame frames from a deterministic simulation, feeds them through the same detectors and macro runtime, and applies the macro's clicks to the simulation. CI and agents both use it.

### Finding windows without touching the process

- **macOS:** `CGWindowListCopyWindowInfo` returns each window's owner name, PID and bounds without opening anything.
- **Windows:** `EnumWindows` plus the window class and title, and `CreateToolhelp32Snapshot` to map a PID to an executable name. Neither opens a handle to the Roblox process, so no `OpenProcess`, not even with limited query rights.

## Engine

- **Capture:** ScreenCaptureKit (macOS) and Windows Graphics Capture (Windows), limited to the target window. Window-only capture never includes Wick's own windows on top of it. Frames stay in GPU or shared memory and are only copied out for the regions a macro uses. The engine is per-monitor DPI aware on Windows and reads the backing scale on macOS, so regions line up on Retina and scaled displays. On Windows 11 the capture border is turned off.
- **Vision primitives** run natively so macro code never loops over raw pixels:
  - `color`: an HSV/RGB tolerance mask over a region, returning blobs, extents and centroids.
  - `template`: normalized cross-correlation against an image from the macro's `templates/`.
  - `ocr`: text from a region (platform OCR: Vision on macOS, Windows.Media.Ocr on Windows).
  - `track`: follows a detector result across frames and reports position, velocity, and when it was last seen.
  - `similar`: compares the screen to a reference image (used for the start-point check).
- **Macro runtime:** embedded QuickJS (via `rquickjs`). Macros are TypeScript, transpiled by the app when installed or saved. The runtime exposes only the Wick API; see [FORMAT.md](FORMAT.md#permissions-and-the-sandbox).
- **Input:** CGEvent (macOS) and SendInput (Windows). Input is dropped unless the target window is focused. Camera turns use relative mouse movement (CGEvent delta fields; SendInput without `MOUSEEVENTF_ABSOLUTE`), since Roblox reads deltas when the mouse is locked. Every output first passes through the human profile.
- **Human profile:** reaction delay spread, timing jitter, hold-time spread, curved mouse paths with overshoot (slower near the target, as human aiming is), occasional mistakes, and slow drift over a session. A precision value from 0 to 1 scales all of it so a tight minigame can still pass.
- **Safety:** a global kill-switch hotkey, registered by the engine itself (Carbon `RegisterEventHotKey` on macOS, which needs no extra permission; `RegisterHotKey` on Windows) so it works even if the app's UI hangs; a focus guard; and a run log of every detector result and input with timestamps.

## App

- Macro library: install, update, export, calibrate, settings per macro.
- Editor and live overlay: draw regions on a captured frame, preview detector masks, watch trackers live.
- Recordings: video clips plus synchronized input logs, and traces extracted from them.
- Agent surface: the `wick` CLI and an MCP server, both calling the same command layer (see [AI-AGENTS.md](AI-AGENTS.md)).
- Telemetry: success rate, loop count, state timings and errors per run.

## Platform permissions

- **macOS:** Screen Recording (capture) and Accessibility (input). Wick explains both and checks them at launch. macOS grants these to the app that launched the engine, so the engine is always started by the Wick app, never directly from a terminal. The `wick` CLI talks to the running app for the same reason.
- **Windows:** none needed. Roblox may ignore a synthetic click that isn't preceded by mouse movement, so the input layer will send a 1 px move before clicks if testing confirms that.

## Decisions

- **Macro runtime:** QuickJS embedded in the engine (`rquickjs`), so the per-tick loop never crosses a process boundary. Macro files are loaded from memory by the engine's own module loader; relative imports work only inside the macro folder.
- **TypeScript:** the app strips types with Node's built-in `stripTypeScriptTypes` (no bundler dependency). Macros use erasable TypeScript only: no `enum` or `namespace`.
- **App ↔ engine:** newline-delimited JSON-RPC 2.0 over the engine's stdin/stdout. Telemetry events are throttled to about 30 per second. Frames for the live view go through a shared-memory ring buffer; one-off frames for agents are written as PNG files and returned by path.
- **CLI and MCP ↔ app:** a local socket (Unix socket on macOS, named pipe on Windows) with a token from the app's data directory, the same pattern as Fuse's loopback bridge.
- **Vision:** CPU first, on region crops only. A GPU path is only worth it if profiling shows a need.
- **App code:** plain JavaScript ES modules and CSS with no runtime npm dependencies, tested with `node --test`, as in Fuse. The engine is a Rust workspace in `engine/`.
