//! Captured frames and rectangles in frame pixels.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Rect { x, y, w, h }
    }

    /// Integer pixel bounds clamped to a `width` × `height` frame, as
    /// `(x0, y0, x1, y1)` with exclusive ends.
    pub fn pixel_bounds(&self, width: usize, height: usize) -> (usize, usize, usize, usize) {
        let clamp = |v: f64, max: usize| v.round().clamp(0.0, max as f64) as usize;
        (
            clamp(self.x, width),
            clamp(self.y, height),
            clamp(self.x + self.w, width),
            clamp(self.y + self.h, height),
        )
    }

    /// This rectangle as fractions of a `width` × `height` frame.
    pub fn normalized(&self, width: usize, height: usize) -> Rect {
        let (w, h) = (width.max(1) as f64, height.max(1) as f64);
        Rect {
            x: self.x / w,
            y: self.y / h,
            w: self.w / w,
            h: self.h / h,
        }
    }
}

/// A tiny grayscale copy for change scores. Each cell averages its block,
/// so small moving things still register.
pub fn signature(frame: &Frame) -> Vec<u8> {
    const W: usize = 48;
    const H: usize = 27;
    let mut sums = vec![(0u32, 0u32); W * H];
    for y in (0..frame.height).step_by(2) {
        let j = y * H / frame.height;
        for x in (0..frame.width).step_by(2) {
            let [r, g, b] = frame.rgb(x, y);
            let cell = &mut sums[j * W + x * W / frame.width];
            cell.0 += (u32::from(r) * 3 + u32::from(g) * 6 + u32::from(b)) / 10;
            cell.1 += 1;
        }
    }
    sums.into_iter()
        .map(|(sum, n)| (sum / n.max(1)) as u8)
        .collect()
}

/// How different two signatures are, from 0 (same) to 1.
pub fn change(a: &[u8], b: &[u8]) -> f64 {
    let sum: u64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    sum as f64 / (a.len().max(1) as f64 * 255.0)
}

/// Share of signature cells that look the same (within 16 levels), from 0 to 1.
pub fn similarity(a: &[u8], b: &[u8]) -> f64 {
    let same = a
        .iter()
        .zip(b)
        .filter(|(x, y)| x.abs_diff(**y) <= 16)
        .count();
    same as f64 / a.len().max(1) as f64
}

/// One frame of BGRA pixels.
#[derive(Clone)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub data: Vec<u8>,
}

impl Frame {
    pub fn new(width: usize, height: usize, rgb: [u8; 3]) -> Self {
        let mut frame = Frame {
            width,
            height,
            stride: width * 4,
            data: vec![0; width * height * 4],
        };
        frame.fill(Rect::new(0.0, 0.0, width as f64, height as f64), rgb);
        frame
    }

    /// Copies packed or padded BGRA rows into a tightly packed frame.
    pub fn from_bgra(data: &[u8], width: usize, height: usize, stride: usize) -> Self {
        let row = width * 4;
        let mut out = Vec::with_capacity(row * height);
        for y in 0..height {
            out.extend_from_slice(&data[y * stride..y * stride + row]);
        }
        Frame {
            width,
            height,
            stride: row,
            data: out,
        }
    }

    #[inline]
    pub fn rgb(&self, x: usize, y: usize) -> [u8; 3] {
        let i = y * self.stride + x * 4;
        [self.data[i + 2], self.data[i + 1], self.data[i]]
    }

    pub fn fill(&mut self, rect: Rect, rgb: [u8; 3]) {
        let (x0, y0, x1, y1) = rect.pixel_bounds(self.width, self.height);
        let px = [rgb[2], rgb[1], rgb[0], 255];
        for y in y0..y1 {
            let row = &mut self.data[y * self.stride + x0 * 4..y * self.stride + x1 * 4];
            for chunk in row.as_chunks_mut::<4>().0 {
                *chunk = px;
            }
        }
    }

