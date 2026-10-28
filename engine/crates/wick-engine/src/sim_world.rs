//! A small top-down world around the sim's bar minigame, for testing macros
//! that walk somewhere, interact, and loop: the fishing-trip shape of
//! "fish until the bag is full, walk to the vendor, sell, walk back".
//!
//! The character starts at the spawn facing up. W and S move along the
//! heading, A and D strafe, and mouse turns rotate the heading (like a
//! game's camera). Near the dock, E casts and a bar round plays; a won round
//! puts a fish in the bag, shown as slots in the HUD. Near the vendor, E
//! opens a sell menu: clicking its button sells the bag, Escape closes it.
//! A reset puts the character back at the spawn.
//!
//! Positions are in viewport heights from the top-left, so the world is
//! about 1.78 wide and 1 tall at 16:9.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::frame::{Frame, Rect};
use crate::sim::{BarGame, Phase, DIALOG, DIALOG_BUTTON, HUD, PROMPT};

pub const GROUND: [u8; 3] = [48, 66, 50];
pub const WATER: [u8; 3] = [38, 74, 120];
pub const DOCK: [u8; 3] = [116, 88, 60];
pub const VENDOR: [u8; 3] = [150, 72, 72];
pub const PLAYER: [u8; 3] = [255, 140, 60];
pub const NOSE: [u8; 3] = [30, 30, 30];
pub const SLOT: [u8; 3] = [40, 44, 52];
pub const FISH: [u8; 3] = [110, 190, 220];
pub const SELL_BUTTON: [u8; 3] = [86, 180, 110];

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorldSpec {
    /// Fish the bag holds.
    pub bag: u32,
    /// Walking speed, in viewport heights per second.
    pub speed: f64,
    /// Radians of heading per pixel of mouse turn.
    pub turn_rate: f64,
    pub spawn: [f64; 2],
    pub dock: [f64; 2],
    pub vendor: [f64; 2],
    /// How close counts as being at the dock or vendor.
    pub reach: f64,
    pub price: u32,
}

impl Default for WorldSpec {
    fn default() -> Self {
        WorldSpec {
            bag: 5,
            speed: 0.3,
            turn_rate: 0.004,
            spawn: [0.89, 0.62],
            dock: [0.89, 0.22],
            vendor: [1.45, 0.62],
            reach: 0.08,
            price: 10,
        }
    }
}

pub struct World {
    pub spec: WorldSpec,
    pub x: f64,
    pub y: f64,
    /// Radians clockwise from up.
    pub heading: f64,
    pub bag: u32,
    pub menu: bool,
    pub caught: u32,
    pub sold: u32,
    pub sales: u32,
    pub coins: u32,
    pub walked: f64,
    held: Vec<String>,
    won: u32,
    resetting: bool,
}

impl World {
    pub fn new(spec: WorldSpec) -> Self {
        World {
            x: spec.spawn[0],
            y: spec.spawn[1],
            heading: 0.0,
            bag: 0,
            menu: false,
            caught: 0,
            sold: 0,
            sales: 0,
            coins: 0,
            walked: 0.0,
            held: Vec::new(),
            won: 0,
            resetting: false,
            spec,
        }
    }

    fn near(&self, p: [f64; 2]) -> bool {
        (self.x - p[0]).hypot(self.y - p[1]) <= self.spec.reach
    }

    pub fn at_dock(&self) -> bool {
        self.near(self.spec.dock)
    }

    pub fn at_vendor(&self) -> bool {
        self.near(self.spec.vendor)
    }

    /// Whether the character can move and interact.
    fn free(&self, game: &BarGame) -> bool {
        game.phase == Phase::Idle && !self.menu
    }

    pub fn key(&mut self, game: &mut BarGame, name: &str, down: bool) {
        if !down {
            self.held.retain(|k| k != name);
            return;
        }
        if !self.held.iter().any(|k| k == name) {
            self.held.push(name.to_string());
        }
        match name {
            "e" if self.free(game) && self.at_dock() && self.bag < self.spec.bag => game.cast(),
            "e" if self.free(game) && self.at_vendor() => self.menu = true,
            "escape" => self.menu = false,
            _ => {}
        }
    }

    pub fn turn(&mut self, game: &BarGame, dx: f64) {
        if self.free(game) {
            self.heading += dx * self.spec.turn_rate;
        }
    }

    /// The sell button, in frame pixels.
    pub fn sell_button(width: usize, height: usize) -> Rect {
        let (w, h) = (width as f64, height as f64);
        Rect::new(w / 2.0 - 0.12 * h, h / 2.0 + 0.06 * h, 0.24 * h, 0.08 * h)
    }

