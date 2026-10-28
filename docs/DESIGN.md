# Design

Wick and Fuse are siblings. Wick keeps Fuse's foundation (palette, layout, type, components, tone) so the two clearly come from the same maker, and adds two things of its own: a single ember accent, and a live style for watching macros run in real time.

## Principles

- **Quiet by default, loud when live.** Idle screens are calm and gray like Fuse. Color and motion are saved for things that are running or need attention.
- **One accent.** Everything is gray, white and black except ember, which marks what is running and the Run button. The only other color is a soft red for errors. No green, yellow or blue anywhere, including native controls (checkboxes use a light gray `accent-color`).
- **Show what the macro sees.** Every region, detector and tracker can be drawn over the real game frame. If something fails, you should be able to see why.
- **Stop is always one key away.** The kill-switch hotkey is visible whenever a macro can send input.
- **Plain words.** Same tone as Fuse: short sentences, no jargon on the main path, details tucked under "More."

## Shared with Fuse

Taken as is from Fuse's `companion/ui/styles.css`:

- Dark only (`color-scheme: dark`), system font stack, 13px base size.
- Sidebar 244px on `#2d2d2d`, top bar 51px with a drag region, content max-width 960px.
- Buttons with a 7px radius; white primary buttons; transparent "quiet" buttons.
- Cards and lists with a 9px radius on `#202020`–`#242424`, 1px borders around `#383838`.
- Dialogs with a 16px radius, toasts in the top right, count pills, 16px line icons at a 1.6 stroke.
- Italic serif logo mark: Fuse is **f**, Wick is **w**.

If both apps keep the same base, it can later move into one shared stylesheet. Until then, keep the values below in sync with Fuse by hand.

## Color tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#181818` | App background |
| `--panel` | `#222222` | Cards, inputs |
| `--sidebar` | `#2d2d2d` | Sidebar |
| `--border` | `#383838` | Borders, dividers |
| `--hover` | `#393939` | Hover fill |
| `--text` | `#ececec` | Main text |
| `--muted` | `#969696` | Secondary text |
| `--ember` | `#f08a4b` | Running, Run button, trackers on the live view. Wick only |
| `--ember-soft` | `#3a261b` | Background behind running items |
| `--red` | `#e8a89f` | Errors only |

"Found", "connected" and "done" use a `--text` dot, not green. Warnings and notices use the normal card style, not a colored box.

Overlay colors (drawn on the game frame, so they need to stand out against any game):

| Token | Value | Use |
| --- | --- | --- |
| `--overlay-region` | `#ffffff` at 80%, 1.5px dashed | Region outlines |
| `--overlay-mask` | `#f08a4b` at 45% | Pixels a detector matched |
| `--overlay-track` | `#f08a4b` | Tracker extent, crosshair and trail |
| `--overlay-label` | `#000000` at 70% behind `#ffffff` text | Region and tracker labels |

## Typography

- System font, as in Fuse: 13px body, 12px for most UI, 11px for secondary text, 23px page titles at weight 550.
- **Numbers that update live** (fps, latency, loop counts, success rate, coordinates) use `ui-monospace` with `font-variant-numeric: tabular-nums`, so they don't jitter as they change.
- Code and logs use the same monospace stack at 11px/1.8, as in Fuse.

## Run states

Every macro is in one of these states, everywhere it appears (library row, top bar, mini window):

| State | Indicator | Label |
| --- | --- | --- |
| Idle | Gray dot | Ready |
| Waiting | Gray dot, pulsing | Waiting for Roblox / Checking start point |
| Running | Ember dot, pulsing; item gets `--ember-soft` fill | Running · loop 12 of ∞ |
| Paused or recovering | Ember dot, solid | Paused: click the Roblox window / Recovering: resetting character |
| Stopped | Gray dot | Stopped by kill switch / Stopped: zone not found for 5s |
| Error | Red dot | Error: the macro threw |
| Done | White dot | Done · 50 loops, 98% |

