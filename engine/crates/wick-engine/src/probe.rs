//! Tools for agents: experiments that follow colors while sending timed
//! input and return what happened as numbers, one-off color detection with a
//! palette of what's in a region, and cropped snapshots.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::frame::{Frame, Rect};
use crate::input::{At, Command, InputState};
use crate::region::RegionSpec;
use crate::target::Target;
use crate::tracker::Tracker;
use crate::vision::{find_color, parse_color, ColorQuery};

const MAX_SECONDS: f64 = 60.0;

fn default_tolerance() -> f64 {
    30.0
}
fn default_min_pixels() -> usize {
    3
}
fn default_seconds() -> f64 {
    3.0
}
fn default_hz() -> f64 {
    60.0
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeTrack {
    pub name: String,
    pub region: String,
    #[serde(default)]
    pub color: String,
    /// Follow anything but these colors instead of `color`.
    #[serde(default)]
    pub except: Vec<String>,
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
    #[serde(default = "default_min_pixels")]
    pub min_pixels: usize,
}

impl ProbeTrack {
    fn query(&self) -> Result<ColorQuery, String> {
        color_query(
            Some(&self.color),
            &self.except,
            self.tolerance,
            self.min_pixels,
        )
    }
}

/// A color query from the form commands take: one `color`, or `except` a
/// list of colors.
fn color_query(
    color: Option<&str>,
    except: &[String],
    tolerance: f64,
    min_pixels: usize,
) -> Result<ColorQuery, String> {
    let except = except
        .iter()
        .map(|c| parse_color(c))
        .collect::<Result<Vec<_>, _>>()?;
    let rgb = if except.is_empty() {
        parse_color(color.unwrap_or_default())?
    } else {
        [0, 0, 0]
    };
    Ok(ColorQuery {
        except,
        ..ColorQuery::new(rgb, tolerance.clamp(0.0, 255.0) as u8, min_pixels.max(1))
    })
}

/// An input to send `time` ms after the probe starts.
#[derive(Clone, Debug, Deserialize)]
pub struct ProbeInput {
    pub time: f64,
    pub command: Command,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSpec {
    #[serde(default)]
    pub regions: HashMap<String, RegionSpec>,
    #[serde(default)]
    pub track: Vec<ProbeTrack>,
    #[serde(default)]
    pub inputs: Vec<ProbeInput>,
    #[serde(default = "default_seconds")]
    pub seconds: f64,
    #[serde(default = "default_hz")]
    pub sample_hz: f64,
}

/// Columns of samples for one tracker. `None` where it wasn't seen.
#[derive(Default)]
struct Series {
    t: Vec<f64>,
    x: Vec<Option<f64>>,
    y: Vec<Option<f64>>,
    left: Vec<Option<f64>>,
    right: Vec<Option<f64>>,
    vx: Vec<Option<f64>>,
}

fn r4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

pub struct Probe {
    spec: ProbeSpec,
    trackers: Vec<Tracker>,
    series: Vec<Series>,
    pub input: InputState,
    started: f64,
    viewport: Rect,
    next_input: usize,
    next_sample: f64,
    events: Vec<Value>,
    frames: u64,
    unfocused: u64,
}

pub fn locate(
    regions: &HashMap<String, RegionSpec>,
    viewport: Rect,
    at: &At,
) -> Result<(f64, f64), String> {
    let rect = match &at.region {
        Some(name) => regions
            .get(name)
            .map(|r| r.resolve(viewport))
            .ok_or_else(|| format!("Unknown region \"{name}\"."))?,
        None => viewport,
    };
    Ok((rect.x + at.x * rect.w, rect.y + at.y * rect.h))
}

impl Probe {
    pub fn start(mut spec: ProbeSpec, target: &dyn Target) -> Result<Self, String> {
        for (name, region) in &spec.regions {
            region.validate(name)?;
        }
        if !(spec.seconds > 0.0 && spec.seconds <= MAX_SECONDS) {
            return Err(format!(
                "A probe runs for more than 0 and at most {MAX_SECONDS} seconds."
            ));
        }
        spec.sample_hz = spec.sample_hz.clamp(1.0, 240.0);
        let mut trackers = Vec::new();
        for (i, t) in spec.track.iter().enumerate() {
            if !spec.regions.contains_key(&t.region) {
                return Err(format!(
                    "\"{}\" tracks unknown region \"{}\".",
                    t.name, t.region
                ));
            }
            trackers.push(Tracker::new(i as u64, t.region.clone(), t.query()?));
        }
        spec.inputs.sort_by(|a, b| a.time.total_cmp(&b.time));
        Ok(Probe {
            series: spec.track.iter().map(|_| Series::default()).collect(),
            trackers,
            spec,
            input: InputState::default(),
            started: target.now_ms(),
            viewport: target.viewport(),
            next_input: 0,
            next_sample: 0.0,
            events: Vec::new(),
            frames: 0,
            unfocused: 0,
        })
    }

    /// Steps the probe. Returns the result once it's finished.
    pub fn tick(
        &mut self,
        target: &mut dyn Target,
        frame: Option<&Frame>,
    ) -> Result<Option<Value>, String> {
        let now = target.now_ms() - self.started;
        let focused = target.focused();
        if let Some(frame) = frame {
            self.frames += 1;
            if !focused {
                self.unfocused += 1;
            }
            self.viewport = target.viewport();
            for t in &mut self.trackers {
                let rect = self.spec.regions[&t.region].resolve(self.viewport);
                t.update(frame, rect, now);
            }
            if now >= self.next_sample {
                self.sample(now);
                let period = 1000.0 / self.spec.sample_hz;
                self.next_sample = ((now / period).floor() + 1.0) * period;
            }
        }
        while let Some(input) = self.spec.inputs.get(self.next_input) {
            if input.time > now {
                break;
            }
            let command = input.command.clone();
            let (regions, viewport) = (&self.spec.regions, self.viewport);
            self.input
                .schedule(command.clone(), now, |at| locate(regions, viewport, at))?;
            self.events.push(
                json!({ "t": r4(now), "planned": input.time, "command": command_json(&command) }),
            );
            self.next_input += 1;
        }
        self.input.flush(now, focused, &mut |a| target.send(a))?;
        if now >= self.spec.seconds * 1000.0 {
            self.input.release_all(focused, &mut |a| target.send(a));
            return Ok(Some(self.result(now, target)));
        }
        Ok(None)
    }

    pub fn abort(&mut self, target: &mut dyn Target) {
        let focused = target.focused();
        self.input.release_all(focused, &mut |a| target.send(a));
    }

    fn sample(&mut self, now: f64) {
        for (t, s) in self.trackers.iter().zip(&mut self.series) {
            let state = t.state(now);
            let get = |k: &str| state.get(k).and_then(Value::as_f64).map(r4);
            s.t.push((now * 10.0).round() / 10.0);
            s.x.push(get("x"));
            s.y.push(get("y"));
            s.left.push(get("left"));
            s.right.push(get("right"));
            s.vx.push(get("vx"));
        }
    }

    fn result(&self, now: f64, target: &dyn Target) -> Value {
        let mut trackers = Map::new();
        for (spec, s) in self.spec.track.iter().zip(&self.series) {
            let xs: Vec<f64> = s.x.iter().flatten().copied().collect();
            let seen = xs.len() as f64 / s.t.len().max(1) as f64;
            let summary = if xs.is_empty() {
                json!(null)
            } else {
                let mean = xs.iter().sum::<f64>() / xs.len() as f64;
                json!({
                    "xMin": r4(xs.iter().copied().fold(f64::INFINITY, f64::min)),
                    "xMax": r4(xs.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
                    "xMean": r4(mean),
                })
            };
            trackers.insert(
                spec.name.clone(),
                json!({
                    "region": spec.region, "color": spec.color, "seenFraction": r4(seen), "summary": summary,
                    "t": s.t, "x": s.x, "y": s.y, "left": s.left, "right": s.right, "vx": s.vx,
                }),
            );
        }
        let frames = self.frames.max(1) as f64;
        json!({
            "seconds": r4(now / 1000.0),
            "frames": self.frames,
            "fps": r4(self.frames as f64 / (now / 1000.0).max(1e-6)),
            "focusedFraction": r4(1.0 - self.unfocused as f64 / frames),
            "latency": target.latency(),
            "inputsSent": self.input.sent,
            "inputsDropped": self.input.dropped,
            "events": self.events,
            "trackers": trackers,
            "note": "Positions are fractions of each tracker's region (0 = left/top, 1 = right/bottom); vx is region widths per second; t is ms since the probe started.",
        })
    }
}

fn command_json(c: &Command) -> Value {
    match c {
        Command::Click { button, hold, .. } => {
            json!({ "t": "click", "button": button, "hold": hold })
        }
        Command::MouseDown { button } => json!({ "t": "mouseDown", "button": button }),
        Command::MouseUp { button } => json!({ "t": "mouseUp", "button": button }),
        Command::Move { .. } => json!({ "t": "move" }),
        Command::Turn { dx, dy } => json!({ "t": "turn", "dx": dx, "dy": dy }),
        Command::Press { key, hold } => json!({ "t": "press", "key": key, "hold": hold }),
        Command::KeyDown { key } => json!({ "t": "keyDown", "key": key }),
        Command::KeyUp { key } => json!({ "t": "keyUp", "key": key }),
    }
}

/// A one-off color search in a region, plus the region's main colors.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectSpec {
    pub region: Option<RegionSpec>,
    pub color: Option<String>,
    /// Look for anything but these colors instead of `color`.
    #[serde(default)]
    pub except: Vec<String>,
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
    #[serde(default = "default_min_pixels")]
    pub min_pixels: usize,
    /// Where to write a PNG of the region with matches outlined in ember.
    pub mask: Option<std::path::PathBuf>,
    /// A template to look for in the region, too.
    #[serde(default)]
    pub template: Option<crate::template::TemplateSpec>,
}

/// The most common colors in a rectangle, by coarse bucket, with each
/// bucket's average color and share of the pixels.
pub fn palette(frame: &Frame, rect: Rect, top: usize) -> Vec<Value> {
    let (x0, y0, x1, y1) = rect.pixel_bounds(frame.width, frame.height);
    let mut buckets: HashMap<u16, (u64, [u64; 3])> = HashMap::new();
    for y in y0..y1 {
        for x in x0..x1 {
            let [r, g, b] = frame.rgb(x, y);
            let key = (u16::from(r >> 4) << 8) | (u16::from(g >> 4) << 4) | u16::from(b >> 4);
            let e = buckets.entry(key).or_insert((0, [0; 3]));
            e.0 += 1;
            e.1[0] += u64::from(r);
            e.1[1] += u64::from(g);
            e.1[2] += u64::from(b);
        }
    }
    let total = ((x1 - x0) * (y1 - y0)).max(1) as f64;
    let mut list: Vec<_> = buckets.into_values().collect();
    list.sort_by_key(|a| std::cmp::Reverse(a.0));
    list.into_iter()
        .take(top)
        .map(|(n, sum)| {
            let avg = sum.map(|s| (s / n) as u8);
            json!({ "color": format!("#{:02x}{:02x}{:02x}", avg[0], avg[1], avg[2]), "share": r4(n as f64 / total) })
        })
        .collect()
}

pub fn detect(frame: &Frame, viewport: Rect, spec: &DetectSpec) -> Result<Value, String> {
    let rect = match &spec.region {
        Some(r) => {
            r.validate("region")?;
            r.resolve(viewport)
        }
        None => viewport,
    };
    let mut out = json!({
        "rect": rect,
        "frame": { "width": frame.width, "height": frame.height },
        "palette": palette(frame, rect, 8),
    });
    let query = if spec.color.is_some() || !spec.except.is_empty() {
        Some(color_query(
            spec.color.as_deref(),
            &spec.except,
            spec.tolerance,
            spec.min_pixels,
        )?)
    } else {
        None
    };
    if let Some(q) = &query {
        out["match"] = match find_color(frame, rect, q) {
            Some(m) => json!({
                "found": true, "pixels": m.pixels, "coverage": r4(m.coverage),
                "x": r4(m.cx), "y": r4(m.cy), "left": r4(m.left), "right": r4(m.right),
                "top": r4(m.top), "bottom": r4(m.bottom),
            }),
            None => json!({ "found": false }),
        };
    }
    if let Some(t) = &spec.template {
        let t = crate::template::Template::decode(t)?;
        out["template"] = match crate::template::find(frame, rect, &t, viewport.h) {
            Some(m) => m.json(),
            None => {
                json!({ "score": 0, "note": "The template is bigger than the region at this window size." })
            }
        };
    }
    if let Some(path) = &spec.mask {
        let mut crop = frame.crop(rect);
        if let Some(q) = &query {
            crop.highlight(q);
        }
        crop.write_png(path)?;
        out["mask"] = json!(path);
    }
    Ok(out)
}

/// Writes the whole frame, or one region of it, as a PNG.
pub fn snapshot(
    frame: &Frame,
    viewport: Rect,
    region: Option<&RegionSpec>,
    path: &Path,
) -> Result<Value, String> {
    match region {
        Some(r) => {
            r.validate("region")?;
            let rect = r.resolve(viewport);
            let crop = frame.crop(rect);
            crop.write_png(path)?;
            Ok(
                json!({ "path": path, "width": crop.width, "height": crop.height, "rect": rect, "viewport": viewport }),
            )
        }
        None => {
            frame.write_png(path)?;
            Ok(
                json!({ "path": path, "width": frame.width, "height": frame.height, "viewport": viewport }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{BarGame, Scenario, SimTarget, BAR_W, ZONE};
    use std::time::Duration;

    pub fn bar_region() -> RegionSpec {
        RegionSpec {
            anchor: "bottom-center".into(),
            x: 0.0,
            y: -0.18,
            w: 0.46,
            h: 0.06,
        }
    }

    fn run(spec: ProbeSpec, scenario: Scenario) -> Value {
        let mut target = SimTarget::new(scenario, false);
        let mut probe = Probe::start(spec, &target).unwrap();
        loop {
            let frame = target.next_frame(Duration::ZERO);
            if let Some(v) = probe.tick(&mut target, frame.as_deref()).unwrap() {
                return v;
            }
        }
    }

    fn spec(inputs: Vec<ProbeInput>, seconds: f64) -> ProbeSpec {
        ProbeSpec {
            regions: HashMap::from([("bar".into(), bar_region())]),
            track: vec![ProbeTrack {
                name: "tick".into(),
                region: "bar".into(),
                color: "#ffffff".into(),
                except: Vec::new(),
                tolerance: 40.0,
                min_pixels: 2,
            }],
            inputs,
            seconds,
            sample_hz: 120.0,
        }
    }

    fn click(time: f64) -> ProbeInput {
        ProbeInput {
            time,
            command: Command::Click {
                button: "left".into(),
                at: None,
                hold: 30.0,
            },
        }
    }

    /// Bar widths, from region widths.
    fn to_bar(v: f64) -> f64 {
        v * bar_region().w / BAR_W
    }

    #[test]
    fn measures_drift_within_five_percent() {
        let s = Scenario::default();
        let r = run(spec(vec![], 1.0), s.clone());
        let tick = &r["trackers"]["tick"];
        let t: Vec<f64> = serde_json::from_value(tick["t"].clone()).unwrap();
        let x: Vec<Option<f64>> = serde_json::from_value(tick["x"].clone()).unwrap();
        let (i0, i1) = (10, t.len() - 1);
        let speed = to_bar((x[i0].unwrap() - x[i1].unwrap()) / ((t[i1] - t[i0]) / 1000.0));
        assert!(
            (speed - s.drift).abs() / s.drift < 0.05,
            "measured {speed}, true {}",
            s.drift
        );
    }

    #[test]
    fn measures_click_push_within_five_percent() {
        let s = Scenario::default();
        let inputs = (0..5)
            .map(|i| click(100.0 + 300.0 * f64::from(i)))
            .collect();
        let r = run(spec(inputs, 1.8), s.clone());
        assert_eq!(r["inputsSent"], json!(10), "5 clicks, down and up");
        let tick = &r["trackers"]["tick"];
        let t: Vec<f64> = serde_json::from_value(tick["t"].clone()).unwrap();
        let x: Vec<Option<f64>> = serde_json::from_value(tick["x"].clone()).unwrap();
        let at = |ms: f64| x[t.iter().position(|&v| v >= ms).unwrap()].unwrap();
        // Between clicks the tick drifts; over each click window, push = Δx + drift·Δt.
        let mut pushes = Vec::new();
        for i in 0..5 {
            let (a, b) = (90.0 + 300.0 * f64::from(i), 290.0 + 300.0 * f64::from(i));
            pushes.push(to_bar(at(b) - at(a)) + s.drift * (b - a) / 1000.0);
        }
        let push = pushes.iter().sum::<f64>() / 5.0;
        assert!(
            (push - s.push).abs() / s.push < 0.05,
            "measured {push} from {pushes:?}, true {}",
            s.push
        );
    }

    #[test]
    fn detect_reports_matches_and_palette() {
        let target = SimTarget::new(Scenario::default(), false);
        let mut frame = Frame::new(960, 540, crate::sim::BACKGROUND);
        BarGame::new(Scenario::default()).render(&mut frame);
        let spec = DetectSpec {
            region: Some(bar_region()),
            color: Some("#3ccf5a".into()),
            except: Vec::new(),
            tolerance: 30.0,
            min_pixels: 3,
            mask: None,
            template: None,
        };
        let r = detect(&frame, target.viewport(), &spec).unwrap();
        assert_eq!(r["match"]["found"], json!(true));
        let colors: Vec<String> = r["palette"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["color"].as_str().unwrap().to_string())
            .collect();
        let zone = format!("#{:02x}{:02x}{:02x}", ZONE[0], ZONE[1], ZONE[2]);
        assert!(colors.contains(&zone), "{colors:?}");
    }

    #[test]
    fn rejects_unknown_regions_and_long_probes() {
        let target = SimTarget::new(Scenario::default(), false);
        let mut s = spec(vec![], 1.0);
        s.track[0].region = "nope".into();
        assert!(Probe::start(s, &target)
            .err()
            .unwrap()
            .contains("unknown region"));
        assert!(Probe::start(spec(vec![], 120.0), &target).is_err());
    }
}
