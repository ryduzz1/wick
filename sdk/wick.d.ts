// Types for the Wick macro API. See docs/API.md.

/** Follows something on screen by color, updated every frame. */
export interface Tracker {
  readonly id: number;
  readonly region: string;
  /** Whether it was found in the latest frame. */
  readonly seen: boolean;
  /** Centroid, as fractions of the region (0 = left/top edge, 1 = right/bottom). */
  readonly x: number;
  readonly y: number;
  /** Extent of every matching pixel, as fractions of the region. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** Middle of the extent, horizontally and vertically. */
  readonly center: number;
  readonly middle: number;
  readonly width: number;
  readonly height: number;
  /** Horizontal speed, in region widths per second. Same as `vx`. */
  readonly velocity: number;
  readonly vx: number;
  /** Vertical speed, in region heights per second. */
  readonly vy: number;
  readonly pixels: number;
  /** Fraction of the region's pixels that matched. */
  readonly coverage: number;
  /** Milliseconds since it was last seen; 0 while visible. */
  readonly missingFor: number;
}

export interface TrackOptions {
  /** `#rrggbb`. Leave it out when using `except`. */
  color?: string;
  /**
   * Follow anything that isn't one of these colors instead, for a shape whose
   * color changes (a zone that's a different color each time) on a background
   * that doesn't.
   */
  except?: string[];
  /** Largest difference allowed on any one color channel. Default 30. */
  tolerance?: number;
  /** Fewest matching pixels that count as found. Default 3. */
  minPixels?: number;
}

/** A region name, or a point inside a region as fractions (default: its center). */
export type Point = string | { region?: string; x?: number; y?: number };

/** Compares a region to how it looked when the check was made (or last retaken). */
export interface Similar {
  readonly region: string;
  /** Share of the region that looks the same, 0 to 1. NaN until the reference is taken on the next frame. */
  readonly score: number;
  readonly threshold: number;
  /** Whether `score` is at least `threshold`. */
  readonly matches: boolean;
  /** Takes a new reference on the next frame. */
  retake(): void;
}

export interface Screen {
  /** Starts tracking a color inside a region from regions.json. */
  track(region: string, options: TrackOptions): Tracker;
  /** Starts comparing a region to how it looks on the next frame. */
  similar(region: string, options?: { threshold?: number }): Similar;
  /**
   * Looks for a saved template (templates/NAME.png) in a region, `hz` times
   * a second (default 10, up to 30). Scales with the window.
   */
  find(region: string, options: { template: string; threshold?: number; hz?: number }): Finder;
  /**
   * Reads text in a region with the system's text recognition, `hz` times a
   * second (default 2, up to 5). Results arrive a little after each frame.
   */
  read(region: string, options?: { hz?: number; accurate?: boolean }): TextReader;
  /** Viewport size in frame pixels. */
  readonly width: number;
  readonly height: number;
}

export interface Finder {
  readonly region: string;
  readonly template: string;
  readonly threshold: number;
  /** Whether the best match scores at least `threshold` (default 0.8). */
  readonly seen: boolean;
  /** How well the best spot matches, 0 to 1; NaN before the first search. */
  readonly score: number;
  /** The match's center and size as fractions of the region; NaN or 0 when not seen. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The match's center as a point for `input.click({ at })`, or null. */
  readonly at: Point | null;
}

export interface TextLine {
  text: string;
  /** 0 to 1 (always 1 on Windows). */
  confidence: number;
  /** The line's box as fractions of the region. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextReader {
  readonly region: string;
  /** Whether a read has finished yet. */
  readonly ready: boolean;
  /** All the text, top to bottom, one line per line; "" until the first read. */
  readonly text: string;
  readonly lines: TextLine[];
  /** Why the last read failed, if it did. */
  readonly error: string | null;
  /** Every number in the text, in order ("3/5" gives [3, 5]). */
  readonly numbers: number[];
  /** The first number in the text, or NaN. */
  readonly number: number;
  /** When the text was last read, in ms since the macro started. */
  readonly at: number;
  /** Whether the text contains `s`, ignoring case. */
  has(s: string): boolean;
}

export type Button = "left" | "right" | "middle";

