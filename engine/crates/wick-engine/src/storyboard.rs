//! Storyboards: a recording split into steps, so an agent can read a whole
//! demonstration ("walk to the dock, press E, wait for the bite, play the
//! minigame, walk to the vendor...") as a short list instead of a video.
//!
//! Built from `record.jsonl` alone. A step ends where the person paused for
//! a while, where they stopped for long enough to count as waiting, or where
//! the screen changed all at once (a menu opening, a teleport, a minigame
//! appearing). Each step lists what was done in it, with times, and the
//! keyframes from its start and end.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

/// No input for this long makes a wait step.
const IDLE_MS: f64 = 1500.0;
/// A pause this long inside activity starts a new step.
const PAUSE_MS: f64 = 600.0;
/// Shorter holds count as presses.
const PRESS_MS: f64 = 250.0;
/// Mouse motion with gaps shorter than this is one turn.
const MOTION_GAP_MS: f64 = 300.0;
/// A sample that changed at least this much (and well above the usual)
/// counts as the scene changing.
const SCENE_CHANGE: f64 = 0.08;
const SCENE_OVER_MEDIAN: f64 = 3.0;
/// Scene changes closer than this together are one.
const SCENE_MERGE_MS: f64 = 500.0;
const SHEET_TILES: usize = 48;

#[derive(Clone, Debug, PartialEq)]
pub enum Do {
    Hold { key: String },
    Press { key: String },
    Click { button: String },
    Turn { dx: f64, dy: f64 },
}

#[derive(Clone, Debug)]
pub struct Act {
    pub t: f64,
    pub end: f64,
    pub what: Do,
    pub at: Option<Value>,
}

