//! Named screen regions, stored relative to the game viewport.
//!
//! A region's `x` and `y` place its center relative to an anchor point on the
//! viewport, and `w` and `h` give its size. All four are fractions of the
//! viewport height, so a region keeps its shape on wide and narrow windows.

use serde::Deserialize;

use crate::frame::Rect;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct RegionSpec {
    #[serde(default = "default_anchor")]
    pub anchor: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn default_anchor() -> String {
    "center".into()
}

pub const ANCHORS: [&str; 9] = [
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
];

/// Where an anchor sits on the viewport, as fractions of its width and height.
fn anchor_point(anchor: &str) -> Option<(f64, f64)> {
    let (vertical, horizontal) = match anchor {
        "center" => ("center", "center"),
        other => other.split_once('-')?,
    };
    let fy = match vertical {
        "top" => 0.0,
        "center" => 0.5,
        "bottom" => 1.0,
        _ => return None,
    };
    let fx = match horizontal {
        "left" => 0.0,
        "center" => 0.5,
        "right" => 1.0,
        _ => return None,
    };
    Some((fx, fy))
}

impl RegionSpec {
    pub fn validate(&self, name: &str) -> Result<(), String> {
        if anchor_point(&self.anchor).is_none() {
            return Err(format!(
                "Region \"{name}\" has an unknown anchor \"{}\". Use one of: {}.",
                self.anchor,
                ANCHORS.join(", ")
            ));
        }
        if !(self.w > 0.0 && self.h > 0.0) {
            return Err(format!("Region \"{name}\" needs a positive w and h."));
        }
        Ok(())
    }

    /// The region in frame pixels, given the viewport in frame pixels.
    pub fn resolve(&self, viewport: Rect) -> Rect {
        let (fx, fy) = anchor_point(&self.anchor).unwrap_or((0.5, 0.5));
        let unit = viewport.h;
        let cx = viewport.x + viewport.w * fx + self.x * unit;
        let cy = viewport.y + viewport.h * fy + self.y * unit;
        let (w, h) = (self.w * unit, self.h * unit);
        Rect::new(cx - w / 2.0, cy - h / 2.0, w, h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(anchor: &str, x: f64, y: f64, w: f64, h: f64) -> RegionSpec {
        RegionSpec {
            anchor: anchor.into(),
            x,
            y,
            w,
            h,
        }
    }

    #[test]
    fn resolves_against_anchor_in_viewport_heights() {
        let vp = Rect::new(0.0, 0.0, 1280.0, 720.0);
        let r = spec("bottom-center", 0.0, -0.18, 0.45, 0.05).resolve(vp);
        assert!((r.x + r.w / 2.0 - 640.0).abs() < 1e-9);
        assert!((r.y + r.h / 2.0 - (720.0 - 0.18 * 720.0)).abs() < 1e-9);
        assert!((r.w - 324.0).abs() < 1e-9);
    }

    #[test]
    fn keeps_shape_when_window_gets_wider() {
        let narrow = spec("center", 0.0, 0.0, 0.2, 0.1).resolve(Rect::new(0.0, 0.0, 800.0, 600.0));
        let wide = spec("center", 0.0, 0.0, 0.2, 0.1).resolve(Rect::new(0.0, 0.0, 1600.0, 600.0));
        assert_eq!(narrow.w, wide.w);
        assert_eq!(wide.x + wide.w / 2.0, 800.0);
    }

    #[test]
    fn honors_viewport_offset() {
        let r = spec("top-left", 0.1, 0.1, 0.1, 0.1).resolve(Rect::new(10.0, 28.0, 1000.0, 500.0));
        assert!((r.x - (10.0 + 50.0 - 25.0)).abs() < 1e-9);
        assert!((r.y - (28.0 + 50.0 - 25.0)).abs() < 1e-9);
    }

    #[test]
    fn rejects_bad_specs() {
        assert!(spec("middle", 0.0, 0.0, 1.0, 1.0).validate("a").is_err());
        assert!(spec("center", 0.0, 0.0, 0.0, 1.0).validate("a").is_err());
        for anchor in ANCHORS {
            assert!(
                spec(anchor, 0.0, 0.0, 1.0, 1.0).validate("a").is_ok(),
                "{anchor}"
            );
        }
    }
}