export interface Input {
  /** Estimated seconds between sending input and the game reacting. */
  readonly latency: number;
  /** Whether the target window has focus. Input is dropped while it doesn't. */
  readonly focused: boolean;
  /** Clicks, optionally at a point. Returns false if skipped by `minGap`. Needs `mouse.click`. */
  click(options?: { button?: Button; at?: Point; hold?: number; minGap?: number }): boolean;
  mouseDown(button?: Button): void;
  mouseUp(button?: Button): void;
  /** Moves the cursor to a point. Needs `mouse.move`. */
  move(at: Point): void;
  /** Turns the camera by a relative mouse movement in pixels. Needs `mouse.move`. */
  turn(dx: number, dy?: number): void;
  /** Taps a key for `hold` ms (default 40). Needs `keyboard`. */
  press(key: string, options?: { hold?: number }): void;
  keyDown(key: string): void;
  keyUp(key: string): void;
  /**
   * Replays a route: timed holds, presses, clicks and turns, usually cut
   * from a recording with `wick route`. Stops early, letting go of held
   * keys, as soon as `until` returns true. `settle` waits that many more ms
   * for `until` after the route ends; `speed` scales its timing.
   */
  play(route: readonly RouteAction[], options?: { until?: () => boolean; settle?: number; speed?: number }): Promise<{ reached: boolean; ms: number }>;
}

/** One step of a route. `t` is ms from the start of the route. */
export type RouteAction =
  | { t: number; do: "hold"; key: string; ms: number }
  | { t: number; do: "press"; key: string; ms?: number }
  | { t: number; do: "keyDown" | "keyUp"; key: string }
  | { t: number; do: "click"; button?: Button; at?: [number, number] | Point; region?: string; ms?: number }
  | { t: number; do: "turn"; dx: number; dy?: number; ms?: number }
  | { t: number; do: "wait"; ms: number };

export interface Loop {
  /**
   * Calls `body` up to `rate` times a second, once per frame at most, until
   * `until` returns true or `for` milliseconds pass.
   */
  hz(rate: number, body: () => void, options?: { until?: () => boolean; for?: number }): Promise<void>;
  /** Runs `body` `times` times, or forever when `times` is 0. */
  repeat(times: number, body: (index: number) => Promise<void> | void): Promise<void>;
}

export interface State {
  /** Does the state's work with its own `ctx`, and returns the next state's name, or "done". */
  run(ctx: Context): Promise<string | void> | string | void;
  /** Gives up after this many ms: the state's waits and loops stop and its input is ignored. */
  timeout?: number;
  /** Where to go when it times out. Default: the machine's `recover` state. */
  onTimeout?: string;
}

export interface StatesOptions {
  /** The state each loop starts from. Default: the first one. */
  start?: string;
  /** Stop after this many loops (passes back to `start`); 0 or missing runs until a state returns "done". */
  loops?: number;
  /** The state for timeouts and failed start-point checks. */
  recover?: string;
  /** A region that must look like it did at the first loop before each later loop starts. */
  startPoint?: string | { region: string; threshold?: number; wait?: number };
  watchdog?: {
    /** Stop after this many timeouts or failed checks in a row. Default 3. */
    maxTimeouts?: number;
    /** Stop when fewer than this share of the last 10 loops went cleanly. Default 0 (off). */
    minSuccess?: number;
  };
}

export interface StatesResult {
  loops: number;
  timeouts: number;
  recoveries: number;
}

export interface Context {
  readonly screen: Screen;
  readonly input: Input;
  readonly loop: Loop;
  /** Resolves after `ms` milliseconds. */
  wait(ms: number): Promise<void>;
  /** Resolves true once `check` returns true, or false after `timeout` ms. */
  waitUntil(check: () => boolean, options?: { timeout?: number }): Promise<boolean>;
  log(...values: unknown[]): void;
  /** Values from the manifest's settings, as the user set them. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Milliseconds since the run started. */
  now(): number;
  /** Runs a state machine. See docs/API.md#state-machines. */
  states(states: Record<string, State>, options?: StatesOptions): Promise<StatesResult>;
  readonly character: {
    /** Resets your character (Roblox: Esc, R, Enter). Resolves once the keys are sent. Needs `character.reset`. */
    reset(): Promise<void>;
  };
  readonly game: {
    /** Rejoins the game in wick.json's `game.placeId`, at most once a minute. Needs `game.rejoin`. */
    rejoin(): Promise<void>;
  };
}

export interface MacroDefinition {
  run(ctx: Context): Promise<void>;
}

export function macro(definition: MacroDefinition): MacroDefinition;
