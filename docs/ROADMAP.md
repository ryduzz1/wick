# Roadmap

## Done

- Project setup: README, working agreement, and design docs for the architecture, the macro format and sharing, and agent tools. No code yet.
- Visual design spec (`docs/DESIGN.md`): Fuse's base style, the ember accent, run states, live view, trace graphs, mini window and logo. Not implemented yet.

## Next, in order

1. **Test bench.** A standalone copy of the bar minigame (adjustable drift speed, click push, zone size and jump interval) to develop against without the real game. Possibly also a Roblox place built with Fuse.
2. **Engine spike.** Capture one window at 60+ fps, run a color tracker on a region, send clicks, and measure frame-to-click latency on macOS and Windows.
3. **Macro runtime.** Embedded QuickJS with the first API (`screen.track`, `input.click`, `loop.hz`), and a hand-written bar-minigame macro that keeps the tick in the zone on the test bench.
4. **App shell.** Electron app with the library, a live region and detector overlay, the kill switch and macOS permission onboarding.
5. **Agent tools.** `wick` CLI and MCP server: `observe`, `record`, `act`, `probe`, `detect preview`, `run`, `stop`, `telemetry`. Goal: an agent writes the bar-minigame macro from scratch on the test bench.
6. **Sharing.** `.wick` export and install, the install screen with permissions and source, calibration, updates from URLs and repos.
7. **Human profile.** Reaction and timing spread, mouse paths, precision slider.
8. **State machines and looping.** States with checks, timeouts and recovery; the start-point check; character reset; rejoin after disconnect.

## Later

- Public library index.
- Block or graph editor on top of the same API.
- Teach-by-demo: infer a macro's rules from a recording of you playing.

## Out of scope

- Reading, writing or injecting into the Roblox process, for any purpose. Wick works only from the screen and OS input.
