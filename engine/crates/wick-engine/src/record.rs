//! Recordings: a few seconds of the target window saved as keyframes, with a
//! log of how much each moment changed and every input sent or made.
//!
//! Agents use recordings to see what happens over time without watching
//! video: `record.jsonl` has a change score per sample and each input, and a
//! contact sheet shows the moments that changed most. Optionally the
//! person's own clicks and key presses are logged too, so an agent can see
//! what they did in the game ("watch me do it once").

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::frame::{change, signature, Frame, Rect};
use crate::input::Action;
use crate::region::RegionSpec;
use crate::target::{HeardInput, Target};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSpec {
    pub dir: PathBuf,
    #[serde(default = "default_seconds")]
    pub seconds: f64,
    /// Samples per second for change scores and keyframes.
    #[serde(default = "default_fps")]
    pub fps: f64,
    /// Only record this part of the window.
    #[serde(default)]
    pub region: Option<RegionSpec>,
    #[serde(default = "default_width")]
    pub max_width: usize,
    /// Also log the person's own clicks and key presses.
    #[serde(default)]
    pub you: bool,
}

fn default_seconds() -> f64 {
    5.0
}
fn default_fps() -> f64 {
    10.0
}
fn default_width() -> usize {
    640
}

pub const MAX_SECONDS: f64 = 60.0;
const MAX_FRAMES: usize = 400;
/// A keyframe is saved when this much changed since the last one, or after
/// `KEYFRAME_EVERY_MS` regardless.
const SAVE_CHANGE: f64 = 0.01;
const KEYFRAME_EVERY_MS: f64 = 1000.0;
const THUMB_W: usize = 192;
const SHEET_COLUMNS: usize = 4;
const SHEET_TILES: usize = 12;

struct Saved {
    t: f64,
    file: String,
    change: f64,
    thumb: Frame,
}

pub struct Recorder {
    spec: RecordSpec,
    log: BufWriter<File>,
    started: f64,
    next_sample: f64,
    previous: Option<Vec<u8>>,
    last_saved: Option<(f64, Vec<u8>)>,
    saved: Vec<Saved>,
    samples: Vec<(f64, f64)>,
    wick_inputs: usize,
    your_inputs: usize,
    cursor: Option<(f64, f64)>,
    viewport: Rect,
}

impl Recorder {
    pub fn start(mut spec: RecordSpec, target: &mut dyn Target) -> Result<Self, String> {
        if !(spec.seconds > 0.0 && spec.seconds <= MAX_SECONDS) {
            return Err(format!(
                "A recording can be up to {MAX_SECONDS} seconds long."
            ));
        }
        spec.fps = spec.fps.clamp(1.0, 30.0);
        spec.max_width = spec.max_width.clamp(160, 1920);
        if let Some(r) = &spec.region {
            r.validate("region")?;
        }
        std::fs::create_dir_all(spec.dir.join("frames"))
            .map_err(|e| format!("Couldn't create {}: {e}", spec.dir.display()))?;
        let log = File::create(spec.dir.join("record.jsonl"))
            .map(BufWriter::new)
            .map_err(|e| e.to_string())?;
        if spec.you {
            target.listen(true)?;
        }
        let now = target.now_ms();
        Ok(Recorder {
            log,
            started: now,
            next_sample: now,
            previous: None,
            last_saved: None,
            saved: Vec::new(),
            samples: Vec::new(),
            wick_inputs: 0,
            your_inputs: 0,
            cursor: None,
            viewport: target.viewport(),
            spec,
        })
    }

    fn write(&mut self, line: Value) -> Result<(), String> {
        writeln!(self.log, "{line}").map_err(|e| e.to_string())
    }

    /// Where a frame-pixel point is, as fractions of the recorded area.
    fn place(&self, (x, y): (f64, f64)) -> Value {
        let rect = match &self.spec.region {
            Some(r) => r.resolve(self.viewport),
            None => self.viewport,
        };
        json!([
            ((x - rect.x) / rect.w * 1000.0).round() / 1000.0,
            ((y - rect.y) / rect.h * 1000.0).round() / 1000.0
        ])
    }

    fn input(
        &mut self,
        t: f64,
        action: &Action,
        at: Option<(f64, f64)>,
        by: &str,
    ) -> Result<(), String> {
        let t = ((t - self.started) * 10.0).round() / 10.0;
        let mut line = match action {
            Action::MoveTo { x, y } => {
                // Moves are summarized by where the next click lands.
                self.cursor = Some((*x, *y));
                return Ok(());
            }
            Action::Turn { dx, dy } => {
                json!({ "t": t, "by": by, "input": "turn", "dx": dx, "dy": dy })
            }
            Action::Button { button, down } => {
                let name = format!("{button:?}").to_ascii_lowercase();
                let mut line = json!({ "t": t, "by": by, "input": if *down { "mouseDown" } else { "mouseUp" }, "button": name });
                if let Some(p) = at.or(self.cursor) {
                    line["at"] = self.place(p);
                }
                line
            }
            Action::Key { name, down } => {
                json!({ "t": t, "by": by, "input": if *down { "keyDown" } else { "keyUp" }, "key": name })
            }
        };
        if by == "you" {
            self.your_inputs += 1;
        } else {
            self.wick_inputs += 1;
        }
        line["t"] = json!(t);
        self.write(line)
    }

