//! One macro run: the runtime, its trackers and its input, stepped once per frame.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::frame::{Frame, Rect};
use crate::human::HumanProfile;
use crate::input::{At, Command, InputState};
use crate::region::RegionSpec;
use crate::runtime::{MacroRuntime, Status};
use crate::target::Target;
use crate::tracker::Tracker;
use crate::vision::{parse_color, ColorQuery};

/// A macro as the app sends it: manifest fields plus type-stripped sources.
#[derive(Clone, Debug, Deserialize)]
pub struct MacroSpec {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub files: HashMap<String, String>,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub regions: HashMap<String, RegionSpec>,
    #[serde(default)]
    pub settings: Value,
    /// How human the input looks. Missing means exact input.
    #[serde(default)]
    pub human: Option<HumanProfile>,
}

fn default_entry() -> String {
    "main.ts".into()
}

pub const PERMISSIONS: [&str; 5] = [
    "mouse.click",
    "mouse.move",
    "keyboard",
    "character.reset",
    "game.rejoin",
];

#[derive(Clone, Debug, PartialEq)]
pub enum RunEnd {
    Done,
    Stopped(String),
    Failed(String),
}

impl RunEnd {
    pub fn to_json(&self) -> Value {
        match self {
            RunEnd::Done => json!({ "reason": "done" }),
            RunEnd::Stopped(why) => json!({ "reason": "stopped", "detail": why }),
            RunEnd::Failed(error) => json!({ "reason": "error", "error": error }),
        }
    }
}

pub struct MacroRun {
    pub spec: MacroSpec,
    runtime: MacroRuntime,
    trackers: Vec<Tracker>,
    permissions: HashSet<String>,
    pub input: InputState,
    /// While set, each frame's tracker positions are kept for the app's graph.
    pub trace: Option<Vec<Value>>,
    started_ms: f64,
    viewport: Rect,
    pub loops: u64,
    pub ticks: u64,
}

impl MacroRun {
    pub fn start(spec: MacroSpec, target: &dyn Target) -> Result<Self, String> {
        for (name, region) in &spec.regions {
            region.validate(name)?;
        }
        for p in &spec.permissions {
            if !PERMISSIONS.contains(&p.as_str()) {
                return Err(format!(
                    "Unknown permission \"{p}\" in wick.json. Use: {}.",
                    PERMISSIONS.join(", ")
                ));
            }
        }
        if !spec.files.contains_key(&spec.entry) {
            return Err(format!(
                "The macro's entry file \"{}\" is missing.",
                spec.entry
            ));
        }
        let settings = if spec.settings.is_object() {
            spec.settings.clone()
        } else {
            json!({})
        };
        let runtime = MacroRuntime::start(
            spec.files.clone(),
            &spec.entry,
            &json!({ "settings": settings, "latency": target.latency() }),
        )?;
        let input = InputState::with_profile(spec.human.clone());
        Ok(MacroRun {
            permissions: spec.permissions.iter().cloned().collect(),
            spec,
            runtime,
            trackers: Vec::new(),
            input,
            trace: None,
            started_ms: target.now_ms(),
            viewport: target.viewport(),
            loops: 0,
            ticks: 0,
        })
    }

    fn region_rect(&self, name: &str) -> Result<Rect, String> {
        self.spec
            .regions
            .get(name)
            .map(|r| r.resolve(self.viewport))
            .ok_or_else(|| format!("Unknown region \"{name}\". Add it to regions.json."))
    }

    fn locate(&self, at: &At) -> Result<(f64, f64), String> {
        let rect = match &at.region {
            Some(name) => self.region_rect(name)?,
            None => self.viewport,
        };
        Ok((rect.x + at.x * rect.w, rect.y + at.y * rect.h))
    }

