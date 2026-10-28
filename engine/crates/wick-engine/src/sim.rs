//! The `sim` target: a deterministic bar minigame rendered into frames.
//!
//! A tick mark drifts backwards at a constant speed, and each click pushes it
//! forward. A target zone jumps to a nearby spot on a fixed interval. The
//! score is the fraction of time the tick spends inside the zone.
//!
//! `testbench/index.html` draws the same game with the same geometry and
//! colors, so a macro tuned here also works on the test bench.
//!
//! With `roundMs` set it becomes a looping game, like fishing: press E at the
//! prompt to cast, play one round of the bar, and the prompt comes back.
//! Failures can be injected (casts that never land until the character is
//! reset, a disconnect that needs a rejoin) to test a macro's recovery.

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
/// The always-on HUD, bottom left, hidden while resetting or disconnected.
pub const HUD: [u8; 3] = [70, 90, 130];
/// "Press E" prompt, top center, shown while waiting to cast.
pub const PROMPT: [u8; 3] = [242, 193, 78];
pub const DIALOG: [u8; 3] = [57, 59, 61];
pub const DIALOG_BUTTON: [u8; 3] = [228, 228, 228];

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
    /// Round length; 0 plays one endless round.
    pub round_ms: f64,
    /// From pressing E to the bar appearing.
    pub cast_ms: f64,
    /// A round counts as won when the tick was in the zone this much of it.
    pub win_share: f64,
    /// Rounds (from 1) whose cast never lands until the character is reset.
    pub stuck_rounds: Vec<u32>,
    /// When the game disconnects, in ms. Rejoining brings it back.
    pub disconnect_at_ms: Option<f64>,
    pub reset_ms: f64,
    pub rejoin_ms: f64,
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
            round_ms: 0.0,
            cast_ms: 800.0,
            win_share: 0.6,
            stuck_rounds: Vec::new(),
            disconnect_at_ms: None,
            reset_ms: 1500.0,
            rejoin_ms: 3000.0,
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    /// The bar is up and clicks count.
    Playing {
        until: f64,
    },
    /// Waiting at the prompt for E.
    Idle,
    /// Cast sent; the bar appears at `until` unless the cast is stuck.
    Casting {
        until: f64,
        stuck: bool,
    },
    Resetting {
        until: f64,
    },
    Disconnected,
    Rejoining {
        until: f64,
    },
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
    /// Seconds spent with the bar up.
    played: f64,
    pub clicks: u64,
    pub phase: Phase,
    round_in_zone: f64,
    pub rounds_started: u32,
    pub rounds_played: u32,
    pub rounds_won: u32,
    pub resets: u32,
    pub rejoins: u32,
    disconnected: bool,
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
            played: 0.0,
            clicks: 0,
            phase: Phase::Idle,
            round_in_zone: 0.0,
            rounds_started: 0,
            rounds_played: 0,
            rounds_won: 0,
            resets: 0,
            rejoins: 0,
            disconnected: false,
            scenario,
        };
        let start = 0.3 + 0.4 * game.rng.next();
        game.zone = game.clamp_zone(start);
        if !game.rounds() {
            game.phase = Phase::Playing {
                until: f64::INFINITY,
            };
        }
        game
    }

    /// Whether this is the looping game rather than one endless round.
    pub fn rounds(&self) -> bool {
        self.scenario.round_ms > 0.0
    }

    /// Whether anything besides the bar is drawn.
    fn full_scene(&self) -> bool {
        self.rounds() || self.scenario.disconnect_at_ms.is_some()
    }

    fn start_round(&mut self) {
        self.tick = 0.5;
        self.pushes.clear();
        self.pending.clear();
        let start = 0.3 + 0.4 * self.rng.next();
        self.zone = self.clamp_zone(start);
        self.next_jump = self.t + self.scenario.jump_ms / 1000.0;
        self.round_in_zone = 0.0;
        self.phase = Phase::Playing {
            until: if self.rounds() {
                self.t + self.scenario.round_ms / 1000.0
            } else {
                f64::INFINITY
            },
        };
    }

    /// After a reset or rejoin: back to the prompt, or straight to the bar.
    fn ready(&mut self) {
        if self.rounds() {
            self.phase = Phase::Idle;
        } else {
            self.start_round();
        }
    }

    /// Pressing E at the prompt casts.
    pub fn cast(&mut self) {
        if self.phase == Phase::Idle {
            self.rounds_started += 1;
            let stuck = self.scenario.stuck_rounds.contains(&self.rounds_started);
            self.phase = Phase::Casting {
                until: self.t + self.scenario.cast_ms / 1000.0,
                stuck,
            };
        }
    }

    pub fn reset(&mut self) {
        if !matches!(self.phase, Phase::Disconnected | Phase::Rejoining { .. }) {
            self.resets += 1;
            self.phase = Phase::Resetting {
                until: self.t + self.scenario.reset_ms / 1000.0,
            };
        }
    }

    pub fn rejoin(&mut self) {
        if self.phase == Phase::Disconnected {
            self.rejoins += 1;
            self.phase = Phase::Rejoining {
                until: self.t + self.scenario.rejoin_ms / 1000.0,
            };
        }
    }

    fn clamp_zone(&self, c: f64) -> f64 {
        let half = self.scenario.zone / 2.0;
        c.clamp(half, 1.0 - half)
    }

    pub fn click(&mut self) {
        if !matches!(self.phase, Phase::Playing { .. }) {
            return;
        }
        self.clicks += 1;
        self.pending
            .push(self.t + self.scenario.latency_ms / 1000.0);
    }

    pub fn inside(&self) -> bool {
        (self.tick - self.zone).abs() <= self.scenario.zone / 2.0
    }

    pub fn step(&mut self, dt: f64) {
        if let Some(at) = self.scenario.disconnect_at_ms {
            if !self.disconnected && self.t * 1000.0 >= at {
                self.disconnected = true;
                self.phase = Phase::Disconnected;
            }
        }
        match self.phase {
            Phase::Playing { until } if self.t >= until => {
                self.rounds_played += 1;
                if self.round_in_zone >= self.scenario.win_share * self.scenario.round_ms / 1000.0 {
                    self.rounds_won += 1;
                }
                self.phase = Phase::Idle;
            }
            Phase::Casting {
                until,
                stuck: false,
            } if self.t >= until => self.start_round(),
            Phase::Resetting { until } | Phase::Rejoining { until } if self.t >= until => {
                self.ready()
            }
            _ => {}
        }
        if !matches!(self.phase, Phase::Playing { .. }) {
            self.t += dt;
            return;
        }
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
            self.round_in_zone += dt;
        }
        self.played += dt;
        self.t += dt;
    }

    /// Fraction of the time with the bar up that the tick was in the zone.
    pub fn score(&self) -> f64 {
        if self.played > 0.0 {
            self.in_zone / self.played
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

    /// Draws the frame. The classic game redraws only the bar area.
    pub fn render(&self, frame: &mut Frame) {
        if !self.full_scene() {
            return self.render_bar(frame);
        }
        let (w, h) = (frame.width as f64, frame.height as f64);
        let all = Rect::new(0.0, 0.0, w, h);
        match self.phase {
            Phase::Rejoining { .. } => return frame.fill(all, [8, 8, 10]),
            Phase::Resetting { .. } => return frame.fill(all, [14, 15, 18]),
            _ => frame.fill(all, BACKGROUND),
        }
        frame.fill(Rect::new(0.03 * h, h - 0.09 * h, 0.24 * h, 0.06 * h), HUD);
        match self.phase {
            Phase::Playing { .. } => self.render_bar(frame),
            Phase::Idle => frame.fill(
                Rect::new(w / 2.0 - 0.03 * h, 0.08 * h, 0.06 * h, 0.06 * h),
                PROMPT,
            ),
            Phase::Disconnected => {
                let (dw, dh) = (0.6 * h, 0.32 * h);
                frame.fill(
                    Rect::new(w / 2.0 - dw / 2.0, h / 2.0 - dh / 2.0, dw, dh),
                    DIALOG,
                );
                frame.fill(
                    Rect::new(
                        w / 2.0 - 0.1 * h,
                        h / 2.0 + dh / 2.0 - 0.1 * h,
                        0.2 * h,
                        0.06 * h,
                    ),
                    DIALOG_BUTTON,
                );
            }
            _ => {}
        }
    }

    fn render_bar(&self, frame: &mut Frame) {
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
            Action::Key { name, down: true } if name == "e" => self.game.cast(),
            _ => {}
        }
        Ok(())
    }

    fn status(&mut self) -> Value {
        json!({ "found": true, "focused": true, "window": { "width": self.frame.width, "height": self.frame.height } })
    }

    fn special(
        &mut self,
        name: &str,
        _game: &crate::target::GameInfo,
    ) -> Result<Vec<crate::human::Step>, String> {
        match name {
            "character.reset" => self.game.reset(),
            "game.rejoin" => self.game.rejoin(),
            other => return Err(format!("\"{other}\" isn't available on the sim target.")),
        }
        Ok(Vec::new())
    }

    fn heard(&mut self) -> Vec<crate::target::HeardInput> {
        std::mem::take(&mut self.heard)
    }

    fn score(&self) -> Option<Value> {
        let g = &self.game;
        let mut score = json!({
            "inZone": g.score(),
            "clicks": g.clicks,
            "seconds": g.t,
        });
        if g.rounds() || g.scenario.disconnect_at_ms.is_some() {
            score["rounds"] = json!({ "started": g.rounds_started, "played": g.rounds_played, "won": g.rounds_won });
            score["resets"] = json!(g.resets);
            score["rejoins"] = json!(g.rejoins);
        }
        Some(score)
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

    fn looping() -> Scenario {
        Scenario {
            round_ms: 2000.0,
            ..Scenario::default()
        }
    }

    fn run_for(g: &mut BarGame, seconds: f64) {
        for _ in 0..(seconds * 120.0) as usize {
            g.step(1.0 / 120.0);
        }
    }

    #[test]
    fn rounds_start_with_a_cast_and_end_at_the_prompt() {
        let mut g = BarGame::new(looping());
        run_for(&mut g, 1.0);
        assert_eq!(g.phase, Phase::Idle);
        g.click();
        assert_eq!(g.clicks, 0, "clicks only count with the bar up");
        g.cast();
        run_for(&mut g, 0.9);
        assert!(matches!(g.phase, Phase::Playing { .. }), "{:?}", g.phase);
        run_for(&mut g, 2.1);
        assert_eq!(g.phase, Phase::Idle);
        assert_eq!((g.rounds_started, g.rounds_played), (1, 1));
    }

    #[test]
    fn stuck_casts_need_a_reset() {
        let mut g = BarGame::new(Scenario {
            stuck_rounds: vec![1],
            ..looping()
        });
        g.cast();
        run_for(&mut g, 5.0);
        assert!(matches!(g.phase, Phase::Casting { stuck: true, .. }));
        g.reset();
        run_for(&mut g, 1.6);
        assert_eq!(g.phase, Phase::Idle);
        g.cast();
        run_for(&mut g, 0.9);
        assert!(matches!(g.phase, Phase::Playing { .. }), "round 2 lands");
    }

    #[test]
    fn disconnects_until_rejoined() {
        let mut g = BarGame::new(Scenario {
            disconnect_at_ms: Some(1000.0),
            ..Scenario::default()
        });
        run_for(&mut g, 1.5);
        assert_eq!(g.phase, Phase::Disconnected);
        let mut f = Frame::new(960, 540, BACKGROUND);
        g.render(&mut f);
        assert_eq!(f.rgb(480, 270), DIALOG);
        g.reset();
        assert_eq!(g.phase, Phase::Disconnected, "reset does nothing here");
        g.rejoin();
        run_for(&mut g, 3.1);
        assert!(matches!(g.phase, Phase::Playing { .. }));
        assert_eq!(g.rejoins, 1);
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