    /// Takes the latest frame and the inputs since the last call. Returns the
    /// result once the time is up.
    pub fn tick(
        &mut self,
        target: &mut dyn Target,
        frame: Option<&Frame>,
        sent: &[(f64, Action)],
    ) -> Result<Option<Value>, String> {
        let now = target.now_ms();
        for (t, action) in sent {
            self.input(*t, action, None, "wick")?;
        }
        if self.spec.you {
            for HeardInput { t, action, at } in target.heard() {
                self.input(t, &action, at, "you")?;
            }
        }
        if let Some(frame) = frame {
            if now >= self.next_sample {
                self.next_sample = now.max(self.next_sample) + 1000.0 / self.spec.fps;
                self.viewport = target.viewport();
                self.sample(now, frame)?;
            }
        }
        if now - self.started >= self.spec.seconds * 1000.0 {
            return self.finish(target).map(Some);
        }
        Ok(None)
    }

    fn sample(&mut self, now: f64, frame: &Frame) -> Result<(), String> {
        let area = match &self.spec.region {
            Some(r) => frame.crop(r.resolve(self.viewport)),
            None => frame.crop(self.viewport),
        };
        let sig = signature(&area);
        let t = ((now - self.started) * 10.0).round() / 10.0;
        let score = self.previous.as_ref().map_or(0.0, |p| change(p, &sig));
        let since_saved = self
            .last_saved
            .as_ref()
            .map(|(at, s)| (now - at, change(s, &sig)));
        let save = self.saved.len() < MAX_FRAMES
            && since_saved.is_none_or(|(ms, c)| c >= SAVE_CHANGE || ms >= KEYFRAME_EVERY_MS);
        let mut line = json!({ "t": t, "change": (score * 10000.0).round() / 10000.0 });
        if save {
            let file = format!("frames/{:06}.png", t.round() as u64);
            area.scaled(self.spec.max_width)
                .write_png(&self.spec.dir.join(&file))?;
            line["frame"] = json!(file);
            self.saved.push(Saved {
                t,
                file,
                change: score,
                thumb: area.scaled(THUMB_W),
            });
            self.last_saved = Some((now, sig.clone()));
        }
        self.samples.push((t, score));
        self.previous = Some(sig);
        self.write(line)
    }

    /// Picks the frames for the contact sheet: the first, then the ones that
    /// changed most, kept apart in time, in time order.
    fn highlights(&self) -> Vec<usize> {
        if self.saved.is_empty() {
            return Vec::new();
        }
        let mut order: Vec<usize> = (1..self.saved.len()).collect();
        order.sort_by(|&a, &b| self.saved[b].change.total_cmp(&self.saved[a].change));
        let gap = (self.spec.seconds * 1000.0 / (SHEET_TILES as f64 * 2.0)).max(100.0);
        let mut picked = vec![0];
        for i in order {
            if picked.len() == SHEET_TILES {
                break;
            }
            if picked
                .iter()
                .all(|&p| (self.saved[p].t - self.saved[i].t).abs() >= gap)
            {
                picked.push(i);
            }
        }
        // Fill any space left with evenly spaced frames.
        let n = self.saved.len();
        for k in 0..SHEET_TILES {
            if picked.len() >= SHEET_TILES.min(n) {
                break;
            }
            let i = k * n / SHEET_TILES;
            if !picked.contains(&i) {
                picked.push(i);
            }
        }
        picked.sort_unstable();
        picked
    }

    fn contact_sheet(&self, tiles: &[usize]) -> Result<Option<PathBuf>, String> {
        let Some(first) = tiles.first().map(|&i| &self.saved[i].thumb) else {
            return Ok(None);
        };
        const GAP: usize = 4;
        let (tw, th) = (first.width, first.height);
        let cols = SHEET_COLUMNS.min(tiles.len());
        let rows = tiles.len().div_ceil(cols);
        let mut sheet = Frame::new(
            cols * tw + (cols + 1) * GAP,
            rows * th + (rows + 1) * GAP,
            [0x1c, 0x1c, 0x1c],
        );
        for (k, &i) in tiles.iter().enumerate() {
            let thumb = &self.saved[i].thumb;
            let (ox, oy) = (GAP + (k % cols) * (tw + GAP), GAP + (k / cols) * (th + GAP));
            for y in 0..thumb.height.min(th) {
                let src = &thumb.data[y * thumb.stride..y * thumb.stride + thumb.width.min(tw) * 4];
                let at = (oy + y) * sheet.stride + ox * 4;
                sheet.data[at..at + src.len()].copy_from_slice(src);
            }
        }
        let path = self.spec.dir.join("contact.png");
        sheet.write_png(&path)?;
        Ok(Some(path))
    }

