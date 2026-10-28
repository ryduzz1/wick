//! The `sim` target: a deterministic bar minigame rendered into frames.
//!
//! A tick mark drifts backwards at a constant speed, and each click pushes it
//! forward. A target zone jumps to a nearby spot on a fixed interval. The
//! score is the fraction of time the tick spends inside the zone.
//!
//! `testbench/index.html` draws the same game with the same geometry and
//! colors, so a macro tuned here also works on the test bench.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::frame::{Frame, Rect};
use crate::input::Action;
use crate::target::Target;

pub const BACKGROUND: [u8; 3] = [24, 26, 31];
pub const TRACK: [u8; 3] = [46, 49, 56];
pub const ZONE: [u8; 3] = [0x3c, 0xcf, 0x5a];
pub const TICK: [u8; 3] = [255, 255, 255];

/// Bar geometry in viewport heights, measured from the bottom-center anchor.
pub const BAR_Y: f64 = -0.18;
pub const BAR_W: f64 = 0.42;
pub const BAR_H: f64 = 0.034;

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Scenario {
    /// Backward speed, in bar widths per second.
    pub drift: f64,
    /// How far one click pushes the tick, in bar widths.
    pub push: f64,
    /// How long one push takes to play out.
    pub push_ms: f64,
    /// Zone width, in bar widths.
    pub zone: f64,
    pub jump_ms: f64,
    /// Largest distance the zone moves per jump, in bar widths.
    pub jump_range: f64,
    /// Delay between a click being sent and the game reacting.
    pub latency_ms: f64,
    pub fps: f64,
    pub seed: u64,
    pub width: usize,
    pub height: usize,
}

impl Default for Scenario {
    fn default() -> Self {
        Scenario {
            drift: 0.25,
            push: 0.035,
            push_ms: 60.0,
            zone: 0.125,
            jump_ms: 500.0,
            jump_range: 0.10,
            latency_ms: 30.0,
            fps: 120.0,
            seed: 1,
            width: 960,
            height: 540,
        }
    }
}

/// xorshift64*: small, fast and the same everywhere.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    /// Uniform in [0, 1).
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
}

pub struct BarGame {
    pub scenario: Scenario,
    rng: Rng,
    /// Seconds since the start.
    pub t: f64,
    pub tick: f64,
    pub zone: f64,
    next_jump: f64,
    /// Pushes still playing out, as remaining distance.
    pushes: Vec<f64>,
    /// Clicks waiting out the input latency, by the time they land.
    pending: Vec<f64>,
    in_zone: f64,
    pub clicks: u64,
}

impl BarGame {
    pub fn new(scenario: Scenario) -> Self {
        let mut game = BarGame {
            rng: Rng::new(scenario.seed),
            t: 0.0,
            tick: 0.5,
            zone: 0.5,
            next_jump: scenario.jump_ms / 1000.0,
            pushes: Vec::new(),
            pending: Vec::new(),
            in_zone: 0.0,
            clicks: 0,
            scenario,
        };
        let start = 0.3 + 0.4 * game.rng.next();
        game.zone = game.clamp_zone(start);
        game
    }

    fn clamp_zone(&self, c: f64) -> f64 {
        let half = self.scenario.zone / 2.0;
        c.clamp(half, 1.0 - half)
    }

    pub fn click(&mut self) {
        self.clicks += 1;
        self.pending
            .push(self.t + self.scenario.latency_ms / 1000.0);
    }

    pub fn inside(&self) -> bool {
        (self.tick - self.zone).abs() <= self.scenario.zone / 2.0
    }

    pub fn step(&mut self, dt: f64) {
        let s = &self.scenario;
        let landed = self.pending.iter().filter(|&&at| at <= self.t).count();
        self.pending.retain(|&at| at > self.t);
        self.pushes.extend(std::iter::repeat_n(s.push, landed));

        let rate = s.push / (s.push_ms / 1000.0).max(1e-6);
        let mut forward = 0.0;
        for remaining in &mut self.pushes {
            let d = (rate * dt).min(*remaining);
            *remaining -= d;
            forward += d;
        }
        self.pushes.retain(|&r| r > 1e-12);
        self.tick = (self.tick + forward - s.drift * dt).clamp(0.0, 1.0);

        if self.t >= self.next_jump {
            let range = s.jump_range;
            let target = self.zone + (self.rng.next() * 2.0 - 1.0) * range;
            self.zone = self.clamp_zone(target);
            self.next_jump += s.jump_ms / 1000.0;
        }
        if self.inside() {
            self.in_zone += dt;
        }
        self.t += dt;
    }

    pub fn score(&self) -> f64 {
        if self.t > 0.0 {
            self.in_zone / self.t
        } else {
            0.0
        }
    }

    /// The bar's track in frame pixels for a `width` × `height` viewport.
    pub fn track_rect(width: usize, height: usize) -> Rect {
        let vh = height as f64;
        let (w, h) = (BAR_W * vh, BAR_H * vh);
        let cy = vh + BAR_Y * vh;
        Rect::new(width as f64 / 2.0 - w / 2.0, cy - h / 2.0, w, h)
    }

