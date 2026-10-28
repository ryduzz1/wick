//! Template matching: finding a saved image (a button, an icon, a fish) in
//! a region of the frame, for things a single color can't pick out.
//!
//! Matching is normalized cross-correlation on grayscale, so it ignores
//! overall brightness and contrast. Templates are saved with the viewport
//! height they were captured at and scaled to the current one, since Roblox
//! UI scales with the window. The search runs on a downscaled copy first,
//! then refines the best few spots at full size.

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::frame::{Frame, Rect};

/// A template as macros ship it: a PNG and the viewport height it was saved at.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSpec {
    /// Base64 PNG.
    pub png: String,
    pub viewport_height: f64,
}

/// A grayscale image.
#[derive(Clone, Debug)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

impl Gray {
    pub fn from_frame(frame: &Frame, rect: Rect) -> Gray {
        let (x0, y0, x1, y1) = rect.pixel_bounds(frame.width, frame.height);
        let (w, h) = (x1.saturating_sub(x0), y1.saturating_sub(y0));
        let mut data = Vec::with_capacity(w * h);
        for y in y0..y1 {
            for x in x0..x1 {
                let [r, g, b] = frame.rgb(x, y);
                data.push(0.299 * f32::from(r) + 0.587 * f32::from(g) + 0.114 * f32::from(b));
            }
        }
        Gray { w, h, data }
    }

    /// Resized to `w` × `h` by averaging (shrinking) or bilinear (growing).
    pub fn resized(&self, w: usize, h: usize) -> Gray {
        let (w, h) = (w.max(1), h.max(1));
        let mut data = Vec::with_capacity(w * h);
        let (sx, sy) = (self.w as f32 / w as f32, self.h as f32 / h as f32);
        for y in 0..h {
            for x in 0..w {
                if sx >= 1.0 && sy >= 1.0 {
                    let (ax, bx) = (
                        (x as f32 * sx) as usize,
                        (((x + 1) as f32 * sx) as usize).min(self.w),
                    );
                    let (ay, by) = (
                        (y as f32 * sy) as usize,
                        (((y + 1) as f32 * sy) as usize).min(self.h),
                    );
                    let (bx, by) = (bx.max(ax + 1), by.max(ay + 1));
                    let mut sum = 0.0;
                    for yy in ay..by {
                        for xx in ax..bx {
                            sum += self.data[yy * self.w + xx];
                        }
                    }
                    data.push(sum / ((bx - ax) * (by - ay)) as f32);
                } else {
                    let fx = ((x as f32 + 0.5) * sx - 0.5).clamp(0.0, (self.w - 1) as f32);
                    let fy = ((y as f32 + 0.5) * sy - 0.5).clamp(0.0, (self.h - 1) as f32);
                    let (x0, y0) = (fx as usize, fy as usize);
                    let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
                    let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
                    let p = |x: usize, y: usize| self.data[y * self.w + x];
                    let top = p(x0, y0) * (1.0 - tx) + p(x1, y0) * tx;
                    let bottom = p(x0, y1) * (1.0 - tx) + p(x1, y1) * tx;
                    data.push(top * (1.0 - ty) + bottom * ty);
                }
            }
        }
        Gray { w, h, data }
    }
}

/// A template ready to search with.
#[derive(Clone, Debug)]
pub struct Template {
    pub image: Gray,
    pub viewport_height: f64,
}