    pub fn finish(&mut self, target: &mut dyn Target) -> Result<Value, String> {
        if self.spec.you {
            let _ = target.listen(false);
        }
        self.log.flush().map_err(|e| e.to_string())?;
        let tiles = self.highlights();
        let sheet = self.contact_sheet(&tiles)?;
        let mut moments: Vec<&(f64, f64)> = self.samples.iter().filter(|(_, c)| *c > 0.0).collect();
        moments.sort_by(|a, b| b.1.total_cmp(&a.1));
        let average =
            self.samples.iter().map(|s| s.1).sum::<f64>() / self.samples.len().max(1) as f64;
        Ok(json!({
            "dir": self.spec.dir,
            "log": self.spec.dir.join("record.jsonl"),
            "seconds": self.spec.seconds,
            "samples": self.samples.len(),
            "framesSaved": self.saved.len(),
            "averageChange": (average * 10000.0).round() / 10000.0,
            "mostChange": moments.iter().take(8).map(|(t, c)| json!({ "t": t, "change": (c * 10000.0).round() / 10000.0 })).collect::<Vec<_>>(),
            "path": sheet,
            "sheet": tiles.iter().map(|&i| json!({ "t": self.saved[i].t, "frame": self.saved[i].file })).collect::<Vec<_>>(),
            "inputs": { "wick": self.wick_inputs, "you": self.your_inputs },
        }))
    }

    /// Stops early, keeping what was recorded.
    pub fn abort(&mut self, target: &mut dyn Target) -> Result<Value, String> {
        self.spec.seconds = ((target.now_ms() - self.started) / 1000.0).max(0.0);
        self.finish(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Scenario, SimTarget};
    use std::time::Duration;
    use wick_platform::MouseButton;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wick-record-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn records_keyframes_changes_and_inputs() {
        let d = dir("basic");
        let mut target = SimTarget::new(Scenario::default(), false);
        let spec: RecordSpec =
            serde_json::from_value(json!({ "dir": d, "seconds": 2, "fps": 10, "you": true }))
                .unwrap();
        let mut rec = Recorder::start(spec, &mut target).unwrap();
        let mut result = None;
        let mut step = 0;
        while result.is_none() {
            let frame = target.next_frame(Duration::ZERO);
            let now = target.now_ms();
            let mut sent = Vec::new();
            step += 1;
            if step % 60 == 0 {
                sent.push((now, Action::MoveTo { x: 480.0, y: 270.0 }));
                sent.push((
                    now,
                    Action::Button {
                        button: MouseButton::Left,
                        down: true,
                    },
                ));
                target.heard.push(HeardInput {
                    t: now,
                    action: Action::Key {
                        name: "e".into(),
                        down: true,
                    },
                    at: None,
                });
            }
            result = rec.tick(&mut target, frame.as_deref(), &sent).unwrap();
        }
        let r = result.unwrap();
        let samples = r["samples"].as_u64().unwrap();
        assert!((19..=21).contains(&samples), "{r}");
        assert!(r["framesSaved"].as_u64().unwrap() >= 2);
        assert!(r["averageChange"].as_f64().unwrap() > 0.0, "the bar moves");
        assert!(
            std::fs::metadata(r["path"].as_str().unwrap()).is_ok(),
            "contact sheet"
        );
        assert_eq!(
            r["inputs"]["wick"],
            json!(4),
            "four clicks, moves summarized: {r}"
        );
        assert_eq!(r["inputs"]["you"], json!(4));
        let log = std::fs::read_to_string(d.join("record.jsonl")).unwrap();
        let click = log.lines().find(|l| l.contains("mouseDown")).unwrap();
        let click: Value = serde_json::from_str(click).unwrap();
        assert_eq!(click["at"], json!([0.5, 0.5]));
        assert!(log
            .lines()
            .any(|l| l.contains("\"by\":\"you\"") && l.contains("keyDown")));
        let first_frame = log.lines().find(|l| l.contains("frame")).unwrap();
        let first_frame: Value = serde_json::from_str(first_frame).unwrap();
        assert!(d.join(first_frame["frame"].as_str().unwrap()).exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn finds_the_moment_that_changed() {
        let a = Frame::new(100, 60, [10, 10, 10]);
        let mut b = a.clone();
        b.fill(Rect::new(0.0, 0.0, 50.0, 60.0), [250, 250, 250]);
        assert_eq!(change(&signature(&a), &signature(&a)), 0.0);
        let c = change(&signature(&a), &signature(&b));
        assert!((c - 0.47).abs() < 0.05, "{c}");
    }

    #[test]
    fn rejects_long_recordings() {
        let mut target = SimTarget::new(Scenario::default(), false);
        let spec: RecordSpec =
            serde_json::from_value(json!({ "dir": dir("long"), "seconds": 61 })).unwrap();
        assert!(Recorder::start(spec, &mut target).is_err());
    }
}
