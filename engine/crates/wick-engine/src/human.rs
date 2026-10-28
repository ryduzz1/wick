//! The human profile: makes a macro's input look like a person's.
//!
//! Applied to every input a macro sends (not to agent tests, which need exact
//! numbers): a short reaction delay with spread, occasional slips, hold times
//! that vary, mouse moves along curved paths that slow down near the target
//! and sometimes overshoot, camera turns spread over several steps, and slow
//! drift over a long session. One `precision` value from 0 to 1 scales all
//! of it, so a tight minigame can still pass.

use serde::Deserialize;

use crate::input::Action;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct HumanProfile {
    /// 1 is nearly exact; 0 is loose and slow.
    pub precision: f64,
    pub seed: u64,
}

impl Default for HumanProfile {
    fn default() -> Self {
        HumanProfile {
            precision: 0.85,
            seed: 1,
        }
    }
}

/// xorshift64*, as in the simulator: deterministic per seed.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Standard normal, by Box–Muller.
    fn normal(&mut self) -> f64 {
        let u = self.next().max(1e-12);
        let v = self.next();
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

/// One step of a planned input, `at` ms after the input starts.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub at: f64,
    pub action: Action,
}

pub struct Humanizer {
    pub profile: HumanProfile,
    rng: Rng,
    /// When the previous input started, so inputs never swap order.
    last_start: f64,
    pub cursor: Option<(f64, f64)>,
}

/// Mouse path points are this far apart in time.
const PATH_STEP_MS: f64 = 8.0;

impl Humanizer {
    pub fn new(profile: HumanProfile) -> Self {
        let precision = profile.precision.clamp(0.0, 1.0);
        Humanizer {
            rng: Rng::new(profile.seed),
            profile: HumanProfile {
                precision,
                ..profile
            },
            last_start: f64::NEG_INFINITY,
            cursor: None,
        }
    }

    fn looseness(&self) -> f64 {
        1.0 - self.profile.precision
    }

    /// Delay before an input starts, in ms: a skewed reaction spread, slow
    /// drift over the session, and now and then a slip.
    pub fn delay(&mut self, session_ms: f64) -> f64 {
        let l = self.looseness();
        let mean = 3.0 + 35.0 * l;
        let spread = 2.0 + 25.0 * l;
        // Log-normal-ish: mostly quick, with a longer tail.
        let z = self.rng.normal();
        let mut d = mean * (0.35 * z * spread / mean.max(1.0)).exp() + 0.25 * spread * z.abs();
        // Slower over a long session: up to +20% at an hour (times looseness),
        // with a gentle wave so it isn't a straight line.
        let hours = (session_ms / 3_600_000.0).min(1.0);
        d *= 1.0 + 0.2 * l * hours + 0.05 * l * (session_ms / 420_000.0).sin();
        if self.rng.next() < 0.04 * l {
            d += 60.0 + 90.0 * self.rng.next();
        }
        d.max(0.0)
    }

    /// A hold time near the requested one.
    pub fn hold(&mut self, hold: f64) -> f64 {
        let s = 0.05 + 0.25 * self.looseness();
        (hold * (1.0 + s * self.rng.normal()))
            .max(hold.min(15.0))
            .max(1.0)
    }

    /// Cursor positions from `from` to `to`, timed from 0, ending exactly on `to`.
    pub fn path(&mut self, from: (f64, f64), to: (f64, f64)) -> Vec<Step> {
        let l = self.looseness();
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let dist = dx.hypot(dy);
        if dist < 2.0 {
            return vec![Step {
                at: 0.0,
                action: Action::MoveTo { x: to.0, y: to.1 },
            }];
        }
        // Fitts-style duration, faster when precise.
        let duration = (60.0 + 90.0 * (1.0 + dist / 30.0).log2())
            * (0.75 + 0.5 * l)
            * (1.0 + 0.1 * self.rng.normal()).max(0.6);
        // A bow to one side, and sometimes aim a little past the target first.
        let bow = dist * (0.04 + 0.12 * l) * self.rng.normal().clamp(-2.0, 2.0);
        let (nx, ny) = (-dy / dist, dx / dist);
        let overshoot = if self.rng.next() < 0.05 + 0.3 * l {
            1.0 + (0.02 + 0.05 * self.rng.next()) * (0.5 + l)
        } else {
            1.0
        };
        let aim = (from.0 + dx * overshoot, from.1 + dy * overshoot);
        let c1 = (from.0 + dx * 0.3 + nx * bow, from.1 + dy * 0.3 + ny * bow);
        let c2 = (
            from.0 + dx * 0.8 + nx * bow * 0.5,
            from.1 + dy * 0.8 + ny * bow * 0.5,
        );
        let n = (duration / PATH_STEP_MS).ceil().max(2.0) as usize;
        let mut steps = Vec::with_capacity(n + 4);
        for i in 1..=n {
            // Ease out: fast start, slow near the target.
            let u = i as f64 / n as f64;
            let t = 1.0 - (1.0 - u).powi(3);
            let mt = 1.0 - t;
            let x = mt.powi(3) * from.0
                + 3.0 * mt * mt * t * c1.0
                + 3.0 * mt * t * t * c2.0
                + t.powi(3) * aim.0;
            let y = mt.powi(3) * from.1
                + 3.0 * mt * mt * t * c1.1
                + 3.0 * mt * t * t * c2.1
                + t.powi(3) * aim.1;
            steps.push(Step {
                at: u * duration,
                action: Action::MoveTo { x, y },
            });
        }
        if overshoot > 1.0 {
            // A short correction back onto the target.
            let back = 40.0 + 60.0 * l;
            for k in 1..=3 {
                let u = f64::from(k) / 3.0;
                let x = aim.0 + (to.0 - aim.0) * u;
                let y = aim.1 + (to.1 - aim.1) * u;
                steps.push(Step {
                    at: duration + back * u,
                    action: Action::MoveTo { x, y },
                });
            }
        } else if let Some(last) = steps.last_mut() {
            last.action = Action::MoveTo { x: to.0, y: to.1 };
        }
        steps
    }

