//! Trackers follow a detector's result across frames and estimate velocity.

use std::collections::VecDeque;

use serde_json::{json, Value};

use crate::frame::{Frame, Rect};
use crate::vision::{find_color, ColorMatch, ColorQuery};

/// How far back velocity looks, in milliseconds.
const VELOCITY_WINDOW_MS: f64 = 60.0;

pub struct Tracker {
    pub id: u64,
    pub region: String,
    pub query: ColorQuery,
    /// The region in frame pixels as of the last update.
    pub rect: Rect,
    last: Option<ColorMatch>,
    last_seen: Option<f64>,
    history: VecDeque<(f64, f64, f64)>,
    velocity: (f64, f64),
}

impl Tracker {
    pub fn new(id: u64, region: String, query: ColorQuery) -> Self {
        Tracker {
            id,
            region,
            query,
            rect: Rect::default(),
            last: None,
            last_seen: None,
            history: VecDeque::new(),
            velocity: (0.0, 0.0),
        }
    }

    pub fn update(&mut self, frame: &Frame, rect: Rect, now: f64) {
        self.rect = rect;
        self.last = find_color(frame, rect, &self.query);
        let Some(m) = self.last else {
            self.history.clear();
            self.velocity = (0.0, 0.0);
            return;
        };
        self.last_seen = Some(now);
        self.history.push_back((now, m.cx, m.cy));
        while self.history.len() > 2
            && self
                .history
                .front()
                .is_some_and(|&(t, _, _)| now - t > VELOCITY_WINDOW_MS)
        {
            self.history.pop_front();
        }
        self.velocity = slope(&self.history);
    }

    pub fn seen(&self) -> bool {
        self.last.is_some()
    }

    /// The state macros read, in region fractions and region fractions per second.
    pub fn state(&self, now: f64) -> Value {
        let missing = match (self.last, self.last_seen) {
            (Some(_), _) => 0.0,
            (None, Some(t)) => now - t,
            (None, None) => now,
        };
        match self.last {
            Some(m) => json!({
                "seen": true,
                "x": m.cx, "y": m.cy,
                "left": m.left, "right": m.right, "top": m.top, "bottom": m.bottom,
                "center": (m.left + m.right) / 2.0,
                "middle": (m.top + m.bottom) / 2.0,
                "width": m.right - m.left, "height": m.bottom - m.top,
                "vx": self.velocity.0, "vy": self.velocity.1,
                "pixels": m.pixels, "coverage": m.coverage,
                "missingFor": 0.0,
            }),
            None => json!({ "seen": false, "missingFor": missing }),
        }
    }

    /// `[x, left, right]` as fractions of the region, or null, for traces.
    pub fn trace_point(&self) -> Value {
        let r = |v: f64| (v * 1000.0).round() / 1000.0;
        match self.last {
            Some(m) => json!([r(m.cx), r(m.left), r(m.right)]),
            None => Value::Null,
        }
    }

    /// Current match in frame fractions, for drawing overlays.
    pub fn overlay(&self, frame_w: usize, frame_h: usize) -> Value {
        let region = self.rect.normalized(frame_w, frame_h);
        let to_frame = |fx: f64, fy: f64| (region.x + fx * region.w, region.y + fy * region.h);
        match self.last {
            Some(m) => {
                let (x, y) = to_frame(m.cx, m.cy);
                let (left, top) = to_frame(m.left, m.top);
                let (right, bottom) = to_frame(m.right, m.bottom);
                json!({ "id": self.id, "region": self.region, "seen": true, "x": x, "y": y,
                        "left": left, "top": top, "right": right, "bottom": bottom })
            }
            None => json!({ "id": self.id, "region": self.region, "seen": false }),
        }
    }
}

/// Least-squares slope of x and y over time, per second.
fn slope(samples: &VecDeque<(f64, f64, f64)>) -> (f64, f64) {
    let n = samples.len() as f64;
    if n < 2.0 {
        return (0.0, 0.0);
    }
    let mt = samples.iter().map(|s| s.0).sum::<f64>() / n;
    let mx = samples.iter().map(|s| s.1).sum::<f64>() / n;
    let my = samples.iter().map(|s| s.2).sum::<f64>() / n;
    let (mut tt, mut tx, mut ty) = (0.0, 0.0, 0.0);
    for &(t, x, y) in samples {
        let dt = t - mt;
        tt += dt * dt;
        tx += dt * (x - mx);
        ty += dt * (y - my);
    }
    if tt <= f64::EPSILON {
        return (0.0, 0.0);
    }
    (tx / tt * 1000.0, ty / tt * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_velocity_from_motion() {
        let white = [255, 255, 255];
        let query = ColorQuery::new(white, 10, 1);
        let mut tracker = Tracker::new(1, "bar".into(), query);
        let region = Rect::new(0.0, 0.0, 100.0, 10.0);
        for i in 0..6 {
            let mut f = Frame::new(100, 10, [0, 0, 0]);
            // Moves 1 px (0.01 of the region) every 10 ms: 1.0 region per second.
            f.fill(Rect::new(20.0 + i as f64, 0.0, 2.0, 10.0), white);
            tracker.update(&f, region, i as f64 * 10.0);
        }
        let state = tracker.state(50.0);
        assert_eq!(state["seen"], true);
        assert!(
            (state["vx"].as_f64().unwrap() - 1.0).abs() < 1e-6,
            "{state}"
        );
        assert!((state["x"].as_f64().unwrap() - 0.26).abs() < 1e-9);
    }

    #[test]
    fn reports_how_long_it_has_been_missing() {
        let query = ColorQuery::new([255, 0, 0], 0, 1);
        let mut tracker = Tracker::new(1, "r".into(), query);
        let region = Rect::new(0.0, 0.0, 10.0, 10.0);
        let mut seen = Frame::new(10, 10, [0, 0, 0]);
        seen.fill(region, [255, 0, 0]);
        tracker.update(&seen, region, 100.0);
        tracker.update(&Frame::new(10, 10, [0, 0, 0]), region, 350.0);
        let state = tracker.state(350.0);
        assert_eq!(state["seen"], false);
        assert_eq!(state["missingFor"].as_f64().unwrap(), 250.0);
    }
}
