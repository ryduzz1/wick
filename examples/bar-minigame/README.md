# Bar minigame

Keeps a white tick inside a green zone that jumps around. The tick drifts backwards on its own, and every click pushes it forward.

The macro tracks both by color, predicts where the tick will be once a click would land, and clicks whenever that prediction is behind the zone's center.

Try it on the **Simulator** or the **Test bench** target in Wick. For a real game, adjust the `bar` region in `regions.json` and the two colors in `main.ts` to match.

## Settings

- **Minimum time between clicks:** lower clicks faster, which reacts quicker but overshoots more.
- **Look-ahead:** how far ahead to predict, in multiples of the input latency. Raise it if the tick keeps overshooting.
- **Stop after:** a time limit, or 0 to run until the bar disappears.
