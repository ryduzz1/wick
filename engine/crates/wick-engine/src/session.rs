//! A session watches one target on its own thread: it pulls frames, steps
//! the attached macro, and streams previews and stats to the app.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use std::collections::HashMap;

use crate::frame::Frame;
use crate::input::{Action, Command, InputState};
use crate::probe::{self, DetectSpec, Probe, ProbeSpec};
use crate::record::{RecordSpec, Recorder};
use crate::region::RegionSpec;
use crate::rpc::Emitter;
use crate::run::{MacroRun, MacroSpec, RunEnd};
use crate::sim::{Scenario, SimTarget};
use crate::target::Target;
use crate::window_target::{WindowKind, WindowTarget};

const PREVIEW_EVERY: Duration = Duration::from_millis(125);
const STATS_EVERY: Duration = Duration::from_millis(250);
const TRACE_EVERY: Duration = Duration::from_millis(50);
const PREVIEW_WIDTH: usize = 480;
const FRAME_WAIT: Duration = Duration::from_millis(50);

pub const TARGETS: [&str; 3] = ["roblox", "testbench", "sim"];

pub fn make_target(
    id: &str,
    scenario: Option<Scenario>,
    realtime: bool,
) -> Result<Box<dyn Target>, String> {
    match id {
        "roblox" => Ok(Box::new(WindowTarget::new(WindowKind::Roblox))),
        "testbench" => Ok(Box::new(WindowTarget::new(WindowKind::Testbench))),
        "sim" => Ok(Box::new(SimTarget::new(
            scenario.unwrap_or_default(),
            realtime,
        ))),
        other => Err(format!(
            "Unknown target \"{other}\". Use one of: {}.",
            TARGETS.join(", ")
        )),
    }
}

/// Where a session sends the answer to a request.
pub type Reply = Sender<Result<Value, String>>;

