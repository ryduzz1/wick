# Fishing loop

A looping macro built as a state machine, on the simulator's looping game: press E at the yellow prompt to cast, play the bar minigame when it appears, and do it again.

| State | Does | Gives up after |
| --- | --- | --- |
| `cast` | Waits for the prompt and presses E | 4 s |
| `bite` | Waits for the bar | 3 s |
| `play` | Keeps the tick in the zone until the bar goes away | 10 s |
| `recover` | Rejoins if the disconnect dialog is up, otherwise resets the character | 15 s |

When a state gives up, the macro goes to `recover`. Before each loop it checks that the HUD (bottom left) looks the way it did at the start. The simulator settings in `wick.json` make the third cast get stuck and the game disconnect after 30 seconds, so you can watch both recoveries.

For a real game, redraw the four regions, pick the colors from your game, and change what `recover` does.
