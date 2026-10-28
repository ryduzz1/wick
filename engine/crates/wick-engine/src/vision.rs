//! Detectors that run on a region of a frame.

use crate::frame::{Frame, Rect};

/// Parses `#rrggbb` or `rrggbb`.
pub fn parse_color(text: &str) -> Result<[u8; 3], String> {
    let hex = text.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("\"{text}\" isn't a color. Use the form #3ccf5a."));
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
    Ok([byte(0), byte(2), byte(4)])
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColorQuery {
    pub rgb: [u8; 3],
    /// Largest allowed difference on any one channel.
    pub tolerance: u8,
    pub min_pixels: usize,
    /// When not empty, matches every pixel that isn't within `tolerance` of
    /// any of these instead, and `rgb` is ignored. For a shape whose color
    /// changes but whose surroundings don't.
    pub except: Vec<[u8; 3]>,
}

impl ColorQuery {
    pub fn new(rgb: [u8; 3], tolerance: u8, min_pixels: usize) -> Self {
        ColorQuery {
            rgb,
            tolerance,
            min_pixels,
            except: Vec::new(),
        }
    }

    pub fn matches(&self, [r, g, b]: [u8; 3]) -> bool {
        let tol = i16::from(self.tolerance);
        let near = |c: &[u8; 3]| {
            (i16::from(r) - i16::from(c[0])).abs() <= tol
                && (i16::from(g) - i16::from(c[1])).abs() <= tol
                && (i16::from(b) - i16::from(c[2])).abs() <= tol
        };
        if self.except.is_empty() {
            near(&self.rgb)
        } else {
            !self.except.iter().any(near)
        }
    }

    /// `#rrggbb`, or `not #rrggbb #rrggbb` for an `except` query.
    pub fn label(&self) -> String {
        let hex = |[r, g, b]: [u8; 3]| format!("#{r:02x}{g:02x}{b:02x}");
        if self.except.is_empty() {
            hex(self.rgb)
        } else {
            let list: Vec<String> = self.except.iter().map(|&c| hex(c)).collect();
            format!("not {}", list.join(" "))
        }
    }
}

/// Where matching pixels were found, as fractions of the region (0 at the
/// left or top edge, 1 at the right or bottom edge).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorMatch {
    pub pixels: usize,
    /// Fraction of the region's pixels that matched.
    pub coverage: f64,
    pub cx: f64,
    pub cy: f64,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// Finds pixels within `tolerance` of a color inside `region`.
