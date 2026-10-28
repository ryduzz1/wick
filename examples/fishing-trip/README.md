# Fishing trip

A multi-part loop on the simulator's world: walk from the spawn to the dock, fish until the bag is full, walk to the vendor, sell, reset back to the spawn, and go again.

| State | Does | Gives up after |
| --- | --- | --- |
| `toDock` | Plays the `to-dock` route until the prompt shows | 6 s |
| `cast` | Goes to `toVendor` if the bag's last slot is full, otherwise presses E at the prompt | 4 s |
| `bite` | Waits for the bar | 3 s |
| `play` | Keeps the tick in the zone until the bar goes away | 10 s |
| `toVendor` | Plays the `to-vendor` route until the prompt shows again | 8 s |
| `sell` | Opens the menu, clicks Sell, waits for the bag to empty, closes the menu | 5 s |
| `home` | Resets the character, which puts it back at the spawn | 5 s |
| `recover` | Closes any menu and resets | 5 s |

Every trip starts from the spawn, and the `spawn` region is checked against how it looked on the first trip before each new one.

## Where the routes came from

`routes/to-dock.js` and `routes/to-vendor.js` were cut from a recorded demonstration, the way an agent would build them from you playing once. `demo.json` is a scripted person playing one trip on the simulator, so you can repeat it without a game:

```sh
wick record --target sim --you --seconds 14 --scenario demo.json
wick storyboard
wick route --steps 1 --name to-dock
wick route --steps 4 --name to-vendor
```

The storyboard splits the demonstration into seven steps: walk to the dock and press E, play the minigame, wait, walk to the vendor and press E, click Sell, press Escape, wait. Steps 1 and 4 are the walks.

For a real game, record yourself with `wick record --you --seconds 120`, starting right after a respawn, and cut your own routes the same way. Then redraw the regions and pick the colors from your game.