pub enum Msg {
    Run(Box<MacroSpec>, Sender<Result<(), String>>),
    StopMacro(String),
    Snapshot(std::path::PathBuf, Option<RegionSpec>, Reply),
    Detect(Box<DetectSpec>, Reply),
    /// One input from an agent, with the regions its position may refer to.
    Act(Box<Command>, HashMap<String, RegionSpec>, Reply),
    Probe(Box<ProbeSpec>, Reply),
    Record(Box<RecordSpec>, Reply),
    /// Ends a recording early, keeping what it has.
    StopRecord,
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
        Ok(Session {
            target: target.to_string(),
            tx,
            join: Some(join),
        })
    }

    pub fn send(&self, msg: Msg) -> Result<(), String> {
        self.tx
            .send(msg)
            .map_err(|_| "The session stopped".to_string())
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

fn session_loop(
    mut target: Box<dyn Target>,
    rx: Receiver<Msg>,
    emitter: Emitter,
    kills: Arc<AtomicU64>,
) {
    let mut run: Option<(MacroRun, u64)> = None;
    let mut probe: Option<(Probe, Reply)> = None;
    let mut recording: Option<(Recorder, Reply)> = None;
    // Inputs the running macro sent since the last trace event.
    let mut trace_inputs: Vec<Value> = Vec::new();
    let mut last_trace = Instant::now();
    // Single inputs from agents, gated and released like a macro's.
    let mut agent = InputState::default();
    let mut agent_epoch = kills.load(Ordering::SeqCst);
    let mut last_frame: Option<Arc<Frame>> = None;
    let (mut last_preview, mut last_stats) = (Instant::now() - PREVIEW_EVERY, Instant::now());
    let (mut frames, mut busy) = (0u32, Duration::ZERO);
    let mut emit = |method: &str, params: Value| emitter.event(method, params);

    loop {
        while let Ok(msg) = rx.try_recv() {
            match msg {
                Msg::Run(spec, reply) => {
                    if let Some((mut r, _)) = run.take() {
                        end_run(
                            &mut r,
                            RunEnd::Stopped("replaced by a new run".into()),
                            target.as_mut(),
                            &emitter,
                        );
                    }
                    match MacroRun::start(*spec, target.as_ref()) {
                        Ok(mut r) => {
                            emitter.event(
                                "macro.state",
                                json!({ "state": "running", "id": r.spec.id }),
                            );
                            r.trace = Some(Vec::new());
                            r.input.logging = true;
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
                Msg::Snapshot(path, region, reply) => {
                    let result = match &last_frame {
                        Some(f) => probe::snapshot(f, target.viewport(), region.as_ref(), &path),
                        None => Err(no_frame(target.as_mut())),
                    };
                    let _ = reply.send(result);
                }
                Msg::Detect(spec, reply) => {
                    let result = match &last_frame {
                        Some(f) => probe::detect(f, target.viewport(), &spec),
                        None => Err(no_frame(target.as_mut())),
                    };
                    let _ = reply.send(result);
                }
                Msg::Act(command, regions, reply) => {
                    let _ = reply.send(act(target.as_mut(), &mut agent, *command, &regions));
                }
                Msg::Probe(spec, reply) => {
                    if run.is_some() || probe.is_some() {
                        let _ = reply.send(Err(
                            "Something is already running on this target. Stop it first.".into(),
                        ));
                    } else {
                        match Probe::start(*spec, target.as_ref()) {
                            Ok(p) => probe = Some((p, reply)),
                            Err(e) => {
                                let _ = reply.send(Err(e));
                            }
                        }
                    }
                }
                Msg::Record(spec, reply) => {
                    if recording.is_some() {
                        let _ = reply.send(Err("A recording is already running.".into()));
                    } else {
                        match Recorder::start(*spec, target.as_mut()) {
                            Ok(r) => recording = Some((r, reply)),
                            Err(e) => {
                                let _ = reply.send(Err(e));
                            }
                        }
                    }
                }
                Msg::StopRecord => {
                    if let Some((mut r, reply)) = recording.take() {
                        let _ = reply.send(r.abort(target.as_mut()));
                    }
                }
                Msg::Close => {
                    if let Some((mut r, reply)) = recording.take() {
                        let _ = reply.send(r.abort(target.as_mut()));
                    }
                    if let Some((mut p, reply)) = probe.take() {
                        p.abort(target.as_mut());
                        let _ = reply.send(Err("The session closed".into()));
                    }
                    let focused = target.focused();
                    agent.release_all(focused, &mut |a| target.send(a));
                    if let Some((mut r, _)) = run.take() {
                        end_run(
                            &mut r,
                            RunEnd::Stopped("session closed".into()),
                            target.as_mut(),
                            &emitter,
                        );
                    }
                    return;
                }
            }
        }

        if let Some((r, epoch)) = &mut run {
            if kills.load(Ordering::SeqCst) != *epoch {
                end_run(
                    r,
                    RunEnd::Stopped("kill switch".into()),
                    target.as_mut(),
                    &emitter,
                );
                run = None;
            }
        }

        let epoch = kills.load(Ordering::SeqCst);
        if epoch != agent_epoch {
            agent_epoch = epoch;
            let focused = target.focused();
            agent.release_all(focused, &mut |a| target.send(a));
            if let Some((mut p, reply)) = probe.take() {
                p.abort(target.as_mut());
                let _ = reply.send(Err("Stopped by the kill switch".into()));
            }
        }

        let frame = target.next_frame(FRAME_WAIT);
        let started = Instant::now();
        if frame.is_some() {
            frames += 1;
            last_frame = frame.clone();
        }
        agent.logging = recording.is_some();
        {
            let (now, focused) = (target.now_ms(), target.focused());
            let _ = agent.flush(now, focused, &mut |a| target.send(a));
        }
        if let Some((p, _)) = &mut probe {
            match p.tick(target.as_mut(), frame.as_deref()) {
                Ok(None) => {}
                Ok(Some(result)) => {
                    let (_, reply) = probe.take().unwrap();
                    let _ = reply.send(Ok(result));
                }
                Err(e) => {
                    let (mut p, reply) = probe.take().unwrap();
                    p.abort(target.as_mut());
                    let _ = reply.send(Err(e));
                }
            }
        }
        let mut run_sent = Vec::new();
        if let Some((r, _)) = &mut run {
            let end = r.tick(target.as_mut(), frame.as_deref(), &mut emit);
            run_sent = r.input.take_log();
            if let Some(end) = end {
                end_run(r, end, target.as_mut(), &emitter);
                run = None;
            }
        }
        for (t, action) in &run_sent {
            match action {
                Action::Button { button, down: true } => trace_inputs.push(json!([
                    t.round(),
                    format!("{button:?}").to_ascii_lowercase()
                ])),
                Action::Key { name, down: true } => trace_inputs.push(json!([t.round(), name])),
                _ => {}
            }
        }
        if last_trace.elapsed() >= TRACE_EVERY {
            last_trace = Instant::now();
            if let Some((r, _)) = &mut run {
                let samples = r.trace.as_mut().map(std::mem::take).unwrap_or_default();
                if !samples.is_empty() || !trace_inputs.is_empty() {
                    emitter.event(
                        "macro.trace",
                        json!({ "samples": samples, "inputs": std::mem::take(&mut trace_inputs), "trackers": r.trace_labels() }),
                    );
                }
            } else {
                trace_inputs.clear();
            }
        }
        if let Some((rec, _)) = &mut recording {
            let mut sent = agent.take_log();
            sent.extend(run_sent);
            let done = rec.tick(target.as_mut(), frame.as_deref(), &sent);
            if !matches!(done, Ok(None)) {
                let (mut rec, reply) = recording.take().unwrap();
                let result = done.map(|r| r.unwrap_or(Value::Null));
                if result.is_err() {
                    let _ = rec.abort(target.as_mut());
                }
                let _ = reply.send(result);
            }
        }
        busy += started.elapsed();

        if let Some(f) = &frame {
            if last_preview.elapsed() >= PREVIEW_EVERY {
                last_preview = Instant::now();
                emitter.event(
                    "preview",
                    preview(f, target.as_ref(), run.as_ref().map(|(r, _)| r)),
                );
            }
        }
        if last_stats.elapsed() >= STATS_EVERY {
            let secs = last_stats.elapsed().as_secs_f64();
            let mut status = target.status();
            status["target"] = json!(target.id());
            status["fps"] = json!(frames as f64 / secs);
            status["tickMs"] = json!(if frames > 0 {
                busy.as_secs_f64() * 1000.0 / frames as f64
            } else {
                0.0
            });
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

fn no_frame(target: &mut dyn Target) -> String {
    let status = target.status();
    match status["error"].as_str() {
        Some(e) => format!("No frame yet: {e}"),
        None if status["found"] == json!(false) => {
            format!("No frame yet: the {} window isn't open.", target.id())
        }
        None => "No frame has been captured yet. Try again in a moment.".into(),
    }
}

/// Sends one input from an agent, if the target has focus.
fn act(
    target: &mut dyn Target,
    input: &mut InputState,
    command: Command,
    regions: &HashMap<String, RegionSpec>,
) -> Result<Value, String> {
    for (name, r) in regions {
        r.validate(name)?;
    }
    if !target.focused() {
        return Err(format!(
            "Nothing was sent: the {} window doesn't have focus. Ask the user to click it, then try again.",
            target.id()
        ));
    }
    let (now, viewport) = (target.now_ms(), target.viewport());
    input.schedule(command, now, |at| probe::locate(regions, viewport, at))?;
    let before = input.sent;
    input.flush(now, true, &mut |a| target.send(a))?;
    Ok(json!({ "sent": input.sent - before }))
}

/// Runs a probe on the simulator as fast as possible.
pub fn probe_headless(spec: ProbeSpec, scenario: Scenario) -> Result<Value, String> {
    let mut target = SimTarget::new(scenario, false);
    let mut probe = Probe::start(spec, &target)?;
    loop {
        let frame = target.next_frame(Duration::ZERO);
        if let Some(result) = probe.tick(&mut target, frame.as_deref())? {
            return Ok(result);
        }
    }
}

/// Records the simulator as fast as possible, running a macro meanwhile if
/// one is given.
pub fn record_headless(
    spec: RecordSpec,
    scenario: Scenario,
    macro_spec: Option<MacroSpec>,
) -> Result<Value, String> {
    let mut target = SimTarget::new(scenario, false);
    let mut run = macro_spec
        .map(|m| MacroRun::start(m, &target))
        .transpose()?;
    let mut recorder = Recorder::start(spec, &mut target)?;
    let mut end = None;
    loop {
        let frame = target.next_frame(Duration::ZERO);
        let mut sent = Vec::new();
        if let Some(r) = &mut run {
            r.input.logging = true;
            if let Some(e) = r.tick(&mut target, frame.as_deref(), &mut |_, _| {}) {
                end = Some(e.to_json());
                r.finish(&mut target);
                sent = r.input.take_log();
                run = None;
            } else {
                sent = r.input.take_log();
            }
        }
        if let Some(mut result) = recorder.tick(&mut target, frame.as_deref(), &sent)? {
            if let Some(mut r) = run {
                r.finish(&mut target);
                result["run"] = r.stats(&target);
            }
            if let Some(end) = end {
                result["end"] = end;
            }
            return Ok(result);
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
                RegionSpec {
                    anchor: "bottom-center".into(),
                    x: 0.0,
                    y: -0.18,
                    w: 0.46,
                    h: 0.06,
                },
            )]),
            settings: json!({}),
            human: None,
            game: Default::default(),
        }
    }

    #[test]
    fn a_simple_controller_keeps_the_tick_in_the_zone() {
        let scores: Vec<f64> = (1..=5)
            .map(|seed| {
                let r = run_headless(
                    spec(CONTROLLER, &["mouse.click"]),
                    Scenario {
                        seed,
                        ..Scenario::default()
                    },
                    20.0,
                )
                .unwrap();
                r["score"]["inZone"].as_f64().unwrap()
            })
            .collect();
        let avg = scores.iter().sum::<f64>() / scores.len() as f64;
        assert!(avg > 0.85, "scores {scores:?}");
    }

    #[test]
    fn human_input_still_keeps_the_tick_in_the_zone() {
        let scores: Vec<f64> = (1..=5)
            .map(|seed| {
                let mut spec = spec(CONTROLLER, &["mouse.click"]);
                spec.human = Some(crate::human::HumanProfile {
                    precision: 0.85,
                    seed,
                });
                let r = run_headless(
                    spec,
                    Scenario {
                        seed,
                        ..Scenario::default()
                    },
                    20.0,
                )
                .unwrap();
                r["score"]["inZone"].as_f64().unwrap()
            })
            .collect();
        let avg = scores.iter().sum::<f64>() / scores.len() as f64;
        assert!(avg > 0.8, "scores {scores:?}");
    }

    #[test]
    fn traces_match_the_simulation() {
        let mut target = SimTarget::new(Scenario::default(), false);
        let mut run = MacroRun::start(spec(CONTROLLER, &["mouse.click"]), &target).unwrap();
        run.trace = Some(Vec::new());
        let (mut worst, mut checked) = (0.0f64, 0);
        while target.now_ms() < 5000.0 {
            let frame = target.next_frame(Duration::ZERO);
            run.tick(&mut target, frame.as_deref(), &mut |_, _| {});
            let Some(sample) = run.trace.as_mut().unwrap().pop() else {
                continue;
            };
            // Trackers in the order the macro made them: zone, then tick.
            let Some(x) = sample[1][1][0].as_f64() else {
                continue;
            };
            // The region is 0.46 wide around the 0.42-wide bar.
            let bar = 0.5 + (x - 0.5) * 0.46 / crate::sim::BAR_W;
            worst = worst.max((bar - target.game.tick).abs());
            checked += 1;
        }
        assert!(checked > 500, "{checked} samples");
        assert!(worst < 0.01, "trace off by up to {worst} of the bar");
    }

    const LOOPING: &str = r##"
        export default { async run(ctx) {
          const zone = ctx.screen.track("bar", { color: "#3ccf5a", tolerance: 40 });
          const tick = ctx.screen.track("bar", { color: "#ffffff", tolerance: 40, minPixels: 2 });
          const prompt = ctx.screen.track("prompt", { color: "#f2c14e" });
          const dialog = ctx.screen.track("dialog", { color: "#393b3d", tolerance: 6, minPixels: 200 });
          const hud = ctx.screen.track("hud", { color: "#465a82" });
          const stats = await ctx.states({
            cast: { timeout: 3000, async run(s) { await s.waitUntil(() => prompt.seen); s.input.press("e"); return "bite"; } },
            bite: { timeout: 3000, async run(s) { await s.waitUntil(() => zone.seen && tick.seen); return "play"; } },
            play: { timeout: 4000, async run(s) {
              await s.loop.hz(120, () => {
                if (tick.seen && tick.x + tick.velocity * s.input.latency < zone.center) s.input.click({ minGap: 60 });
              }, { until: () => zone.missingFor > 100 });
              return "cast";
            } },
            recover: { timeout: 8000, async run(s) {
              if (dialog.seen) { await s.game.rejoin(); await s.waitUntil(() => hud.seen && !dialog.seen); }
              else { await s.character.reset(); await s.waitUntil(() => prompt.seen); }
              return "cast";
            } },
          }, { recover: "recover", startPoint: "hud", loops: LOOPS });
          ctx.log("stats", stats);
        } };
    "##;

    fn looping_spec(loops: u32) -> MacroSpec {
        let region = |anchor: &str, x: f64, y: f64, w: f64, h: f64| RegionSpec {
            anchor: anchor.into(),
            x,
            y,
            w,
            h,
        };
        let mut s = spec(
            &LOOPING.replace("LOOPS", &loops.to_string()),
            &["mouse.click", "keyboard", "character.reset", "game.rejoin"],
        );
        s.regions
            .insert("prompt".into(), region("top-center", 0.0, 0.11, 0.1, 0.08));
        s.regions
            .insert("hud".into(), region("bottom-left", 0.15, -0.06, 0.2, 0.04));
        s.regions
            .insert("dialog".into(), region("center", 0.0, 0.0, 0.4, 0.2));
        s
    }

    fn looping_scenario() -> Scenario {
        Scenario {
            round_ms: 2000.0,
            stuck_rounds: vec![2],
            disconnect_at_ms: Some(15_000.0),
            ..Scenario::default()
        }
    }

    #[test]
    fn a_state_machine_recovers_from_a_stuck_cast_and_a_disconnect() {
        let r = run_headless(looping_spec(0), looping_scenario(), 40.0).unwrap();
        assert_eq!(r["end"]["reason"], "stopped", "{r}");
        let score = &r["score"];
        assert!(score["rounds"]["played"].as_u64().unwrap() >= 8, "{r}");
        assert!(score["rounds"]["won"].as_u64().unwrap() >= 6, "{r}");
        assert_eq!(
            score["resets"],
            json!(1),
            "one reset for the stuck cast: {r}"
        );
        assert_eq!(score["rejoins"], json!(1), "one rejoin: {r}");
        assert!(r["recoveries"].as_u64().unwrap() >= 2, "{r}");
        assert!(r["loops"].as_u64().unwrap() >= 8, "{r}");
    }

    #[test]
    fn a_state_machine_stops_after_its_loops() {
        let r = run_headless(looping_spec(3), looping_scenario(), 40.0).unwrap();
        assert_eq!(r["end"]["reason"], "done", "{r}");
        assert_eq!(
            r["score"]["rounds"]["started"],
            json!(3),
            "three loops, one of them the stuck cast: {r}"
        );
        assert!(
            r["logs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l.as_str().unwrap().contains("\"loops\":3")),
            "{r}"
        );
    }

    #[test]
    fn the_watchdog_stops_a_macro_that_keeps_timing_out() {
        // Every cast is stuck and there's no reset permission to fix it.
        let mut spec = looping_spec(0);
        spec.permissions.retain(|p| p != "character.reset");
        let r = run_headless(
            spec,
            Scenario {
                stuck_rounds: (1..50).collect(),
                ..looping_scenario()
            },
            40.0,
        )
        .unwrap();
        let error = r["end"]["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("character.reset") || error.contains("Watchdog"),
            "{r}"
        );
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
        assert!(
            r["end"]["error"].as_str().unwrap().contains("mouse.click"),
            "{r}"
        );
        assert_eq!(r["inputs"], 0);
    }

    #[test]
    fn unknown_regions_are_reported() {
        let bad = r##"export default { async run(ctx) { ctx.screen.track("nope", { color: "#ffffff" }); await ctx.wait(100); } };"##;
        let r = run_headless(spec(bad, &[]), Scenario::default(), 1.0).unwrap();
        assert!(
            r["end"]["error"]
                .as_str()
                .unwrap()
                .contains("Unknown region \"nope\""),
            "{r}"
        );
    }
}