    /// A click at frame pixel `at`. Returns true if the world used it.
    pub fn click(&mut self, at: Option<(f64, f64)>, width: usize, height: usize) -> bool {
        if !self.menu {
            return false;
        }
        let b = Self::sell_button(width, height);
        if let Some((x, y)) = at {
            if x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h && self.bag > 0 {
                self.coins += self.bag * self.spec.price;
                self.sold += self.bag;
                self.sales += 1;
                self.bag = 0;
            }
        }
        true
    }

    pub fn reset(&mut self, game: &mut BarGame) {
        let before = game.resets;
        game.reset();
        if game.resets > before {
            self.resetting = true;
        }
    }

    pub fn step(&mut self, game: &mut BarGame, dt: f64, aspect: f64) {
        game.step(dt);
        if game.rounds_won > self.won {
            self.won = game.rounds_won;
            if self.bag < self.spec.bag {
                self.bag += 1;
                self.caught += 1;
            }
        }
        if self.resetting && matches!(game.phase, Phase::Resetting { .. }) {
            // Back at the spawn while the screen is dark.
            self.x = self.spec.spawn[0];
            self.y = self.spec.spawn[1];
            self.heading = 0.0;
            self.menu = false;
            self.resetting = false;
        }
        if !self.free(game) {
            return;
        }
        let held = |k: &str| self.held.iter().any(|h| h == k);
        let forward = f64::from(u8::from(held("w"))) - f64::from(u8::from(held("s")));
        let side = f64::from(u8::from(held("d"))) - f64::from(u8::from(held("a")));
        if forward == 0.0 && side == 0.0 {
            return;
        }
        let len = forward.hypot(side);
        let (sin, cos) = self.heading.sin_cos();
        // Up is -y; right of the heading is (cos, sin).
        let vx = (forward * sin + side * cos) / len;
        let vy = (-forward * cos + side * sin) / len;
        let d = self.spec.speed * dt;
        let (nx, ny) = (
            (self.x + vx * d).clamp(0.02, aspect - 0.02),
            (self.y + vy * d).clamp(0.17, 0.98),
        );
        self.walked += (nx - self.x).hypot(ny - self.y);
        (self.x, self.y) = (nx, ny);
    }

    pub fn render(&self, game: &BarGame, frame: &mut Frame) {
        let (w, h) = (frame.width as f64, frame.height as f64);
        let all = Rect::new(0.0, 0.0, w, h);
        match game.phase {
            Phase::Rejoining { .. } => return frame.fill(all, [8, 8, 10]),
            Phase::Resetting { .. } => return frame.fill(all, [14, 15, 18]),
            _ => {}
        }
        let px = |v: f64| v * h;
        frame.fill(all, GROUND);
        frame.fill(Rect::new(0.0, 0.0, w, px(0.16)), WATER);
        let [dx, dy] = self.spec.dock;
        frame.fill(
            Rect::new(px(dx - 0.04), px(0.1), px(0.08), px(dy - 0.1 + 0.03)),
            DOCK,
        );
        let [vx, vy] = self.spec.vendor;
        frame.fill(
            Rect::new(px(vx - 0.035), px(vy - 0.035 - 0.05), px(0.07), px(0.07)),
            VENDOR,
        );

        // The character, with a dark nose showing the heading.
        let size = 0.04;
        frame.fill(
            Rect::new(
                px(self.x - size / 2.0),
                px(self.y - size / 2.0),
                px(size),
                px(size),
            ),
            PLAYER,
        );
        let (sin, cos) = self.heading.sin_cos();
        let (nx, ny) = (self.x + sin * size * 0.35, self.y - cos * size * 0.35);
        frame.fill(
            Rect::new(px(nx - 0.006), px(ny - 0.006), px(0.012), px(0.012)),
            NOSE,
        );

        // The bag, bottom left.
        let slot = 0.04;
        let gap = 0.01;
        let n = self.spec.bag as f64;
        frame.fill(
            Rect::new(
                px(0.03),
                h - px(0.09),
                px(n * (slot + gap) + gap),
                px(slot + 2.0 * gap),
            ),
            HUD,
        );
        for i in 0..self.spec.bag {
            let x = 0.03 + gap + i as f64 * (slot + gap);
            let color = if i < self.bag { FISH } else { SLOT };
            frame.fill(
                Rect::new(px(x), h - px(0.09 - gap), px(slot), px(slot)),
                color,
            );
        }

        match game.phase {
            Phase::Playing { .. } => game.render_bar(frame),
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
            Phase::Idle if self.menu => {
                let (mw, mh) = (0.7 * h, 0.4 * h);
                frame.fill(
                    Rect::new(w / 2.0 - mw / 2.0, h / 2.0 - mh / 2.0, mw, mh),
                    DIALOG,
                );
                // What's for sale: one slot per fish in the bag.
                for i in 0..self.bag {
                    let x = w / 2.0 - mw / 2.0 + 0.04 * h + i as f64 * 0.06 * h;
                    frame.fill(Rect::new(x, h / 2.0 - 0.12 * h, 0.05 * h, 0.05 * h), FISH);
                }
                frame.fill(Self::sell_button(frame.width, frame.height), SELL_BUTTON);
            }
            Phase::Idle if self.at_dock() || self.at_vendor() => frame.fill(
                Rect::new(w / 2.0 - 0.03 * h, 0.08 * h, 0.06 * h, 0.06 * h),
                PROMPT,
            ),
            _ => {}
        }
    }

