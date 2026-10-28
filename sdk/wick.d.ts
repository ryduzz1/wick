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
  /** `#rrggbb`. */
  color: string;
  /** Largest difference allowed on any one color channel. Default 30. */
  tolerance?: number;
  /** Fewest matching pixels that count as found. Default 3. */
  minPixels?: number;
}

/** A region name, or a point inside a region as fractions (default: its center). */
export type Point = string | { region?: string; x?: number; y?: number };

export interface Screen {
  /** Starts tracking a color inside a region from regions.json. */
  track(region: string, options: TrackOptions): Tracker;
  /** Viewport size in frame pixels. */
  readonly width: number;
  readonly height: number;
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
}

export interface Loop {
  /**
   * Calls `body` up to `rate` times a second, once per frame at most, until
   * `until` returns true or `for` milliseconds pass.
   */
  hz(rate: number, body: () => void, options?: { until?: () => boolean; for?: number }): Promise<void>;
  /** Runs `body` `times` times, or forever when `times` is 0. */
  repeat(times: number, body: (index: number) => Promise<void> | void): Promise<void>;
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
}

export interface MacroDefinition {
  run(ctx: Context): Promise<void>;
}

export function macro(definition: MacroDefinition): MacroDefinition;