impl Act {
    fn json(&self) -> Value {
        let ms = ((self.end - self.t).max(0.0)).round();
        let mut v = match &self.what {
            Do::Hold { key } => json!({ "do": "hold", "key": key, "ms": ms }),
            Do::Press { key } => json!({ "do": "press", "key": key }),
            Do::Click { button } => json!({ "do": "click", "button": button, "ms": ms }),
            Do::Turn { dx, dy } => json!({ "do": "turn", "dx": dx, "dy": dy, "ms": ms }),
        };
        v["t"] = json!(round1(self.t));
        if let Some(at) = &self.at {
            v[if matches!(self.what, Do::Turn { .. }) {
                "to"
            } else {
                "at"
            }] = at.clone();
        }
        v
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn num(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(0.0)
}

/// Pairs downs with ups and merges motion into actions, in time order.
pub fn actions(lines: &[Value], by: &str, duration: f64) -> Vec<Act> {
    let mut out = Vec::new();
    let mut keys: HashMap<String, f64> = HashMap::new();
    let mut buttons: HashMap<String, (f64, Option<Value>)> = HashMap::new();
    let mut motion: Option<Act> = None;
    for line in lines.iter().filter(|l| l["by"] == by) {
        let t = num(line, "t");
        let at = line.get("at").cloned();
        match line["input"].as_str().unwrap_or("") {
            "keyDown" => {
                keys.entry(line["key"].as_str().unwrap_or("").to_string())
                    .or_insert(t);
            }
            "keyUp" => {
                let key = line["key"].as_str().unwrap_or("").to_string();
                if let Some(start) = keys.remove(&key) {
                    out.push(key_act(key, start, t));
                }
            }
            "mouseDown" => {
                buttons.insert(line["button"].as_str().unwrap_or("left").into(), (t, at));
            }
            "mouseUp" => {
                let button = line["button"].as_str().unwrap_or("left").to_string();
                if let Some((start, at)) = buttons.remove(&button) {
                    out.push(Act {
                        t: start,
                        end: t,
                        what: Do::Click { button },
                        at,
                    });
                }
            }
            "mouse" | "turn" => {
                let (dx, dy) = (num(line, "dx"), num(line, "dy"));
                match &mut motion {
                    Some(m) if t - m.end <= MOTION_GAP_MS => {
                        if let Do::Turn { dx: sx, dy: sy } = &mut m.what {
                            *sx += dx;
                            *sy += dy;
                        }
                        m.end = t;
                        if at.is_some() {
                            m.at = at;
                        }
                    }
                    _ => {
                        if let Some(m) = motion.take() {
                            out.push(m);
                        }
                        motion = Some(Act {
                            t,
                            end: t,
                            what: Do::Turn { dx, dy },
                            at,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    out.extend(motion);
    // Anything still held when the recording ended.
    for (key, start) in keys {
        out.push(key_act(key, start, duration));
    }
    for (button, (start, at)) in buttons {
        out.push(Act {
            t: start,
            end: duration,
            what: Do::Click { button },
            at,
        });
    }
    out.retain(|a| match a.what {
        Do::Turn { dx, dy } => dx.abs() + dy.abs() >= 2.0,
        _ => true,
    });
    out.sort_by(|a, b| a.t.total_cmp(&b.t));
    out
}

fn key_act(key: String, start: f64, end: f64) -> Act {
    Act {
        t: start,
        end,
        what: if end - start < PRESS_MS {
            Do::Press { key }
        } else {
            Do::Hold { key }
        },
        at: None,
    }
}

/// Moments the whole scene changed, outside of camera turns.
fn scene_changes(samples: &[(f64, f64)], acts: &[Act]) -> Vec<f64> {
    let mut sorted: Vec<f64> = samples.iter().map(|s| s.1).collect();
    sorted.sort_by(f64::total_cmp);
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let turning = |t: f64| {
        acts.iter()
            .any(|a| matches!(a.what, Do::Turn { .. }) && t >= a.t - 150.0 && t <= a.end + 150.0)
    };
    let mut out: Vec<f64> = Vec::new();
    for &(t, c) in samples {
        if c >= SCENE_CHANGE
            && c >= median * SCENE_OVER_MEDIAN
            && !turning(t)
            && out.last().is_none_or(|&last| t - last >= SCENE_MERGE_MS)
        {
            out.push(t);
        }
    }
    out
}

struct Span {
    start: f64,
    end: f64,
    wait: bool,
    scene_end: bool,
}

/// Splits the recording into steps.
pub fn build(lines: &[Value], duration: f64) -> Value {
    let samples: Vec<(f64, f64)> = lines
        .iter()
        .filter(|l| l.get("change").is_some())
        .map(|l| (num(l, "t"), num(l, "change")))
        .collect();
    let frames: Vec<(f64, String)> = lines
        .iter()
        .filter_map(|l| Some((num(l, "t"), l["frame"].as_str()?.to_string())))
        .collect();
    let duration = duration.max(samples.last().map_or(0.0, |s| s.0));
    let by = if lines.iter().any(|l| l["by"] == "you") {
        "you"
    } else {
        "wick"
    };
    let acts = actions(lines, by, duration);
    let scenes = scene_changes(&samples, &acts);

    // Activity spans and waits between them.
    let mut spans: Vec<Span> = Vec::new();
    let mut cursor = 0.0;
    let mut active: Option<(f64, f64)> = None;
    let close = |spans: &mut Vec<Span>, (s, e): (f64, f64)| {
        spans.push(Span {
            start: s,
            end: e,
            wait: false,
            scene_end: false,
        })
    };
    for a in &acts {
        match active {
            Some((s, e)) if a.t - e < PAUSE_MS => active = Some((s, e.max(a.end))),
            Some((s, e)) => {
                if a.t - e >= IDLE_MS {
                    close(&mut spans, (s, e));
                    spans.push(Span {
                        start: e,
                        end: a.t,
                        wait: true,
                        scene_end: false,
                    });
                } else {
                    close(&mut spans, (s, a.t));
                }
                active = Some((a.t, a.end));
            }
            None => {
                if a.t - cursor >= IDLE_MS {
                    spans.push(Span {
                        start: cursor,
                        end: a.t,
                        wait: true,
                        scene_end: false,
                    });
                    active = Some((a.t, a.end));
                } else {
                    active = Some((cursor, a.end));
                }
            }
        }
        cursor = a.t;
    }
    match active {
        Some((s, e)) => {
            if duration - e >= IDLE_MS {
                close(&mut spans, (s, e));
                spans.push(Span {
                    start: e,
                    end: duration,
                    wait: true,
                    scene_end: false,
                });
            } else {
                close(&mut spans, (s, duration));
            }
        }
        None => spans.push(Span {
            start: 0.0,
            end: duration,
            wait: true,
            scene_end: false,
        }),
    }

    // Scene changes split whatever span they land in.
    for &t in &scenes {
        if let Some(i) = spans
            .iter()
            .position(|s| t > s.start + 200.0 && t < s.end - 200.0)
        {
            let tail = Span {
                start: t,
                end: spans[i].end,
                wait: spans[i].wait,
                scene_end: spans[i].scene_end,
            };
            spans[i].end = t;
            spans[i].scene_end = true;
            // A short wait after the change belongs to what comes next:
            // that's what the person did once the screen changed.
            let next_acts = spans.get(i + 1).is_some_and(|n| !n.wait);
            if tail.wait && tail.end - tail.start < IDLE_MS && next_acts {
                spans[i + 1].start = t;
            } else {
                spans.insert(i + 1, tail);
            }
        } else if let Some(s) = spans.iter_mut().find(|s| (s.end - t).abs() <= 200.0) {
            s.scene_end = true;
        }
    }

    let frame_at = |t: f64, after: bool| -> Option<&String> {
        if after {
            frames
                .iter()
                .find(|(ft, _)| *ft >= t)
                .or(frames.last())
                .map(|f| &f.1)
        } else {
            frames
                .iter()
                .rev()
                .find(|(ft, _)| *ft < t)
                .or(frames.first())
                .map(|f| &f.1)
        }
    };
    let steps: Vec<Value> = spans
        .iter()
        .enumerate()
        .map(|(i, span)| {
            let last = i + 1 == spans.len();
            let in_step: Vec<&Act> = acts
                .iter()
                .filter(|a| a.t >= span.start && (a.t < span.end || (last && a.t <= span.end)))
                .collect();
            let changes: Vec<f64> = samples
                .iter()
                .filter(|(t, _)| *t > span.start && *t <= span.end)
                .map(|s| s.1)
                .collect();
            let mean = changes.iter().sum::<f64>() / changes.len().max(1) as f64;
            let max = changes.iter().copied().fold(0.0, f64::max);
            let wait = span.wait || in_step.is_empty();
            json!({
                "n": i + 1,
                "start": round1(span.start),
                "end": round1(span.end),
                "kind": if wait { "wait" } else { "act" },
                "label": label(&in_step, span, wait),
                "actions": in_step.iter().map(|a| a.json()).collect::<Vec<_>>(),
                "change": { "mean": (mean * 10000.0).round() / 10000.0, "max": (max * 10000.0).round() / 10000.0 },
                "sceneChange": span.scene_end,
                "startFrame": frame_at(span.start, true),
                "endFrame": frame_at(span.end, false),
            })
        })
        .collect();
    json!({
        "seconds": round1(duration / 1000.0),
        "by": by,
        "steps": steps,
        "sceneChanges": scenes.iter().map(|t| round1(*t)).collect::<Vec<_>>(),
    })
}

fn secs(ms: f64) -> String {
    format!("{:.1} s", ms / 1000.0)
}

fn label(acts: &[&Act], span: &Span, wait: bool) -> String {
    let scene = if span.scene_end {
        " until the screen changes"
    } else {
        ""
    };
    if wait {
        return format!("wait {}{scene}", secs(span.end - span.start));
    }
    let mut parts: Vec<String> = Vec::new();
    let mut holds: Vec<(String, f64)> = Vec::new();
    let mut presses: Vec<(String, usize)> = Vec::new();
    let mut clicks: HashMap<String, usize> = HashMap::new();
    let (mut dx, mut dy, mut turned) = (0.0, 0.0, false);
    let mut order: Vec<&str> = Vec::new();
    for a in acts {
        match &a.what {
            Do::Hold { key } => {
                match holds.iter_mut().find(|h| &h.0 == key) {
                    Some(h) => h.1 += a.end - a.t,
                    None => holds.push((key.clone(), a.end - a.t)),
                }
                order.push("hold");
            }
            Do::Press { key } => {
                match presses.iter_mut().find(|p| &p.0 == key) {
                    Some(p) => p.1 += 1,
                    None => presses.push((key.clone(), 1)),
                }
                order.push("press");
            }
            Do::Click { button } => {
                *clicks.entry(button.clone()).or_default() += 1;
                order.push("click");
            }
            Do::Turn { dx: x, dy: y } => {
                dx += x;
                dy += y;
                turned = true;
                order.push("turn");
            }
        }
    }
    order.dedup();
    let mut seen = Vec::new();
    for kind in order {
        if seen.contains(&kind) {
            continue;
        }
        seen.push(kind);
        match kind {
            "hold" => parts.push(format!(
                "hold {}",
                holds
                    .iter()
                    .map(|(k, ms)| format!("{k} {}", secs(*ms)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            "press" => parts.push(format!(
                "press {}",
                presses
                    .iter()
                    .map(|(k, n)| if *n > 1 {
                        format!("{k} ×{n}")
                    } else {
                        k.clone()
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            "click" => {
                let mut list: Vec<_> = clicks.iter().collect();
                list.sort();
                parts.push(
                    list.iter()
                        .map(|(b, n)| {
                            let b = if b.as_str() == "left" {
                                String::new()
                            } else {
                                format!("{b} ")
                            };
                            if **n > 1 {
                                format!("{b}click ×{n}")
                            } else {
                                format!("{b}click")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(", "),
                )
            }
            "turn" if turned => {
                let mut t = Vec::new();
                if dx.abs() >= 2.0 {
                    t.push(format!(
                        "{} {}",
                        if dx > 0.0 { "right" } else { "left" },
                        dx.abs().round()
                    ));
                }
                if dy.abs() >= 2.0 {
                    t.push(format!(
                        "{} {}",
                        if dy > 0.0 { "down" } else { "up" },
                        dy.abs().round()
                    ));
                }
                if !t.is_empty() {
                    parts.push(format!("mouse {}", t.join(" ")));
                }
            }
            _ => {}
        }
    }
    format!("{}{scene}", parts.join(", then "))
}

/// Writes `storyboard.json`, `storyboard.md` and `storyboard.png` (each
/// step's end frame) next to the recording. Returns a short summary.
pub fn write(dir: &Path, board: &Value) -> Result<Value, String> {
    let steps = board["steps"].as_array().cloned().unwrap_or_default();
    std::fs::write(
        dir.join("storyboard.json"),
        serde_json::to_string_pretty(board).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let mut md = format!(
        "# Storyboard\n\n{} s recorded, {} steps, from {} inputs. Times are milliseconds from the start of the recording; positions are fractions of the recorded area. The sheet `storyboard.png` shows each step's last frame, in order.\n\n",
        board["seconds"],
        steps.len(),
        if board["by"] == "you" { "your" } else { "Wick's" }
    );
    for s in &steps {
        md.push_str(&format!(
            "{}. **{}–{} s** · {}{}\n",
            s["n"],
            fmt_s(&s["start"]),
            fmt_s(&s["end"]),
            s["label"].as_str().unwrap_or(""),
            match (s["startFrame"].as_str(), s["endFrame"].as_str()) {
                (Some(a), Some(b)) if a != b => format!(" · `{a}` → `{b}`"),
                (Some(a), _) => format!(" · `{a}`"),
                _ => String::new(),
            }
        ));
        for a in s["actions"].as_array().into_iter().flatten().take(40) {
            md.push_str(&format!("   - {}\n", describe(a)));
        }
        let n = s["actions"].as_array().map_or(0, Vec::len);
        if n > 40 {
            md.push_str(&format!("   - … {} more in storyboard.json\n", n - 40));
        }
    }
    std::fs::write(dir.join("storyboard.md"), md).map_err(|e| e.to_string())?;

    let files: Vec<_> = steps
        .iter()
        .filter_map(|s| s["endFrame"].as_str())
        .take(SHEET_TILES)
        .map(|f| dir.join(f))
        .collect();
    let sheet = dir.join("storyboard.png");
    let has_sheet = crate::record::sheet(&files, &sheet)?;
    Ok(json!({
        "path": dir.join("storyboard.md"),
        "json": dir.join("storyboard.json"),
        "sheet": has_sheet.then_some(sheet),
        "steps": steps.len(),
        "outline": steps.iter().take(30).map(|s| format!("{}. {}–{} s: {}", s["n"], fmt_s(&s["start"]), fmt_s(&s["end"]), s["label"].as_str().unwrap_or(""))).collect::<Vec<_>>(),
    }))
}

fn fmt_s(ms: &Value) -> String {
    format!("{:.1}", ms.as_f64().unwrap_or(0.0) / 1000.0)
}

fn describe(a: &Value) -> String {
    let t = a["t"].as_f64().unwrap_or(0.0);
    let at = |k: &str| {
        a.get(k)
            .and_then(Value::as_array)
            .map(|p| format!(" at {}, {}", p[0], p[1]))
            .unwrap_or_default()
    };
    match a["do"].as_str().unwrap_or("") {
        "hold" => format!(
            "{t} hold {} for {} ms",
            a["key"].as_str().unwrap_or(""),
            a["ms"]
        ),
        "press" => format!("{t} press {}", a["key"].as_str().unwrap_or("")),
        "click" => format!(
            "{t} {} click{}",
            a["button"].as_str().unwrap_or("left"),
            at("at")
        ),
        "turn" => format!(
            "{t} mouse {}, {} over {} ms{}",
            a["dx"],
            a["dy"],
            a["ms"],
            at("to")
        ),
        other => format!("{t} {other}"),
    }
}

/// Rebuilds the storyboard of an existing recording from its log.
pub fn rebuild(dir: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(dir.join("record.jsonl"))
        .map_err(|e| format!("No recording in {}: {e}", dir.display()))?;
    let lines: Vec<Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let board = build(&lines, 0.0);
    write(dir, &board)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t: f64, change: f64) -> Value {
        json!({ "t": t, "change": change, "frame": format!("frames/{:06}.png", t as u64) })
    }
    fn key(t: f64, k: &str, down: bool) -> Value {
        json!({ "t": t, "by": "you", "input": if down { "keyDown" } else { "keyUp" }, "key": k })
    }
    fn click(t: f64, down: bool) -> Value {
        json!({ "t": t, "by": "you", "input": if down { "mouseDown" } else { "mouseUp" }, "button": "left", "at": [0.5, 0.5] })
    }

    /// Walk, press E, wait for a bite (the screen changes), click a
    /// minigame, then walk again.
    fn demo() -> Vec<Value> {
        let mut lines = Vec::new();
        for i in 0..=120 {
            let t = i as f64 * 100.0;
            // The minigame appears at 5.0 s and goes away at 9.0 s.
            let c = if t == 5000.0 || t == 9000.0 {
                0.3
            } else {
                0.004
            };
            lines.push(sample(t, c));
        }
        lines.push(key(200.0, "w", true));
        lines.push(key(2200.0, "w", false));
        lines.push(json!({ "t": 1000.0, "by": "you", "input": "mouse", "dx": 120.0, "dy": -4.0 }));
        lines.push(json!({ "t": 1100.0, "by": "you", "input": "mouse", "dx": 80.0, "dy": 0.0, "at": [0.5, 0.5] }));
        lines.push(key(2400.0, "e", true));
        lines.push(key(2480.0, "e", false));
        for k in 0..10 {
            let t = 5300.0 + k as f64 * 300.0;
            lines.push(click(t, true));
            lines.push(click(t + 60.0, false));
        }
        lines.push(key(10000.0, "s", true));
        lines.push(key(11500.0, "s", false));
        lines.sort_by(|a, b| num(a, "t").total_cmp(&num(b, "t")));
        lines
    }

    #[test]
    fn pairs_inputs_into_actions() {
        let acts = actions(&demo(), "you", 12000.0);
        let holds: Vec<_> = acts
            .iter()
            .filter(|a| matches!(a.what, Do::Hold { .. }))
            .collect();
        assert_eq!(holds.len(), 2);
        assert_eq!(holds[0].end - holds[0].t, 2000.0);
        assert!(acts.iter().any(|a| a.what == Do::Press { key: "e".into() }));
        let turn = acts
            .iter()
            .find(|a| matches!(a.what, Do::Turn { .. }))
            .unwrap();
        assert_eq!(
            turn.what,
            Do::Turn {
                dx: 200.0,
                dy: -4.0
            }
        );
        assert_eq!(turn.at, Some(json!([0.5, 0.5])));
        assert_eq!(
            acts.iter()
                .filter(|a| matches!(a.what, Do::Click { .. }))
                .count(),
            10
        );
    }

    #[test]
    fn splits_a_demonstration_into_steps() {
        let board = build(&demo(), 12000.0);
        let steps = board["steps"].as_array().unwrap();
        let labels: Vec<&str> = steps.iter().map(|s| s["label"].as_str().unwrap()).collect();
        assert_eq!(
            labels,
            [
                "hold w 2.0 s, then mouse right 200 up 4, then press e",
                "wait 2.5 s until the screen changes",
                "click ×10",
                "wait 0.9 s until the screen changes",
                "hold s 1.5 s",
            ],
            "{board:#}"
        );
        assert_eq!(steps[1]["kind"], "wait");
        assert_eq!(steps[2]["start"], json!(5000.0));
        assert_eq!(steps[2]["startFrame"], "frames/005000.png");
        assert_eq!(board["sceneChanges"], json!([5000.0, 9000.0]));
    }

    #[test]
    fn idle_recordings_are_one_wait() {
        let lines: Vec<Value> = (0..30).map(|i| sample(i as f64 * 100.0, 0.0)).collect();
        let board = build(&lines, 3000.0);
        assert_eq!(board["steps"].as_array().unwrap().len(), 1);
        assert_eq!(board["steps"][0]["kind"], "wait");
    }
}
