# Building with AI agents

> Proposed design. Not built yet: the agent tools are planned for pass 6 in the [roadmap](ROADMAP.md). The macro API they build on is in [API.md](API.md).

Agents author Wick macros; they don't play the game. A model takes seconds per step, which is too slow for a minigame that needs a decision every 10 ms. So the agent observes, experiments, writes a macro, tests it and iterates, and the finished macro runs at full speed on its own.

Wick exposes the same commands through a `wick` CLI and an MCP server. Each macro folder includes an `AGENTS.md` (and a `CLAUDE.md` that imports it) so an agent started there knows the tools and the rules.

## Tools

| Command | What it does |
| --- | --- |
| `wick observe` | Screenshot of the Roblox window or a region. |
| `wick record --seconds 5` | Clip with a synchronized input log. Returns sampled keyframes and the moments where the screen changed most. |
| `wick act click` / `key` / `move` / `hold` | Send a single input to test something. |
| `wick probe` | Run a small experiment and return numbers, e.g. "track the white marker in `bar` while clicking 5 times 300 ms apart". Returns the trace as JSON. |
| `wick detect preview` | Show what a detector picks up in a region (mask image plus blob list), so the agent can check its own perception. |
| `wick region set` | Create or adjust a region in the macro's `regions.json`. |
| `wick run` / `wick stop` | Run the macro in the current folder (with a time or loop limit) and stop it. |
| `wick telemetry` | Results of the last run: success rate, loops, state timings, errors, and the detector log around each failure. |
| `wick pack` | Build a `.wick` package for sharing. |

Every input an agent sends goes through the same focus guard and kill switch as a macro.

## How an agent should approach a new minigame

1. **Look.** `observe` and `record` while you play it once. Find the moving parts and draw regions around them.
2. **Detect.** Create detectors and check them with `detect preview` until they reliably find each part.
3. **Measure.** Use `probe` to measure the mechanics as numbers. For the bar minigame: the tick's drift speed with no input, how far one click pushes it, how often the zone jumps, and the input latency.
4. **Write.** Write the controller in `main.ts` from those measurements, not from guesses.
5. **Test.** `run` with a short limit, read `telemetry`, and fix what fails. Repeat until the success rate is where the user wants it.
6. **Wrap up.** Add a `start.png`, fill in the manifest's `settings` and `README.md`, and `pack` if the user wants to share it.

Agents work much better from traces ("tick x every frame") than from raw video, so Wick turns recordings into numbers wherever it can.
