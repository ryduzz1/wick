//! A session watches one target on its own thread: it pulls frames, steps
//! the attached macro, and streams previews and stats to the app.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::frame::Frame;
use crate::rpc::Emitter;
use crate::run::{MacroRun, MacroSpec, RunEnd};
use crate::sim::{Scenario, SimTarget};
use crate::target::Target;
use crate::window_target::{WindowKind, WindowTarget};

const PREVIEW_EVERY: Duration = Duration::from_millis(125);
const STATS_EVERY: Duration = Duration::from_millis(250);
const PREVIEW_WIDTH: usize = 480;
const FRAME_WAIT: Duration = Duration::from_millis(50);

pub const TARGETS: [&str; 3] = ["roblox", "testbench", "sim"];

pub fn make_target(id: &str, scenario: Option<Scenario>, realtime: bool) -> Result<Box<dyn Target>, String> {
    match id {
        "roblox" => Ok(Box::new(WindowTarget::new(WindowKind::Roblox))),
        "testbench" => Ok(Box::new(WindowTarget::new(WindowKind::Testbench))),
        "sim" => Ok(Box::new(SimTarget::new(scenario.unwrap_or_default(), realtime))),
        other => Err(format!("Unknown target \"{other}\". Use one of: {}.", TARGETS.join(", "))),
    }
}

pub enum Msg {
    Run(Box<MacroSpec>, Sender<Result<(), String>>),
    StopMacro(String),
    Snapshot(std::path::PathBuf, Sender<Result<Value, String>>),
    Close,
}

pub struct Session {
    pub target: String,
    tx: Sender<Msg>,
    join: Option<JoinHandle<()>>,
}

impl Session {
    pub fn spawn(
        target: &str,
        scenario: Option<Scenario>,
        emitter: Emitter,
        kills: Arc<AtomicU64>,
    ) -> Result<Session, String> {
        // Validate before spawning so a bad id fails the request.
        make_target(target, scenario.clone(), true)?;
        let (tx, rx) = mpsc::channel();
        let id = target.to_string();
        let join = std::thread::Builder::new()
            .name(format!("wick-session-{id}"))
            .spawn(move || {
                let target = make_target(&id, scenario, true).expect("validated above");
                session_loop(target, rx, emitter, kills);
            })
            .map_err(|e| e.to_string())?;
        Ok(Session { target: target.to_string(), tx, join: Some(join) })
    }