    /// A smaller RGBA copy, at most `max_width` wide, for previews.
    pub fn preview_rgba(&self, max_width: usize) -> (usize, usize, Vec<u8>) {
        let step = self.width.div_ceil(max_width.max(1)).max(1);
        let (w, h) = (self.width / step, self.height / step);
        let mut out = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let [r, g, b] = self.rgb(x * step, y * step);
                out.extend_from_slice(&[r, g, b, 255]);
            }
        }
        (w, h, out)
    }

    /// A copy at most `max_width` wide, sampled by nearest pixel.
    pub fn scaled(&self, max_width: usize) -> Frame {
        if self.width <= max_width {
            return self.clone();
        }
        let w = max_width.max(1);
        let h = (self.height * w / self.width).max(1);
        let mut data = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            let row = (y * self.height / h) * self.stride;
            for x in 0..w {
                let i = row + (x * self.width / w) * 4;
                data.extend_from_slice(&self.data[i..i + 4]);
            }
        }
        Frame {
            width: w,
            height: h,
            stride: w * 4,
            data,
        }
    }

    /// A copy of one rectangle of the frame.
    pub fn crop(&self, rect: Rect) -> Frame {
        let (x0, y0, x1, y1) = rect.pixel_bounds(self.width, self.height);
        let (w, h) = (
            (x1 - x0).max(1).min(self.width),
            (y1 - y0).max(1).min(self.height),
        );
        let (x0, y0) = (x0.min(self.width - w), y0.min(self.height - h));
        let mut data = Vec::with_capacity(w * h * 4);
        for y in y0..y0 + h {
            data.extend_from_slice(
                &self.data[y * self.stride + x0 * 4..y * self.stride + (x0 + w) * 4],
            );
        }
        Frame {
            width: w,
            height: h,
            stride: w * 4,
            data,
        }
    }

    /// Paints pixels that match `q` ember and dims the rest, to show what a
    /// color detector sees.
    pub fn highlight(&mut self, q: &crate::vision::ColorQuery) {
        let tol = i16::from(q.tolerance);
        for px in self.data.as_chunks_mut::<4>().0 {
            let rgb = [px[2], px[1], px[0]];
            let hit = (0..3).all(|c| (i16::from(rgb[c]) - i16::from(q.rgb[c])).abs() <= tol);
            *px = if hit {
                [0x4b, 0x8a, 0xf0, 255]
            } else {
                [px[0] / 3, px[1] / 3, px[2] / 3, 255]
            };
        }
    }

    /// Encodes the frame as a PNG file.
    pub fn write_png(&self, path: &std::path::Path) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut encoder = png::Encoder::new(
            std::io::BufWriter::new(file),
            self.width as u32,
            self.height as u32,
        );
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        let mut rgb = Vec::with_capacity(self.width * self.height * 3);
        for y in 0..self.height {
            for x in 0..self.width {
                rgb.extend_from_slice(&self.rgb(x, y));
            }
        }
        writer.write_image_data(&rgb).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_and_read_back() {
        let mut f = Frame::new(10, 10, [0, 0, 0]);
        f.fill(Rect::new(2.0, 3.0, 2.0, 2.0), [10, 20, 30]);
        assert_eq!(f.rgb(2, 3), [10, 20, 30]);
        assert_eq!(f.rgb(3, 4), [10, 20, 30]);
        assert_eq!(f.rgb(4, 4), [0, 0, 0]);
    }

    #[test]
    fn copies_padded_rows() {
        let mut data = vec![0u8; 2 * 16];
        data[16..20].copy_from_slice(&[3, 2, 1, 255]);
        let f = Frame::from_bgra(&data, 2, 2, 16);
        assert_eq!(f.stride, 8);
        assert_eq!(f.rgb(0, 1), [1, 2, 3]);
    }

    #[test]
    fn preview_fits_width() {
        let f = Frame::new(1000, 500, [1, 2, 3]);
        let (w, h, data) = f.preview_rgba(480);
        assert!(w <= 480);
        assert_eq!(data.len(), w * h * 4);
    }
}
