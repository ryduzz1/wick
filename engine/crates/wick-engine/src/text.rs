//! Reading text on screen (`screen.read`, `wick read`) with the system's
//! text recognition. It takes tens of milliseconds, so runs off the frame
//! loop: each read crops the region and hands it to a worker thread.

use std::sync::mpsc::{channel, Receiver};

use serde_json::{json, Value};
use wick_platform::TextLine;

use crate::frame::{Frame, Rect};

/// Small text reads better bigger; crops shorter than this are scaled up.
const MIN_HEIGHT: usize = 48;

/// The region of `frame`, ready to read.
pub fn crop(frame: &Frame, rect: Rect) -> Frame {
    let crop = frame.crop(rect);
    if crop.height == 0 || crop.height >= MIN_HEIGHT {
        return crop;
    }
    let factor = MIN_HEIGHT.div_ceil(crop.height).min(4);
    let mut big = Frame::new(crop.width * factor, crop.height * factor, [0, 0, 0]);
    for y in 0..big.height {
        for x in 0..big.width {
            let src = (y / factor) * crop.stride + (x / factor) * 4;
            let dst = y * big.stride + x * 4;
            big.data[dst..dst + 4].copy_from_slice(&crop.data[src..src + 4]);
        }
    }
    big
}

pub fn read(image: &Frame, accurate: bool) -> Result<Vec<TextLine>, String> {
    wick_platform::read_text(
        &image.data,
        image.width,
        image.height,
        image.stride,
        accurate,
    )
}

/// Starts reading on a worker thread.
pub fn read_async(image: Frame, accurate: bool) -> Receiver<Result<Vec<TextLine>, String>> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(read(&image, accurate));
    });
    rx
}

/// What macros and agents get: all the text, top to bottom, and each line.
pub fn to_json(result: &Result<Vec<TextLine>, String>) -> Value {
    let r = |v: f64| (v * 10000.0).round() / 10000.0;
    match result {
        Ok(lines) => {
            let mut lines = lines.clone();
            lines.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
            json!({
                "text": lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n"),
                "lines": lines.iter().map(|l| json!({ "text": l.text, "confidence": r(l.confidence), "x": r(l.x), "y": r(l.y), "width": r(l.w), "height": r(l.h) })).collect::<Vec<_>>(),
            })
        }
        Err(e) => json!({ "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_crops_are_scaled_up() {
        let f = Frame::new(200, 100, [10, 10, 10]);
        let c = crop(&f, Rect::new(0.0, 0.0, 100.0, 20.0));
        assert_eq!((c.width, c.height), (300, 60));
        let c = crop(&f, Rect::new(0.0, 0.0, 100.0, 60.0));
        assert_eq!((c.width, c.height), (100, 60));
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn reads_the_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/text.png");
        let frame = Frame::read_png(&path).unwrap();
        let lines = match read(&frame, true) {
            Ok(lines) => lines,
            // CI machines may have no recognition language installed.
            Err(e) if cfg!(windows) && e.contains("language") => return eprintln!("skipped: {e}"),
            Err(e) => panic!("{e}"),
        };
        let out = to_json(&Ok(lines));
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("Bag 3/5"), "{out}");
        assert!(text.contains("Coins: 120"), "{out}");
        let bag = &out["lines"][0];
        assert!(
            bag["y"].as_f64().unwrap() < 0.5 && bag["x"].as_f64().unwrap() < 0.2,
            "{out}"
        );
    }
}