    pub fn score(&self) -> Value {
        json!({
            "bag": self.bag,
            "caught": self.caught,
            "sold": self.sold,
            "sales": self.sales,
            "coins": self.coins,
            "at": [(self.x * 1000.0).round() / 1000.0, (self.y * 1000.0).round() / 1000.0],
            "heading": (self.heading.to_degrees() * 10.0).round() / 10.0,
            "walked": (self.walked * 1000.0).round() / 1000.0,
            "menu": self.menu,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::Scenario;

    const DT: f64 = 1.0 / 120.0;
    const ASPECT: f64 = 960.0 / 540.0;

    fn setup() -> (World, BarGame) {
        let game = BarGame::new(Scenario {
            round_ms: 2000.0,
            win_share: 0.0,
            ..Scenario::default()
        });
        (World::new(WorldSpec::default()), game)
    }

    fn run(w: &mut World, g: &mut BarGame, seconds: f64) {
        for _ in 0..(seconds * 120.0).round() as usize {
            w.step(g, DT, ASPECT);
        }
    }

    fn hold(w: &mut World, g: &mut BarGame, key: &str, seconds: f64) {
        w.key(g, key, true);
        run(w, g, seconds);
        w.key(g, key, false);
    }

    #[test]
    fn walks_along_the_heading() {
        let (mut w, mut g) = setup();
        hold(&mut w, &mut g, "w", 1.0);
        assert!((w.y - (0.62 - 0.3)).abs() < 0.01, "{}", w.y);
        assert!((w.x - 0.89).abs() < 1e-9);
        // A quarter turn right, then forward goes right.
        w.turn(&g, std::f64::consts::FRAC_PI_2 / 0.004);
        hold(&mut w, &mut g, "w", 0.5);
        assert!((w.x - (0.89 + 0.15)).abs() < 0.01, "{}", w.x);
    }

    #[test]
    fn fishes_fills_the_bag_and_sells() {
        let (mut w, mut g) = setup();
        hold(&mut w, &mut g, "w", 4.0 / 3.0);
        assert!(w.at_dock(), "{:?}", (w.x, w.y));
        for round in 1..=6 {
            w.key(&mut g, "e", true);
            w.key(&mut g, "e", false);
            run(&mut w, &mut g, 3.0);
            assert_eq!(w.bag, round.min(5), "round {round}");
        }
        assert_eq!(g.rounds_started, 5, "a full bag doesn't cast");
        // Walk to the vendor: back down, then strafe right.
        hold(&mut w, &mut g, "s", 4.0 / 3.0);
        hold(&mut w, &mut g, "d", (1.45 - 0.89) / 0.3);
        assert!(w.at_vendor(), "{:?}", (w.x, w.y));
        w.key(&mut g, "e", true);
        assert!(w.menu);
        let mut f = Frame::new(960, 540, GROUND);
        w.render(&g, &mut f);
        let b = World::sell_button(960, 540);
        assert_eq!(
            f.rgb((b.x + b.w / 2.0) as usize, (b.y + b.h / 2.0) as usize),
            SELL_BUTTON
        );
        hold(&mut w, &mut g, "d", 0.5);
        assert!(w.at_vendor(), "no walking with the menu open");
        w.click(Some((b.x + 5.0, b.y + 5.0)), 960, 540);
        assert_eq!((w.bag, w.sold, w.coins), (0, 5, 50));
        w.key(&mut g, "escape", true);
        assert!(!w.menu);
    }

    #[test]
    fn reset_goes_back_to_the_spawn() {
        let (mut w, mut g) = setup();
        hold(&mut w, &mut g, "d", 1.0);
        w.reset(&mut g);
        run(&mut w, &mut g, 0.1);
        assert_eq!((w.x, w.y), (0.89, 0.62));
        run(&mut w, &mut g, 1.5);
        assert_eq!(g.phase, Phase::Idle);
    }

    #[test]
    fn draws_the_prompt_near_the_dock() {
        let (mut w, mut g) = setup();
        let mut f = Frame::new(960, 540, GROUND);
        w.render(&g, &mut f);
        assert_ne!(f.rgb(480, (0.11 * 540.0) as usize), PROMPT);
        hold(&mut w, &mut g, "w", 4.0 / 3.0);
        w.render(&g, &mut f);
        assert_eq!(f.rgb(480, (0.11 * 540.0) as usize), PROMPT);
    }
}