    /// Redraws only the bar area; the rest of the frame is background.
    pub fn render(&self, frame: &mut Frame) {
        let track = Self::track_rect(frame.width, frame.height);
        let pad = track.h;
        frame.fill(
            Rect::new(
                track.x - pad,
                track.y - pad,
                track.w + 2.0 * pad,
                track.h + 2.0 * pad,
            ),
            BACKGROUND,
        );
        frame.fill(track, TRACK);
        let zw = self.scenario.zone * track.w;
        frame.fill(
            Rect::new(
                track.x + self.zone * track.w - zw / 2.0,
                track.y,
                zw,
                track.h,
            ),
            ZONE,
        );
        let tw = (0.004 * frame.height as f64).max(2.0);
        let overhang = track.h * 0.2;
        frame.fill(
            Rect::new(
                track.x + self.tick * track.w - tw / 2.0,
                track.y - overhang,
                tw,
                track.h + 2.0 * overhang,
            ),
            TICK,
        );
    }
}

pub struct SimTarget {
    pub game: BarGame,
    /// Input "the person" made, for tests of recordings.
    pub heard: Vec<crate::target::HeardInput>,
    frame: Frame,
    realtime: bool,
    started: Instant,
}

impl SimTarget {
    pub fn new(scenario: Scenario, realtime: bool) -> Self {
        let frame = Frame::new(scenario.width, scenario.height, BACKGROUND);
        SimTarget {
            game: BarGame::new(scenario),
            heard: Vec::new(),
            frame,
            realtime,
            started: Instant::now(),
        }
    }
}

impl Target for SimTarget {
    fn id(&self) -> &'static str {
        "sim"
    }

    fn next_frame(&mut self, _wait: Duration) -> Option<Arc<Frame>> {
        let dt = 1.0 / self.game.scenario.fps;
        if self.realtime {
            let due = self.started + Duration::from_secs_f64(self.game.t + dt);
            if let Some(sleep) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(sleep);
            }
        }
        self.game.step(dt);
        self.game.render(&mut self.frame);
        Some(Arc::new(self.frame.clone()))
    }

    fn now_ms(&self) -> f64 {
        self.game.t * 1000.0
    }

    fn viewport(&self) -> Rect {
        Rect::new(0.0, 0.0, self.frame.width as f64, self.frame.height as f64)
    }

    fn focused(&mut self) -> bool {
        true
    }

    fn latency(&self) -> f64 {
        self.game.scenario.latency_ms / 1000.0
    }

    fn send(&mut self, action: &Action) -> Result<(), String> {
        match action {
            Action::Button {
                button: wick_platform::MouseButton::Left,
                down: true,
            } => self.game.click(),
            Action::Key { name, down: true } if name == "space" => self.game.click(),
            _ => {}
        }
        Ok(())
    }

    fn status(&mut self) -> Value {
        json!({ "found": true, "focused": true, "window": { "width": self.frame.width, "height": self.frame.height } })
    }

    fn heard(&mut self) -> Vec<crate::target::HeardInput> {
        std::mem::take(&mut self.heard)
    }

    fn score(&self) -> Option<Value> {
        Some(json!({
            "inZone": self.game.score(),
            "clicks": self.game.clicks,
            "seconds": self.game.t,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_game() {
        let run = |seed| {
            let mut g = BarGame::new(Scenario {
                seed,
                ..Scenario::default()
            });
            for i in 0..600 {
                if i % 7 == 0 {
                    g.click();
                }
                g.step(1.0 / 120.0);
            }
            (g.tick, g.zone, g.score())
        };
        assert_eq!(run(3), run(3));
        assert_ne!(run(3), run(4));
    }

    #[test]
    fn drifts_back_without_clicks() {
        let mut g = BarGame::new(Scenario::default());
        for _ in 0..120 {
            g.step(1.0 / 120.0);
        }
        assert!((g.tick - 0.25).abs() < 1e-6, "{}", g.tick);
    }

    #[test]
    fn a_click_pushes_after_latency() {
        let mut g = BarGame::new(Scenario {
            drift: 0.0,
            ..Scenario::default()
        });
        g.click();
        for _ in 0..3 {
            g.step(1.0 / 120.0);
        }
        assert_eq!(g.tick, 0.5, "still waiting out latency");
        for _ in 0..30 {
            g.step(1.0 / 120.0);
        }
        assert!((g.tick - 0.535).abs() < 1e-9, "{}", g.tick);
    }

    #[test]
    fn zone_stays_on_the_bar() {
        let mut g = BarGame::new(Scenario {
            jump_range: 0.9,
            ..Scenario::default()
        });
        for _ in 0..12_000 {
            g.step(1.0 / 120.0);
            assert!(g.zone >= 0.0625 - 1e-9 && g.zone <= 0.9375 + 1e-9);
        }
    }

    #[test]
    fn renders_zone_and_tick_where_the_game_says() {
        let g = BarGame::new(Scenario::default());
        let mut f = Frame::new(960, 540, BACKGROUND);
        g.render(&mut f);
        let track = BarGame::track_rect(960, 540);
        let y = (track.y + track.h / 2.0) as usize;
        let tick_x = (track.x + g.tick * track.w) as usize;
        assert_eq!(f.rgb(tick_x, y), TICK);
        let zone_x = (track.x + g.zone * track.w + 0.04 * track.w) as usize;
        if (g.zone + 0.04 - g.tick).abs() > 0.01 {
            assert_eq!(f.rgb(zone_x, y), ZONE);
        }
    }
}
