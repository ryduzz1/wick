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

## Engine

- **Capture:** ScreenCaptureKit (macOS) and Windows Graphics Capture (Windows), limited to the Roblox window. Frames stay in GPU or shared memory and are only copied out for the regions a macro uses.
- **Vision primitives** run natively so macro code never loops over raw pixels:
  - `color`: an HSV/RGB tolerance mask over a region, returning blobs, extents and centroids.
  - `template`: normalized cross-correlation against an image from the macro's `templates/`.
  - `ocr`: text from a region (platform OCR: Vision on macOS, Windows.Media.Ocr on Windows).
  - `track`: follows a detector result across frames and reports position, velocity, and when it was last seen.
  - `similar`: compares the screen to a reference image (used for the start-point check).
- **Macro runtime:** embedded QuickJS (via `rquickjs`). Macros are TypeScript, transpiled by the app when installed or saved. The runtime exposes only the Wick API; see [FORMAT.md](FORMAT.md#permissions-and-the-sandbox).
- **Input:** CGEvent (macOS) and SendInput (Windows). Input is dropped unless the Roblox window is focused. Every output first passes through the human profile.
- **Human profile:** reaction delay spread, timing jitter, hold-time spread, curved mouse paths with overshoot (slower near the target, as human aiming is), occasional mistakes, and slow drift over a session. A precision value from 0 to 1 scales all of it so a tight minigame can still pass.
- **Safety:** a global kill-switch hotkey, handled ahead of everything else; a focus guard; and a run log of every detector result and input with timestamps.

## App

- Macro library: install, update, export, calibrate, settings per macro.
- Editor and live overlay: draw regions on a captured frame, preview detector masks, watch trackers live.
- Recordings: video clips plus synchronized input logs, and traces extracted from them.
- Agent surface: the `wick` CLI and an MCP server, both calling the same command layer (see [AI-AGENTS.md](AI-AGENTS.md)).
- Telemetry: success rate, loop count, state timings and errors per run.

## Platform permissions

- **macOS:** Screen Recording (capture) and Accessibility (input). Wick explains both and checks them at launch.
- **Windows:** none needed. Roblox may ignore a synthetic click that isn't preceded by mouse movement, so the input layer will send a 1 px move before clicks if testing confirms that.

## Open decisions

- QuickJS embedded in the engine, or a sandboxed Electron utility process. Embedding is faster per tick; the utility process is easier to debug. Leaning toward embedding.
- Exact IPC: a local socket with a small binary protocol, or JSON-RPC over a pipe with shared memory for frames.
- Whether to ship a GPU path for detectors or stay on CPU with region crops (likely enough at 120 Hz for small regions).