    /// A camera turn split into eased steps that add up to the same total.
    pub fn turn(&mut self, dx: f64, dy: f64) -> Vec<Step> {
        let n = ((dx.hypot(dy) / 40.0).ceil() as usize).clamp(1, 12);
        let mut steps = Vec::with_capacity(n);
        let (mut sx, mut sy) = (0.0, 0.0);
        let weights: Vec<f64> = (0..n)
            .map(|i| {
                let u = (i as f64 + 0.5) / n as f64;
                (std::f64::consts::PI * u).sin()
                    * (1.0 + 0.15 * self.looseness() * self.rng.normal()).max(0.2)
            })
            .collect();
        let total: f64 = weights.iter().sum();
        for (i, w) in weights.iter().enumerate() {
            let (px, py) = if i + 1 == n {
                (dx - sx, dy - sy)
            } else {
                (dx * w / total, dy * w / total)
            };
            sx += px;
            sy += py;
            steps.push(Step {
                at: i as f64 * PATH_STEP_MS,
                action: Action::Turn { dx: px, dy: py },
            });
        }
        steps
    }

    /// Turns an exact plan into a human one starting at or after `now`.
    /// `plan` steps are relative to the start; positive offsets on button and
    /// key releases are holds.
    pub fn apply(&mut self, plan: Vec<Step>, now: f64, session_ms: f64) -> Vec<(f64, Action)> {
        let start = (now + self.delay(session_ms)).max(self.last_start + 1.0);
        self.last_start = start;
        let mut out = Vec::new();
        let mut shift = 0.0;
        for step in plan {
            match step.action {
                Action::MoveTo { x, y } => {
                    let from = self.cursor.unwrap_or((x, y));
                    let path = self.path(from, (x, y));
                    let end = path.last().map_or(0.0, |s| s.at);
                    for s in path {
                        out.push((start + shift + step.at + s.at, s.action));
                    }
                    // A short settle before pressing on arrival.
                    shift += end
                        + if end > 0.0 {
                            10.0 + 30.0 * self.looseness() * self.rng.next()
                        } else {
                            0.0
                        };
                    self.cursor = Some((x, y));
                }
                Action::Turn { dx, dy } => {
                    for s in self.turn(dx, dy) {
                        out.push((start + shift + step.at + s.at, s.action));
                    }
                }
                ref release @ (Action::Button { down: false, .. }
                | Action::Key { down: false, .. })
                    if step.at > 0.0 =>
                {
                    let hold = self.hold(step.at);
                    out.push((start + shift + hold, release.clone()));
                }
                other => out.push((start + shift + step.at, other)),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wick_platform::MouseButton;

    fn human(precision: f64) -> Humanizer {
        Humanizer::new(HumanProfile { precision, seed: 7 })
    }

    fn stats(v: &[f64]) -> (f64, f64) {
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / v.len() as f64;
        (mean, var.sqrt())
    }

    #[test]
    fn delays_grow_as_precision_drops() {
        let sample = |p: f64| {
            let mut h = human(p);
            stats(&(0..4000).map(|_| h.delay(0.0)).collect::<Vec<_>>())
        };
        let (tight, tight_sd) = sample(1.0);
        let (normal, normal_sd) = sample(0.85);
        let (loose, loose_sd) = sample(0.3);
        assert!(
            tight < 5.0 && tight_sd < 3.0,
            "precision 1: {tight} ± {tight_sd}"
        );
        assert!(
            (6.0..20.0).contains(&normal),
            "precision 0.85: {normal} ± {normal_sd}"
        );
        assert!(
            loose > normal * 1.8 && loose_sd > normal_sd,
            "precision 0.3: {loose} ± {loose_sd}"
        );
        let mut h = human(0.85);
        assert!((0..4000).all(|_| h.delay(0.0) >= 0.0));
    }

    #[test]
    fn sessions_slow_down_slightly() {
        let mean_at = |ms: f64| {
            let mut h = human(0.5);
            stats(&(0..4000).map(|_| h.delay(ms)).collect::<Vec<_>>()).0
        };
        let (fresh, tired) = (mean_at(0.0), mean_at(3_600_000.0));
        assert!(
            tired > fresh * 1.03 && tired < fresh * 1.2,
            "{fresh} → {tired}"
        );
    }

    #[test]
    fn holds_vary_around_the_request() {
        let mut h = human(0.85);
        let holds: Vec<f64> = (0..4000).map(|_| h.hold(40.0)).collect();
        let (mean, sd) = stats(&holds);
        assert!((mean - 40.0).abs() < 1.0, "{mean}");
        assert!((2.0..6.0).contains(&sd), "{sd}");
        assert!(holds.iter().all(|&x| x >= 15.0));
    }

    #[test]
    fn paths_curve_and_end_on_target() {
        let mut h = human(0.6);
        let (mut curved, mut overshot) = (0, 0);
        for _ in 0..200 {
            let path = h.path((0.0, 0.0), (300.0, 0.0));
            let Action::MoveTo { x, y } = path.last().unwrap().action else {
                panic!()
            };
            assert!((x - 300.0).abs() < 1e-9 && y.abs() < 1e-9, "ends on target");
            assert!(
                path.windows(2).all(|w| w[1].at > w[0].at),
                "time moves forward"
            );
            let off_line = path
                .iter()
                .any(|s| matches!(s.action, Action::MoveTo { y, .. } if y.abs() > 3.0));
            let past = path
                .iter()
                .any(|s| matches!(s.action, Action::MoveTo { x, .. } if x > 302.0));
            curved += usize::from(off_line);
            overshot += usize::from(past);
            let duration = path.last().unwrap().at;
            assert!((80.0..1200.0).contains(&duration), "{duration}");
        }
        assert!(curved > 120, "curved {curved}/200");
        assert!((10..120).contains(&overshot), "overshot {overshot}/200");
    }

    #[test]
    fn turns_add_up_exactly() {
        let mut h = human(0.5);
        let steps = h.turn(250.0, -40.0);
        assert!(steps.len() > 3);
        let (sx, sy) = steps.iter().fold((0.0, 0.0), |(x, y), s| match s.action {
            Action::Turn { dx, dy } => (x + dx, y + dy),
            _ => panic!(),
        });
        assert!((sx - 250.0).abs() < 1e-9 && (sy + 40.0).abs() < 1e-9);
    }

    #[test]
    fn inputs_keep_their_order() {
        let mut h = human(0.2);
        let press = |down| Step {
            at: 0.0,
            action: Action::Button {
                button: MouseButton::Left,
                down,
            },
        };
        let mut times = Vec::new();
        for i in 0..500 {
            let now = f64::from(i) * 2.0;
            let down = i % 2 == 0;
            for (t, _) in h.apply(vec![press(down)], now, now) {
                times.push(t);
            }
        }
        assert!(
            times.windows(2).all(|w| w[1] > w[0]),
            "a release never lands before its press"
        );
    }

    #[test]
    fn a_click_moves_then_presses_then_releases() {
        let mut h = human(0.85);
        h.cursor = Some((0.0, 0.0));
        let plan = vec![
            Step {
                at: 0.0,
                action: Action::MoveTo { x: 200.0, y: 100.0 },
            },
            Step {
                at: 0.0,
                action: Action::Button {
                    button: MouseButton::Left,
                    down: true,
                },
            },
            Step {
                at: 30.0,
                action: Action::Button {
                    button: MouseButton::Left,
                    down: false,
                },
            },
        ];
        let out = h.apply(plan, 1000.0, 0.0);
        let down = out
            .iter()
            .position(|(_, a)| matches!(a, Action::Button { down: true, .. }))
            .unwrap();
        let up = out
            .iter()
            .position(|(_, a)| matches!(a, Action::Button { down: false, .. }))
            .unwrap();
        let last_move = out
            .iter()
            .rposition(|(_, a)| matches!(a, Action::MoveTo { .. }))
            .unwrap();
        assert!(
            last_move < down && out[last_move].0 < out[down].0,
            "arrives before pressing"
        );
        assert!(out[up].0 > out[down].0 + 15.0, "holds");
        assert!(out[0].0 >= 1000.0);
    }
}