impl Template {
    pub fn decode(spec: &TemplateSpec) -> Result<Template, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&spec.png)
            .map_err(|e| format!("Template isn't valid base64: {e}"))?;
        let frame = Frame::decode_png(&bytes)?;
        Ok(Template::new(&frame, spec.viewport_height))
    }

    pub fn new(frame: &Frame, viewport_height: f64) -> Template {
        let all = Rect::new(0.0, 0.0, frame.width as f64, frame.height as f64);
        Template {
            image: Gray::from_frame(frame, all),
            viewport_height: viewport_height.max(1.0),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    /// 0 to 1: how well the best spot matches.
    pub score: f64,
    /// The match's center and size, as fractions of the region.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Found {
    pub fn json(&self) -> Value {
        let r = |v: f64| (v * 10000.0).round() / 10000.0;
        json!({ "score": r(self.score), "x": r(self.x), "y": r(self.y), "width": r(self.w), "height": r(self.h) })
    }
}

/// Summed-area tables for window sums of values and squares.
struct Integral {
    w: usize,
    sum: Vec<f64>,
    sq: Vec<f64>,
}

impl Integral {
    fn new(g: &Gray) -> Integral {
        let w = g.w + 1;
        let mut sum = vec![0.0; w * (g.h + 1)];
        let mut sq = vec![0.0; w * (g.h + 1)];
        for y in 0..g.h {
            let (mut row, mut row_sq) = (0.0, 0.0);
            for x in 0..g.w {
                let v = f64::from(g.data[y * g.w + x]);
                row += v;
                row_sq += v * v;
                sum[(y + 1) * w + x + 1] = sum[y * w + x + 1] + row;
                sq[(y + 1) * w + x + 1] = sq[y * w + x + 1] + row_sq;
            }
        }
        Integral { w, sum, sq }
    }

    fn window(&self, table: &[f64], x: usize, y: usize, tw: usize, th: usize) -> f64 {
        let w = self.w;
        table[(y + th) * w + x + tw] - table[y * w + x + tw] - table[(y + th) * w + x]
            + table[y * w + x]
    }
}

/// A template with its mean taken out, for correlation.
struct Prepared {
    w: usize,
    h: usize,
    zero_mean: Vec<f64>,
    norm: f64,
    mean: f64,
}

impl Prepared {
    fn new(t: &Gray) -> Prepared {
        let n = (t.w * t.h).max(1) as f64;
        let mean = t.data.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
        let zero_mean: Vec<f64> = t.data.iter().map(|&v| f64::from(v) - mean).collect();
        let norm = zero_mean.iter().map(|v| v * v).sum::<f64>().sqrt();
        Prepared {
            w: t.w,
            h: t.h,
            zero_mean,
            norm,
            mean,
        }
    }

    /// Correlation at one spot, 0 to 1 (negative correlation counts as 0).
    fn score(&self, img: &Gray, ii: &Integral, x: usize, y: usize) -> f64 {
        let n = (self.w * self.h) as f64;
        let s = ii.window(&ii.sum, x, y, self.w, self.h);
        let sq = ii.window(&ii.sq, x, y, self.w, self.h);
        let var = (sq - s * s / n).max(0.0);
        // Flat template or flat window: compare brightness instead.
        if self.norm < 1e-3 * n.sqrt() || var < 1e-3 * n {
            if self.norm < 1e-3 * n.sqrt() && var < 1e-3 * n {
                return 1.0 - ((s / n - self.mean).abs() / 255.0).min(1.0);
            }
            return 0.0;
        }
        let mut dot = 0.0;
        for ty in 0..self.h {
            let row = &img.data[(y + ty) * img.w + x..(y + ty) * img.w + x + self.w];
            let trow = &self.zero_mean[ty * self.w..(ty + 1) * self.w];
            for (a, b) in row.iter().zip(trow) {
                dot += f64::from(*a) * b;
            }
        }
        (dot / (var.sqrt() * self.norm)).clamp(0.0, 1.0)
    }
}

/// Finds the template's best match in `rect` of `frame`, at the scale for a
/// viewport `viewport_height` pixels tall. None when the template doesn't
/// fit in the region.
pub fn find(frame: &Frame, rect: Rect, template: &Template, viewport_height: f64) -> Option<Found> {
    let img = Gray::from_frame(frame, rect);
    let scale = viewport_height / template.viewport_height;
    let tw = (template.image.w as f64 * scale).round() as usize;
    let th = (template.image.h as f64 * scale).round() as usize;
    if tw == 0 || th == 0 || tw > img.w || th > img.h {
        return None;
    }
    let tpl = if tw == template.image.w && th == template.image.h {
        template.image.clone()
    } else {
        template.image.resized(tw, th)
    };

    // Coarse pass, with the template at least 8 pixels on its short side.
    let step = (tw.min(th) / 8).clamp(1, 4);
    let mut candidates: Vec<(f64, usize, usize)> = Vec::new();
    if step > 1 {
        let small = img.resized(img.w / step, img.h / step);
        let small_t = Prepared::new(&tpl.resized(tw / step, th / step));
        let ii = Integral::new(&small);
        if small_t.w <= small.w && small_t.h <= small.h {
            for y in 0..=small.h - small_t.h {
                for x in 0..=small.w - small_t.w {
                    let s = small_t.score(&small, &ii, x, y);
                    candidates.push((s, x * step, y * step));
                }
            }
        }
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        // Keep the best few, apart from each other.
        let mut kept: Vec<(f64, usize, usize)> = Vec::new();
        for c in candidates {
            if kept.len() == 5 {
                break;
            }
            if kept
                .iter()
                .all(|k| k.1.abs_diff(c.1) > step * 2 || k.2.abs_diff(c.2) > step * 2)
            {
                kept.push(c);
            }
        }
        candidates = kept;
    }

    let full = Prepared::new(&tpl);
    let ii = Integral::new(&img);
    let (max_x, max_y) = (img.w - tw, img.h - th);
    let mut best = (f64::MIN, 0, 0);
    let mut check = |x: usize, y: usize| {
        let s = full.score(&img, &ii, x, y);
        if s > best.0 {
            best = (s, x, y);
        }
    };
    if candidates.is_empty() {
        for y in 0..=max_y {
            for x in 0..=max_x {
                check(x, y);
            }
        }
    } else {
        for &(_, cx, cy) in &candidates {
            let r = step + 1;
            for y in cy.saturating_sub(r)..=(cy + r).min(max_y) {
                for x in cx.saturating_sub(r)..=(cx + r).min(max_x) {
                    check(x, y);
                }
            }
        }
    }
    let (score, x, y) = best;
    Some(Found {
        score,
        x: (x as f64 + tw as f64 / 2.0) / img.w as f64,
        y: (y as f64 + th as f64 / 2.0) / img.h as f64,
        w: tw as f64 / img.w as f64,
        h: th as f64 / img.h as f64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame with a small two-tone icon at `(x, y)`, `size` pixels wide.
    fn scene(width: usize, height: usize, x: f64, y: f64, size: f64) -> Frame {
        let mut f = Frame::new(width, height, [40, 60, 40]);
        // Some texture so flat matches don't win.
        for i in 0..20 {
            let fx = (i * 37 % width) as f64;
            let fy = (i * 53 % height) as f64;
            f.fill(Rect::new(fx, fy, 6.0, 6.0), [90, 70, 50]);
        }
        f.fill(Rect::new(x, y, size, size), [230, 230, 230]);
        f.fill(
            Rect::new(x + size * 0.25, y + size * 0.25, size * 0.5, size * 0.25),
            [20, 20, 20],
        );
        f.fill(
            Rect::new(x, y + size * 0.75, size, size * 0.25),
            [200, 60, 60],
        );
        f
    }

    fn icon(size: usize) -> Frame {
        let f = scene(size * 3, size * 3, size as f64, size as f64, size as f64);
        f.crop(Rect::new(
            size as f64,
            size as f64,
            size as f64,
            size as f64,
        ))
    }

    #[test]
    fn finds_the_icon_where_it_is() {
        let t = Template::new(&icon(40), 540.0);
        let f = scene(960, 540, 600.0, 200.0, 40.0);
        let all = Rect::new(0.0, 0.0, 960.0, 540.0);
        let m = find(&f, all, &t, 540.0).unwrap();
        assert!(m.score > 0.98, "{m:?}");
        assert!((m.x * 960.0 - 620.0).abs() <= 1.5, "{m:?}");
        assert!((m.y * 540.0 - 220.0).abs() <= 1.5, "{m:?}");
    }

    #[test]
    fn scales_with_the_window() {
        // Saved at 540 tall, found in a 1080-tall window at twice the size.
        let t = Template::new(&icon(40), 540.0);
        let f = scene(1920, 1080, 300.0, 700.0, 80.0);
        let all = Rect::new(0.0, 0.0, 1920.0, 1080.0);
        let m = find(&f, all, &t, 1080.0).unwrap();
        assert!(m.score > 0.95, "{m:?}");
        assert!((m.x * 1920.0 - 340.0).abs() <= 3.0, "{m:?}");
        assert!((m.y * 1080.0 - 740.0).abs() <= 3.0, "{m:?}");
    }

    #[test]
    fn scores_low_when_it_isnt_there() {
        let t = Template::new(&icon(40), 540.0);
        let f = scene(960, 540, -100.0, -100.0, 40.0);
        let m = find(&f, Rect::new(0.0, 0.0, 960.0, 540.0), &t, 540.0).unwrap();
        assert!(m.score < 0.7, "{m:?}");
    }

    #[test]
    fn ignores_brightness() {
        let t = Template::new(&icon(40), 540.0);
        let mut f = scene(960, 540, 100.0, 100.0, 40.0);
        for px in f.data.chunks_mut(4) {
            for c in &mut px[..3] {
                *c = (f32::from(*c) * 0.6) as u8;
            }
        }
        let m = find(&f, Rect::new(0.0, 0.0, 960.0, 540.0), &t, 540.0).unwrap();
        assert!(m.score > 0.95, "{m:?}");
    }

    #[test]
    fn searches_only_the_region() {
        let t = Template::new(&icon(40), 540.0);
        let f = scene(960, 540, 600.0, 200.0, 40.0);
        let left = Rect::new(0.0, 0.0, 480.0, 540.0);
        assert!(find(&f, left, &t, 540.0).unwrap().score < 0.7);
        let tiny = Rect::new(0.0, 0.0, 20.0, 20.0);
        assert!(find(&f, tiny, &t, 540.0).is_none(), "too small to hold it");
    }
}
