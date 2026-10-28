# Wick

**Wick watches your Roblox game and plays it for you: macros that see the screen, react in real time and loop on their own, written by you or by an AI agent.**

Wick is a macOS/Windows app for games that allow macros. A Wick macro looks at the Roblox window, decides what to do, and sends ordinary mouse and keyboard input, up to 120 times a second. That means it can handle things a recorded click sequence can't, like a timing minigame where a target zone jumps around and you have to keep a tick mark inside it.

Macros are small TypeScript programs packaged as folders. They are easy to share: export one as a single `.wick` file, send it to a friend or post it, and they install it by dragging it onto Wick. Shared macros run in a sandbox, show what they need before you install them, and adapt to the other person's screen size with a one-time calibration.

AI agents can write macros too. Wick gives an agent (Claude Code, or any agent that can run a command or use MCP) tools to look at the game, record clips, run small experiments ("click five times and track the white marker"), and read back the numbers. The agent works out how the game behaves, writes the macro, tests it, and iterates. The agent writes the macro; it doesn't play the game itself, so the macro runs at full speed without a model in the loop.

> **Status:** in development. The engine, macro runtime, simulator, test bench, the app with its library and region editor, the agent tools (CLI and MCP), recordings, trace graphs, run history and human-like input work. Looping and recovery, sharing and packaged builds are next. See the [roadmap](docs/ROADMAP.md).

## Run from source

Install [Node.js](https://nodejs.org) 22.13 or newer and [Rust](https://rustup.rs). Then:

```sh
npm install
npm start
```

`npm start` builds the engine (in release mode, the first time takes a minute) and opens Wick. Pick the **Bar minigame** example, then:

- **Simulator:** press **Run**. Nothing on your screen is touched. **Test on simulator** runs it over five games as fast as possible.
- **Test bench:** press **Open test bench**, pick **Test bench**, press **Run**, then click the test bench window so it has focus. Wick clicks inside it to keep the tick in the zone. Press **F8** to stop.
- **Roblox:** adjust the example's region and colors to your game first.

On macOS, Wick asks for **Screen Recording** (to see the window) and **Accessibility** (to click and to catch F8 from any app). The simulator works without either. When running from source, macOS lists these under "Electron".

To have Claude Code build a macro: in Wick, press **New macro**, then **Show folder**, start Claude Code in that folder and describe the macro. The folder includes the instructions and MCP setup it needs; see [Building with AI agents](docs/AI-AGENTS.md). `npm link` puts the `wick` command on your PATH.

Other commands: `npm test` (engine and app tests on the simulator), `npm run test:engine` (Rust unit tests), `npm run check` (formatting, lints and syntax), `npm run smoke:app` (opens the app hidden and checks that it loads and draws).

## What Wick does and doesn't touch

Wick works only from the outside, the way a person does:

- **In:** it captures the Roblox window's pixels (ScreenCaptureKit on macOS, Windows Graphics Capture on Windows).
- **Out:** it sends OS-level mouse and keyboard input (CGEvent on macOS, SendInput on Windows), and only while Roblox is the focused window.

Wick is built for Roblox, but its engine isn't tied to it: each macro declares a target, the one window it may control. v1 ships the Roblox target plus a simulator and a test page for development. Other targets can be added later without changing macros.

Wick never opens, reads, writes or injects into the Roblox process. That is a hard rule of the project, not a missing feature: Roblox's anti-cheat flags any memory access regardless of intent, and doing it is against Roblox's Terms of Use. Only run macros in games that allow them; that is between you and the game.

## Features (planned)

- **Screen-aware macros:** named regions, color and template detectors, OCR, and trackers that report position and velocity.
- **Real-time control:** loops at up to 120 Hz with input-latency compensation.
- **Human-like input:** one profile applied to every macro: reaction-time spread, timing jitter, curved mouse paths with overshoot, occasional mistakes, slow drift over a session, plus a precision slider.
- **State machines and looping:** run a macro n times or forever, with per-state checks, timeouts and recovery (reset the character, walk back, verify the start point, try again).
- **Start-point check:** each macro saves a snapshot of how its starting point looks, and Wick confirms it before every loop.
- **Recording:** record clips with synchronized input logs, and turn them into numeric traces.
- **Sharing:** single-file `.wick` packages, install from a file, link or GitHub repo, permission prompts, per-user calibration, and updates that keep your settings.
- **Agent tools:** a `wick` CLI and MCP server for observing, probing, running and reading telemetry.
- **Safety:** a global kill-switch hotkey, input only to the focused Roblox window, and a full log of what every run saw and did.

## Docs

- [Architecture](docs/ARCHITECTURE.md): how the app, the engine and the macro sandbox fit together.
- [Macro format and sharing](docs/FORMAT.md): what a macro folder contains, `.wick` packages, permissions, calibration.
- [Macro API](docs/API.md): everything a macro can do through `ctx`.
- [Building with AI agents](docs/AI-AGENTS.md): the tools Wick gives agents and how an agent should approach a new game.
- [Design](docs/DESIGN.md): the visual style, shared with Fuse plus Wick's ember accent and live views.
- [Roadmap](docs/ROADMAP.md)

## License

[MIT](LICENSE)