    fn handle(
        &mut self,
        cmd: Value,
        now: f64,
        emit: &mut dyn FnMut(&str, Value),
    ) -> Result<(), String> {
        match cmd["t"].as_str().unwrap_or_default() {
            "track" => {
                let region = cmd["region"].as_str().unwrap_or_default().to_string();
                self.region_rect(&region)?;
                let rgb = parse_color(cmd["color"].as_str().unwrap_or_default())?;
                let query = ColorQuery {
                    rgb,
                    tolerance: cmd["tolerance"].as_f64().unwrap_or(30.0).clamp(0.0, 255.0) as u8,
                    min_pixels: cmd["minPixels"].as_u64().unwrap_or(3) as usize,
                };
                self.trackers
                    .push(Tracker::new(cmd["id"].as_u64().unwrap_or(0), region, query));
            }
            "log" => emit("macro.log", json!({ "text": cmd["text"], "at": now })),
            "loop" => self.loops = cmd["index"].as_u64().unwrap_or(0) + 1,
            _ => {
                let command: Command = serde_json::from_value(cmd.clone())
                    .map_err(|e| format!("Bad input command {cmd}: {e}"))?;
                let permission = command.permission();
                if !self.permissions.contains(permission) {
                    return Err(format!(
                        "This macro used \"{permission}\" without declaring it. Add it to \"permissions\" in wick.json."
                    ));
                }
                let located = match &command {
                    Command::Click { at: Some(at), .. } | Command::Move { at } => {
                        Some(self.locate(at)?)
                    }
                    _ => None,
                };
                self.input.schedule(command, now, |_| {
                    located.ok_or_else(|| "no position".to_string())
                })?;
            }
        }
        Ok(())
    }

    /// Steps the macro with the latest frame. Returns how the run ended, if it did.
    pub fn tick(
        &mut self,
        target: &mut dyn Target,
        frame: Option<&Frame>,
        emit: &mut dyn FnMut(&str, Value),
    ) -> Option<RunEnd> {
        self.ticks += 1;
        let now = target.now_ms() - self.started_ms;
        let focused = target.focused();
        if let Some(frame) = frame {
            self.viewport = target.viewport();
            for i in 0..self.trackers.len() {
                if let Some(spec) = self.spec.regions.get(&self.trackers[i].region) {
                    let rect = spec.resolve(self.viewport);
                    self.trackers[i].update(frame, rect, now);
                }
            }
            if let Some(trace) = &mut self.trace {
                let points: Vec<Value> = self.trackers.iter().map(|t| t.trace_point()).collect();
                trace.push(json!([now.round(), points]));
            }
        }
        let mut states = Map::new();
        for t in &self.trackers {
            states.insert(t.id.to_string(), t.state(now));
        }
        let state = json!({
            "now": now,
            "latency": target.latency(),
            "focused": focused,
            "viewport": { "width": self.viewport.w, "height": self.viewport.h },
            "trackers": states,
        });
        let drained = match self.runtime.step(&state) {
            Ok(d) => d,
            Err(e) => return Some(RunEnd::Failed(e)),
        };
        for cmd in drained.commands {
            if let Err(e) = self.handle(cmd, now, emit) {
                return Some(RunEnd::Failed(e));
            }
        }
        if let Err(e) = self.input.flush(now, focused, &mut |a| target.send(a)) {
            return Some(RunEnd::Failed(e));
        }
        match drained.status {
            Status::Done => Some(RunEnd::Done),
            Status::Error(e) => Some(RunEnd::Failed(e)),
            _ => None,
        }
    }

    /// Releases held input. Call once when the run ends.
    pub fn finish(&mut self, target: &mut dyn Target) {
        let focused = target.focused();
        self.input.release_all(focused, &mut |a| target.send(a));
    }

    pub fn stats(&self, target: &dyn Target) -> Value {
        json!({
            "id": self.spec.id,
            "elapsed": target.now_ms() - self.started_ms,
            "loops": self.loops,
            "ticks": self.ticks,
            "inputs": self.input.sent,
            "dropped": self.input.dropped,
            "score": target.score(),
        })
    }

    /// What each traced tracker follows, in trace order.
    pub fn trace_labels(&self) -> Value {
        self.trackers
            .iter()
            .map(|t| {
                let [r, g, b] = t.query.rgb;
                json!({ "id": t.id, "region": t.region, "color": format!("#{r:02x}{g:02x}{b:02x}") })
            })
            .collect()
    }

    /// Regions and tracker results in frame fractions, for the live view.
    pub fn overlay(&self, frame_w: usize, frame_h: usize) -> Value {
        let regions: Vec<Value> = self
            .spec
            .regions
            .iter()
            .map(|(name, r)| json!({ "name": name, "rect": r.resolve(self.viewport).normalized(frame_w, frame_h) }))
            .collect();
        let trackers: Vec<Value> = self
            .trackers
            .iter()
            .map(|t| t.overlay(frame_w, frame_h))
            .collect();
        json!({ "regions": regions, "trackers": trackers })
    }
}