    pub fn send(&self, msg: Msg) -> Result<(), String> {
        self.tx.send(msg).map_err(|_| "The session stopped".to_string())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Close);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn preview(frame: &Frame, target: &dyn Target, run: Option<&MacroRun>) -> Value {
    let (w, h, rgba) = frame.preview_rgba(PREVIEW_WIDTH);
    json!({
        "target": target.id(),
        "width": w,
        "height": h,
        "rgba": base64::engine::general_purpose::STANDARD.encode(rgba),
        "viewport": target.viewport().normalized(frame.width, frame.height),
        "overlay": run.map(|r| r.overlay(frame.width, frame.height)),
    })
}

fn end_run(run: &mut MacroRun, end: RunEnd, target: &mut dyn Target, emitter: &Emitter) {
    run.finish(target);
    let mut params = run.stats(target);
    params["end"] = end.to_json();
    emitter.event("macro.end", params);
}

fn session_loop(mut target: Box<dyn Target>, rx: Receiver<Msg>, emitter: Emitter, kills: Arc<AtomicU64>) {
    let mut run: Option<(MacroRun, u64)> = None;
    let mut last_frame: Option<Arc<Frame>> = None;
    let (mut last_preview, mut last_stats) = (Instant::now() - PREVIEW_EVERY, Instant::now());
    let (mut frames, mut busy) = (0u32, Duration::ZERO);
    let mut emit = |method: &str, params: Value| emitter.event(method, params);

    loop {
        while let Ok(msg) = rx.try_recv() {
            match msg {
                Msg::Run(spec, reply) => {
                    if let Some((mut r, _)) = run.take() {
                        end_run(&mut r, RunEnd::Stopped("replaced by a new run".into()), target.as_mut(), &emitter);
                    }
                    match MacroRun::start(*spec, target.as_ref()) {
                        Ok(r) => {
                            emitter.event("macro.state", json!({ "state": "running", "id": r.spec.id }));
                            run = Some((r, kills.load(Ordering::SeqCst)));
                            let _ = reply.send(Ok(()));
                        }
                        Err(e) => {
                            let _ = reply.send(Err(e));
                        }
                    }
                }
                Msg::StopMacro(why) => {
                    if let Some((mut r, _)) = run.take() {
                        end_run(&mut r, RunEnd::Stopped(why), target.as_mut(), &emitter);
                    }
                }
                Msg::Snapshot(path, reply) => {
                    let result = match &last_frame {
                        Some(f) => f.write_png(&path).map(|_| {
                            json!({ "path": path, "width": f.width, "height": f.height,
                                    "viewport": target.viewport() })
                        }),
                        None => Err("No frame has been captured yet".into()),
                    };
                    let _ = reply.send(result);
                }
                Msg::Close => {
                    if let Some((mut r, _)) = run.take() {
                        end_run(&mut r, RunEnd::Stopped("session closed".into()), target.as_mut(), &emitter);
                    }
                    return;
                }
            }
        }

        if let Some((r, epoch)) = &mut run {
            if kills.load(Ordering::SeqCst) != *epoch {
                end_run(r, RunEnd::Stopped("kill switch".into()), target.as_mut(), &emitter);
                run = None;
            }
        }

        let frame = target.next_frame(FRAME_WAIT);
        let started = Instant::now();
        if frame.is_some() {
            frames += 1;
            last_frame = frame.clone();
        }
        if let Some((r, _)) = &mut run {
            if let Some(end) = r.tick(target.as_mut(), frame.as_deref(), &mut emit) {
                end_run(r, end, target.as_mut(), &emitter);
                run = None;
            }
        }
        busy += started.elapsed();

        if let Some(f) = &frame {
            if last_preview.elapsed() >= PREVIEW_EVERY {
                last_preview = Instant::now();
                emitter.event("preview", preview(f, target.as_ref(), run.as_ref().map(|(r, _)| r)));
            }
        }
        if last_stats.elapsed() >= STATS_EVERY {
            let secs = last_stats.elapsed().as_secs_f64();
            let mut status = target.status();
            status["target"] = json!(target.id());
            status["fps"] = json!(frames as f64 / secs);
            status["tickMs"] = json!(if frames > 0 { busy.as_secs_f64() * 1000.0 / frames as f64 } else { 0.0 });
            status["latency"] = json!(target.latency());
            emitter.event("session.stats", status);
            if let Some((r, _)) = &run {
                emitter.event("macro.stats", r.stats(target.as_ref()));
            }
            last_stats = Instant::now();
            frames = 0;
            busy = Duration::ZERO;
        }
    }
}

/// Runs a macro on the simulator as fast as possible and returns the result.
pub fn run_headless(spec: MacroSpec, scenario: Scenario, seconds: f64) -> Result<Value, String> {
    let mut target = SimTarget::new(scenario, false);
    let mut run = MacroRun::start(spec, &target)?;
    let mut logs = Vec::new();
    let mut end = RunEnd::Stopped("time limit".into());
    while target.now_ms() < seconds * 1000.0 {
        let frame = target.next_frame(Duration::ZERO);
        let mut emit = |method: &str, params: Value| {
            if method == "macro.log" && logs.len() < 200 {
                logs.push(params["text"].clone());
            }
        };
        if let Some(e) = run.tick(&mut target, frame.as_deref(), &mut emit) {
            end = e;
            break;
        }
    }
    run.finish(&mut target);
    let mut result = run.stats(&target);
    result["end"] = end.to_json();
    result["logs"] = json!(logs);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::region::RegionSpec;
    use std::collections::HashMap;

    const CONTROLLER: &str = r##"
        export default { async run(ctx) {
          const zone = ctx.screen.track("bar", { color: "#3ccf5a", tolerance: 40 });
          const tick = ctx.screen.track("bar", { color: "#ffffff", tolerance: 40, minPixels: 2 });
          await ctx.loop.hz(120, () => {
            if (!zone.seen || !tick.seen) return;
            if (tick.x + tick.velocity * ctx.input.latency < zone.center) ctx.input.click({ minGap: 60 });
          });
        } };
    "##;

    fn spec(main: &str, permissions: &[&str]) -> MacroSpec {
        MacroSpec {
            id: "test/bar".into(),
            name: "Bar".into(),
            files: HashMap::from([("main.ts".into(), main.into())]),
            entry: "main.ts".into(),
            permissions: permissions.iter().map(|p| p.to_string()).collect(),
            regions: HashMap::from([(
                "bar".into(),
                RegionSpec { anchor: "bottom-center".into(), x: 0.0, y: -0.18, w: 0.46, h: 0.06 },
            )]),
            settings: json!({}),
        }
    }

    #[test]
    fn a_simple_controller_keeps_the_tick_in_the_zone() {
        let scores: Vec<f64> = (1..=5)
            .map(|seed| {
                let r = run_headless(spec(CONTROLLER, &["mouse.click"]), Scenario { seed, ..Scenario::default() }, 20.0)
                    .unwrap();
                r["score"]["inZone"].as_f64().unwrap()
            })
            .collect();
        let avg = scores.iter().sum::<f64>() / scores.len() as f64;
        assert!(avg > 0.85, "scores {scores:?}");
    }

    #[test]
    fn doing_nothing_scores_badly() {
        let idle = r#"export default { async run(ctx) { await ctx.wait(1e9); } };"#;
        let r = run_headless(spec(idle, &[]), Scenario::default(), 20.0).unwrap();
        assert!(r["score"]["inZone"].as_f64().unwrap() < 0.3, "{r}");
    }

    #[test]
    fn undeclared_input_stops_the_macro() {
        let r = run_headless(spec(CONTROLLER, &[]), Scenario::default(), 5.0).unwrap();
        assert_eq!(r["end"]["reason"], "error");
        assert!(r["end"]["error"].as_str().unwrap().contains("mouse.click"), "{r}");
        assert_eq!(r["inputs"], 0);
    }

    #[test]
    fn unknown_regions_are_reported() {
        let bad = r##"export default { async run(ctx) { ctx.screen.track("nope", { color: "#ffffff" }); await ctx.wait(100); } };"##;
        let r = run_headless(spec(bad, &[]), Scenario::default(), 1.0).unwrap();
        assert!(r["end"]["error"].as_str().unwrap().contains("Unknown region \"nope\""), "{r}");
    }
}
