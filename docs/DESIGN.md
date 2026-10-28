# Design

Wick and Fuse are siblings. Wick keeps Fuse's foundation (palette, layout, type, components, tone) so the two clearly come from the same maker, and adds two things of its own: one ember accent, and a live style for watching macros run in real time.

## Principles

- **Quiet by default, loud when live.** Idle screens are calm and gray like Fuse. Color and motion are saved for things that are running or need attention.
- **Ember means on.** The accent marks what is running, plus the logo and the Run button. Nothing else uses it.
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
- Italic serif logo mark: Fuse is **F**, Wick is **W**.

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
| `--ember` | `#f08a4b` | Running, Run button, logo. Wick only |
| `--ember-soft` | `#3a261b` | Background behind running items |
| `--green` | `#7eca96` | Success, detector "found" |
| `--yellow` | `#e3cf6e` | Warnings |
| `--red` | `#e8a89f` | Errors, stopped by the kill switch |

Fuse uses an amber (`#dfba78`) for warnings. It sits too close to ember, so Wick uses `--yellow` for warnings instead and keeps orange meaning "on."

Overlay colors (drawn on the game frame, so they need to stand out against any game):

| Token | Value | Use |
| --- | --- | --- |
| `--overlay-region` | `#ffffff` at 80%, 1.5px dashed | Region outlines |
| `--overlay-mask` | `#f08a4b` at 45% | Pixels a detector matched |
| `--overlay-track` | `#7eca96` | Tracker crosshair and its trail |
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
| Recovering | Yellow dot | Recovering: resetting character |
| Stopped | Red dot | Stopped by kill switch / Stopped: zone not found for 5s |
| Done | Green dot | Done · 50 loops, 98% |

The dot never carries meaning alone; the label always says the state in words.

## Wick-only components

### Live view

The main editing and debugging surface: the captured Roblox frame, scaled to fit, with layers you can toggle:

- **Regions:** dashed outlines with a name label in the top-left corner. Drag to move, handles to resize.
- **Masks:** what each color or template detector matched, tinted ember.
- **Trackers:** a crosshair at the current position plus a short fading trail.
- **Frame bar:** under the view, in monospace: capture fps, frame-to-input latency, and frame time.

### Trace graphs

Small line graphs of tracker values over the last few seconds (for the bar minigame: tick x, zone left and right edges, and click marks along the bottom). Lines use `--text`, `--green` and `--muted`; inputs are short ember ticks. Hovering shows exact values. The same graphs appear in recordings and run logs, so what an agent reads as a trace, you can see as a picture.

### Stat tiles

A compact row above the live view or in run results: loops, success rate, average reaction, uptime. Monospace values, 11px muted labels underneath, no borders between tiles.

### Mini window

A small always-on-top panel shown over Roblox while a macro runs, so you don't need the main window:

- About 260 × 64px, `#181818` at 92% opacity, 12px radius, draggable, remembers its position.
- Macro name, the run state dot and label, loop count, and a Stop button.
- The kill-switch hotkey in small text (for example `F8 to stop`).
- Excluded from Wick's own capture so macros never see it.

### Kill-switch chip

Whenever a macro can send input, the top bar shows a chip with the hotkey (`F8 · Stop all`). Pressing the key turns the chip red for a moment and shows a toast saying what was stopped.

### Install screen

For shared macros: the macro's name and author, the game, the README, the permissions as a plain-words list with an icon each, and the full source under "View code." Primary button: **Install**. A permission added in an update is marked "New."

## Logo

An italic serif **W** in the same style as Fuse's **F** (Georgia-style, bold italic, white on a rounded square). Wick's version adds a small ember flame where the W's middle peak points up, so the marks pair at a glance but Wick is the one that's lit.

## Motion

- Pulsing dots for Waiting and Running, at Fuse's 1.6s pulse.
- Tracker trails fade over about 300ms.
- No other decorative motion. With `prefers-reduced-motion`, dots stay solid and trails are off.

## Accessibility

- State is always given in words, never color alone.
- Text keeps at least 4.5:1 contrast on its background; muted text is for secondary information only.
- Every action has a keyboard shortcut or is reachable by tab, and the kill switch works whichever app is focused.