The dot never carries meaning alone; the label always says the state in words.

## Wick-only components

### Live view

The main editing and debugging surface: the captured Roblox frame, scaled to fit, with layers you can toggle:

- **Regions:** dashed outlines with a name label in the top-left corner. Drag to move, handles to resize.
- **Masks:** what each color or template detector matched, tinted ember.
- **Trackers:** a crosshair at the current position plus a short fading trail.
- **Frame bar:** under the view, in monospace: capture fps, frame-to-input latency, and frame time.

### Trace graphs

Small line graphs of tracker values over the last few seconds (for the bar minigame: tick x, zone left and right edges, and click marks along the bottom). Lines use `--text` and `--muted` (dashed where they'd overlap); inputs are short ember ticks. Hovering shows exact values. The same graphs appear in recordings and run logs, so what an agent reads as a trace, you can see as a picture.

### Stat tiles

A compact row above the live view or in run results: loops, success rate, average reaction, uptime. Monospace values, 11px muted labels underneath, no borders between tiles.

### Mini window

A small always-on-top panel shown over Roblox while a macro runs, so you don't need the main window:

- 280 × 72px, `#181818` at 92% opacity, 12px radius, draggable, remembers its position (top right of the main display by default).
- Macro name, the run state dot and label (time, loop count, current state), and a Stop button. Double-click the name to bring the main window back.
- The kill-switch hotkey in small text (`F8 to stop`).
- Never takes focus, so input keeps going to the game, and is excluded from every screen capture (Wick's included) so macros never see it.
- Shown for runs on Roblox and the test bench, not the simulator; after a run it shows how it ended for a few seconds. Settings can turn it off.

### Kill-switch chip

Whenever a macro can send input, the top bar shows a chip with the hotkey (`F8 · Stop all`). Pressing the key highlights the chip for a moment and shows a toast saying what was stopped.

### Install screen

For shared macros: the app icon, the macro's name, version, author and target, its description, badges (whether the files match the package's hash, whether it updates an installed copy, how many new permissions it asks for), problems in soft red, the permissions as a plain-words list (a permission added in an update gets an ember dot and "new in this version"), the README as plain text, and every file, expandable to its source. Primary button: **Install** (or **Update**) in ember; it's disabled for a changed or broken package.

## Logo

The same system as Fuse's **f**: a lowercase Georgia bold italic **w**.

- In the sidebar, the bare white glyph next to the name, with no tile.
- The app icon (`app/ui/assets/icon.png`, rebuilt with `swift scripts/build-icon.swift`) is the white glyph on Apple's 824pt rounded tile, filled with a `#2d2d2d`→`#181818` gradient and a faint edge. Larger marks in the app use the icon.

## Motion

- Pulsing dots for Waiting and Running, at Fuse's 1.6s pulse.
- Tracker trails fade over about 300ms.
- No other decorative motion. With `prefers-reduced-motion`, dots stay solid and trails are off.

## Accessibility

- State is always given in words, never color alone.
- Text keeps at least 4.5:1 contrast on its background; muted text is for secondary information only.
- Every action has a keyboard shortcut or is reachable by tab, and the kill switch works whichever app is focused.

## Keyboard shortcuts

| Shortcut (macOS / Windows) | Action |
| --- | --- |
| ⌘N / Ctrl+N | New macro |
| ⌘O / Ctrl+O | Open macro folder |
| ⇧⌘I / Ctrl+Shift+I | Install macro |
| ⌘R / Ctrl+R | Run |
| ⌘. / Ctrl+. | Stop |
| ⌘T / Ctrl+T | Test on simulator |
| ⌘E / Ctrl+E | Export |
| ⇧⌘E / Ctrl+Shift+E | Edit code |
| ⇧⌘R / Ctrl+Shift+R | Show folder |
| ⌘, / Ctrl+, | Settings |
| Esc | Back to the Select tool on the live view |
| F8 (from any app) | Stop every macro |
