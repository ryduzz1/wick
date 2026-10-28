# Building with AI agents

Agents author Wick macros; they don't play the game. A model takes seconds per step, which is too slow for a minigame that needs a decision every 10 ms. So the agent observes, experiments, writes a macro, tests it and iterates, and the finished macro runs at full speed on its own.

Wick gives agents the same tools two ways: a `wick` command line, and an MCP server (`wick mcp`). Both talk to the Wick app when it's open, so everything an agent does shows up in the app's window and log; without the app they start their own engine.

## Setup

Every macro Wick creates (or copies from an example) gets three files for agents:

- `AGENTS.md`: the tools, the rules and the workflow below, plus the exact command for the CLI on this machine.
- `CLAUDE.md`: imports `AGENTS.md` for Claude Code.
- `.mcp.json`: registers `wick mcp` for Claude Code and other clients that read it. Claude Code asks once before using it.

So the usual start is: create a macro in Wick (**New macro**), then start Claude Code in its folder (**Show folder**) and describe what the macro should do.

To use the CLI from anywhere while running from source, link it once: `npm link` in the Wick repo puts `wick` on your PATH. For an existing folder, `wick init` adds the agent files. To add the MCP server to Claude Code for every project instead: `claude mcp add wick -- node /path/to/wick/bin/wick.js mcp`.

## Tools

| CLI | MCP tool | What it does |
| --- | --- | --- |
| `wick status` | `wick_status` | Engine version, macOS permissions, and which targets are open and focused. |
| `wick observe [--region R]` | `wick_observe` | Saves a PNG of the target window or one region (in the macro's `.wick/` folder). The MCP tool returns the image itself. |
| `wick detect [--region R] [--color HEX] [--mask]` | `wick_detect` | The region's main colors, and where a color matches (pixel count, extent, centroid). `--mask` saves an image with matches painted ember. |
| `wick act click [--at R]`, `act press KEY`, … | `wick_act` | One input, to test something. |
| `wick probe --track NAME:REGION:HEX --clicks N --every MS` | `wick_probe` | Follows colors for a few seconds while sending timed input, and returns each tracker's position over time. |
| `wick record [--seconds S] [--region R] [--you] [--run]` | `wick_record` | Records a few seconds: keyframes, a change score per sample, every input, and a contact sheet of the moments that changed most (the MCP tool returns it as an image). `--you` also logs your own clicks and keys in the game window, so an agent can watch you do something once. `--run` runs the macro meanwhile. |
| `wick regions`, `wick region set NAME …`, `wick region remove NAME` | `wick_regions`, `wick_set_region`, `wick_remove_region` | Read and edit `regions.json`. The app's live view updates as they change. |
| `wick run [--seconds S] [--live] [--exact]` | `wick_run` | Runs the macro and waits for it to end. Returns how it ended, its stats and its log. On `sim` it runs instantly unless `--live`. Input goes through the app's human profile unless `--exact`. |
| `wick simulate [--seeds N]` | `wick_simulate` | Runs the macro on several simulated bar-minigame games. |
| `wick telemetry` | `wick_telemetry` | The last run's result again. |
| `wick runs`, `wick runs show FILE` | `wick_runs` | Saved live runs of the macro (kept by the app), and one in full: its log and the trace of its last 15 seconds, to see why it failed. |
| `wick stop` | `wick_stop` | Stops the running macro. |
| `wick new NAME` | `wick_new_macro` | Creates a macro in the library. |

Every command takes `--target roblox|testbench|sim` (default: the macro's target) and `--folder` (default: the nearest folder with a `wick.json`), and prints JSON.

Agent input goes through the same gate as a macro's: only to the target window, only while it has focus, and F8 stops it. If the window doesn't have focus, `act` says so and sends nothing; the agent should ask you to click the game. Agents don't need a macro's declared permissions to test input, because they act for you, but the macros they write do.

## How an agent should approach a new minigame

1. **Look.** `observe`, then draw regions around the moving parts with `region set`.
2. **Detect.** `detect` each region to find exact colors from its palette, then check matches with `--mask`.
3. **Measure.** `probe` to get the mechanics as numbers. For a sequence you don't understand yet, `record --you` while the person plays it once, then read `record.jsonl` and the contact sheet. For the bar minigame: the tick's drift with no input, how far one click pushes it, how often the zone jumps, and the latency.
4. **Write** the controller in `main.ts` from those measurements, not guesses. Multi-step tasks become a state machine (`ctx.states()`): one state per step, each with a timeout, a recovery state that gets back to a known place, and a start-point check before each loop. See [API.md](API.md#state-machines) and `examples/fishing-loop`.
5. **Test.** `run` with a short limit, read the result and log, and fix what fails. Repeat until it's reliable.
6. **Wrap up.** Fill in the manifest's `settings`, `permissions` and `README.md`.

Agents work much better from numbers ("tick x every frame") than from raw video, so the tools return traces wherever they can.

## Example probe

Measuring the simulator's bar minigame: follow the white tick and green zone in the `bar` region for two seconds, clicking five times 300 ms apart.

```sh
wick probe --target sim --track tick:bar:#ffffff:40 --track zone:bar:#3ccf5a --clicks 5 --every 300 --seconds 2
```

The result has, for each tracker, columns `t`, `x`, `y`, `left`, `right` and `vx` (positions as fractions of the region, `null` when not seen), plus the time each input was actually sent. Wick's tests use exactly this to measure the simulator's drift and click push to within 5% of their true values.

Macros run with the human profile (a small, varied delay on every input and curved mouse moves), so leave some timing margin; `run --exact` shows how the logic does without it. Probes and single inputs are always exact.

Not built yet: `pack` (sharing). See the [roadmap](ROADMAP.md).