///
/// Reports the bounding box and centroid of every match together, so a shape
/// split in two by something drawn over it (a marker crossing a bar) still
/// reports its full extent.
pub fn find_color(frame: &Frame, region: Rect, q: &ColorQuery) -> Option<ColorMatch> {
    let (x0, y0, x1, y1) = region.pixel_bounds(frame.width, frame.height);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (mut count, mut sx, mut sy) = (0usize, 0f64, 0f64);
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (usize::MAX, 0, usize::MAX, 0);
    for y in y0..y1 {
        let row = &frame.data[y * frame.stride..];
        for x in x0..x1 {
            let i = x * 4;
            if q.matches([row[i + 2], row[i + 1], row[i]]) {
                count += 1;
                sx += x as f64;
                sy += y as f64;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }
    if count < q.min_pixels.max(1) {
        return None;
    }
    let nx = |px: f64| (px - region.x) / region.w;
    let ny = |py: f64| (py - region.y) / region.h;
    let n = count as f64;
    Some(ColorMatch {
        pixels: count,
        coverage: n / ((x1 - x0) * (y1 - y0)) as f64,
        cx: nx(sx / n + 0.5),
        cy: ny(sy / n + 0.5),
        left: nx(min_x as f64),
        right: nx(max_x as f64 + 1.0),
        top: ny(min_y as f64),
        bottom: ny(max_y as f64 + 1.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GREEN: [u8; 3] = [0x3c, 0xcf, 0x5a];

    fn query(rgb: [u8; 3]) -> ColorQuery {
        ColorQuery::new(rgb, 20, 3)
    }

    #[test]
    fn parses_colors() {
        assert_eq!(parse_color("#3ccf5a").unwrap(), GREEN);
        assert_eq!(parse_color("FFFFFF").unwrap(), [255, 255, 255]);
        assert!(parse_color("green").is_err());
        assert!(parse_color("#fff").is_err());
    }

    #[test]
    fn finds_extent_and_center() {
        let mut f = Frame::new(200, 100, [20, 20, 20]);
        f.fill(Rect::new(50.0, 40.0, 20.0, 10.0), GREEN);
        let region = Rect::new(0.0, 0.0, 200.0, 100.0);
        let m = find_color(&f, region, &query(GREEN)).unwrap();
        assert_eq!(m.pixels, 200);
        assert!((m.left - 0.25).abs() < 1e-9);
        assert!((m.right - 0.35).abs() < 1e-9);
        assert!((m.cx - 0.30).abs() < 1e-9);
        assert!((m.cy - 0.45).abs() < 1e-9);
    }

    #[test]
    fn keeps_full_extent_when_split() {
        let mut f = Frame::new(100, 10, [0, 0, 0]);
        f.fill(Rect::new(10.0, 0.0, 30.0, 10.0), GREEN);
        f.fill(Rect::new(24.0, 0.0, 2.0, 10.0), [255, 255, 255]);
        let m = find_color(&f, Rect::new(0.0, 0.0, 100.0, 10.0), &query(GREEN)).unwrap();
        assert!((m.left - 0.10).abs() < 1e-9);
        assert!((m.right - 0.40).abs() < 1e-9);
    }

    #[test]
    fn respects_tolerance_and_minimum() {
        let mut f = Frame::new(50, 50, [0, 0, 0]);
        f.fill(
            Rect::new(0.0, 0.0, 10.0, 10.0),
            [0x3c + 15, 0xcf - 15, 0x5a],
        );
        let region = Rect::new(0.0, 0.0, 50.0, 50.0);
        assert!(find_color(&f, region, &query(GREEN)).is_some());
        assert!(find_color(
            &f,
            region,
            &ColorQuery {
                tolerance: 10,
                ..query(GREEN)
            }
        )
        .is_none());
        assert!(find_color(
            &f,
            region,
            &ColorQuery {
                min_pixels: 101,
                ..query(GREEN)
            }
        )
        .is_none());
    }

    #[test]
    fn except_finds_whatever_else_is_there() {
        // A dark bar, a blue fill from the left, and a zone of some other color.
        let (dark, blue) = ([14, 24, 18], [37, 101, 171]);
        let mut f = Frame::new(100, 10, dark);
        f.fill(Rect::new(0.0, 0.0, 40.0, 10.0), blue);
        f.fill(Rect::new(30.0, 0.0, 20.0, 10.0), [146, 76, 184]);
        let q = ColorQuery {
            except: vec![dark, blue],
            ..query([0, 0, 0])
        };
        let m = find_color(&f, Rect::new(0.0, 0.0, 100.0, 10.0), &q).unwrap();
        assert!((m.left - 0.30).abs() < 1e-9);
        assert!((m.right - 0.50).abs() < 1e-9);
        assert_eq!(q.label(), "not #0e1812 #2565ab");
        assert!(find_color(
            &Frame::new(100, 10, dark),
            Rect::new(0.0, 0.0, 100.0, 10.0),
            &q
        )
        .is_none());
    }

    #[test]
    fn only_looks_inside_region() {
        let mut f = Frame::new(100, 100, [0, 0, 0]);
        f.fill(Rect::new(80.0, 80.0, 10.0, 10.0), GREEN);
        assert!(find_color(&f, Rect::new(0.0, 0.0, 50.0, 50.0), &query(GREEN)).is_none());
        assert!(find_color(&f, Rect::new(-10.0, -10.0, 0.0, 0.0), &query(GREEN)).is_none());
    }
}
