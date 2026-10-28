//! `wick-engine`: the real-time half of Wick, driven by the app over stdio.

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde_json::{json, Value};
use wick_engine::input::Command;
use wick_engine::probe::{DetectSpec, ProbeSpec};
use wick_engine::record::RecordSpec;
use wick_engine::region::RegionSpec;
use wick_engine::rpc::Emitter;
use wick_engine::run::MacroSpec;
use wick_engine::session::{probe_headless, record_headless, run_headless, Msg, Session, TARGETS};
use wick_engine::sim::Scenario;
use wick_engine::window_target::WindowKind;

const PROTOCOL: u32 = 1;
const KILL_KEY: &str = "f8";

struct Engine {
    emitter: Emitter,
    kills: Arc<AtomicU64>,
    hotkey: Result<(), String>,
    session: Mutex<Option<Session>>,
}

fn param<T: serde::de::DeserializeOwned>(params: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(params.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("Bad \"{name}\" parameter: {e}"))
}

fn scenario(params: &Value) -> Result<Option<Scenario>, String> {
    match params.get("scenario") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => param(params, "scenario").map(Some),
    }
}

fn target_list() -> Value {
    let mut out = Vec::new();
    for id in TARGETS {
        let entry = match id {
            "sim" => json!({ "id": id, "label": "Simulator", "found": true, "focused": true }),
            _ => {
                let kind = if id == "roblox" {
                    WindowKind::Roblox
                } else {
                    WindowKind::Testbench
                };
                let window = kind.find();
                let focused = window
                    .as_ref()
                    .is_some_and(|w| wick_platform::frontmost_window() == Some(w.id));
                json!({
                    "id": id,
                    "label": if id == "roblox" { "Roblox" } else { "Test bench" },
                    "found": window.is_some(),
                    "focused": focused,
                    "window": window.map(|w| json!({ "title": w.title, "width": w.bounds.w, "height": w.bounds.h })),
                })
            }
        };
        out.push(entry);
    }
    json!(out)
}

impl Engine {
    fn kill(&self, source: &str) {
        self.kills.fetch_add(1, Ordering::SeqCst);
        self.emitter
            .event("killswitch", json!({ "source": source }));
    }

    fn with_session<T>(&self, f: impl FnOnce(&Session) -> Result<T, String>) -> Result<T, String> {
        let guard = self.session.lock().unwrap();
        let session = guard
            .as_ref()
            .ok_or("No session is running. Start one with session.start.")?;
        f(session)
    }

    fn handle(&self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "ping" => Ok(json!("pong")),
            "version" => Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": PROTOCOL,
                "platform": wick_platform::PLATFORM,
            })),
            "permissions" => Ok(self.permissions()),
            "permissions.request" => {
                wick_platform::request_permissions();
                Ok(self.permissions())
            }
            "targets.list" => Ok(target_list()),
            "session.start" => {
                let target: String = param(params, "target")?;
                let mut guard = self.session.lock().unwrap();
                *guard = None;
                *guard = Some(Session::spawn(
                    &target,
                    scenario(params)?,
                    self.emitter.clone(),
                    self.kills.clone(),
                )?);
                Ok(json!({ "target": target }))
            }
            "session.stop" => {
                *self.session.lock().unwrap() = None;
                Ok(json!({}))
            }
            "session.snapshot" => {
                let path: std::path::PathBuf = param(params, "path")?;
                let region: Option<RegionSpec> = param(params, "region")?;
                let (tx, rx) = mpsc::channel();
                self.with_session(|s| s.send(Msg::Snapshot(path, region, tx)))?;
                rx.recv().map_err(|_| "The session stopped".to_string())?
            }
            "session.detect" => {
                let spec: DetectSpec = serde_json::from_value(params.clone())
                    .map_err(|e| format!("Bad detect request: {e}"))?;
                let (tx, rx) = mpsc::channel();
                self.with_session(|s| s.send(Msg::Detect(Box::new(spec), tx)))?;
                rx.recv().map_err(|_| "The session stopped".to_string())?
            }
            "record.storyboard" => {
                let dir: std::path::PathBuf = param(params, "dir")?;
                wick_engine::storyboard::rebuild(&dir)
            }
            "session.stopRecord" => {
                self.with_session(|s| s.send(Msg::StopRecord))?;
                Ok(json!(true))
            }
            "session.act" => {
                let command: Command = param(params, "command")?;
                let regions: Option<HashMap<String, RegionSpec>> = param(params, "regions")?;
                let (tx, rx) = mpsc::channel();
                self.with_session(|s| {
                    s.send(Msg::Act(Box::new(command), regions.unwrap_or_default(), tx))
                })?;
                rx.recv().map_err(|_| "The session stopped".to_string())?
            }
            "macro.run" => {
                let spec: MacroSpec = param(params, "macro")?;
                let (tx, rx) = mpsc::channel();
                self.with_session(|s| s.send(Msg::Run(Box::new(spec), tx)))?;
                rx.recv().map_err(|_| "The session stopped".to_string())??;
                Ok(json!({}))
            }
            "macro.stop" => {
                self.with_session(|s| s.send(Msg::StopMacro("stopped".into())))?;
                Ok(json!({}))
            }
            "killswitch" => {
                self.kill("app");
                Ok(json!({}))
            }
            other => Err(format!("Unknown method \"{other}\"")),
        }
    }

    fn permissions(&self) -> Value {
        let p = wick_platform::permissions();
        json!({
            "screenRecording": p.screen_recording,
            "accessibility": p.accessibility,
            "hotkey": { "key": KILL_KEY, "active": self.hotkey.is_ok(), "error": self.hotkey.as_ref().err() },
        })
    }
}

fn main() {
    wick_platform::init();
    let emitter = Emitter::stdout();
    let kills = Arc::new(AtomicU64::new(0));
    let hotkey = {
        let (kills, emitter) = (kills.clone(), emitter.clone());
        wick_platform::start_hotkey(
            KILL_KEY,
            Box::new(move || {
                kills.fetch_add(1, Ordering::SeqCst);
                emitter.event("killswitch", json!({ "source": "hotkey" }));
            }),
        )
    };
    if let Err(e) = &hotkey {
        eprintln!("wick-engine: {e}");
    }
    let engine = Arc::new(Engine {
        emitter: emitter.clone(),
        kills,
        hotkey,
        session: Mutex::new(None),
    });
    emitter.event(
        "ready",
        json!({ "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL }),
    );

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emitter.reply(&Value::Null, Err(format!("Invalid JSON: {e}")));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request["method"].as_str().unwrap_or_default().to_string();
        let params = request.get("params").cloned().unwrap_or(json!({}));
        match method.as_str() {
            "shutdown" => {
                emitter.reply(&id, Ok(json!({})));
                break;
            }
            // Probes take seconds: wait for the result on another thread.
            "session.probe" => {
                let started = (|| {
                    let spec: ProbeSpec = serde_json::from_value(params.clone())
                        .map_err(|e| format!("Bad probe request: {e}"))?;
                    let (tx, rx) = mpsc::channel();
                    engine.with_session(|s| s.send(Msg::Probe(Box::new(spec), tx)))?;
                    Ok::<_, String>(rx)
                })();
                match started {
                    Ok(rx) => {
                        let emitter = emitter.clone();
                        std::thread::spawn(move || {
                            let result = rx
                                .recv()
                                .unwrap_or_else(|_| Err("The session stopped".into()));
                            emitter.reply(&id, result);
                        });
                    }
                    Err(e) => emitter.reply(&id, Err(e)),
                }
            }
            "session.record" => {
                let started = (|| {
                    let spec: RecordSpec = serde_json::from_value(params.clone())
                        .map_err(|e| format!("Bad record request: {e}"))?;
                    let (tx, rx) = mpsc::channel();
                    engine.with_session(|s| s.send(Msg::Record(Box::new(spec), tx)))?;
                    Ok::<_, String>(rx)
                })();
                match started {
                    Ok(rx) => {
                        let emitter = emitter.clone();
                        std::thread::spawn(move || {
                            let result = rx
                                .recv()
                                .unwrap_or_else(|_| Err("The session stopped".into()));
                            emitter.reply(&id, result);
                        });
                    }
                    Err(e) => emitter.reply(&id, Err(e)),
                }
            }
            "sim.record" => {
                let emitter = emitter.clone();
                std::thread::spawn(move || {
                    let result = (|| {
                        let spec: RecordSpec = serde_json::from_value(params.clone())
                            .map_err(|e| format!("Bad record request: {e}"))?;
                        let macro_spec: Option<MacroSpec> = param(&params, "macro")?;
                        record_headless(spec, scenario(&params)?.unwrap_or_default(), macro_spec)
                    })();
                    emitter.reply(&id, result);
                });
            }
            "sim.probe" => {
                let emitter = emitter.clone();
                std::thread::spawn(move || {
                    let result = (|| {
                        let spec: ProbeSpec = serde_json::from_value(params.clone())
                            .map_err(|e| format!("Bad probe request: {e}"))?;
                        probe_headless(spec, scenario(&params)?.unwrap_or_default())
                    })();
                    emitter.reply(&id, result);
                });
            }
            // Headless runs can take seconds, so they get their own thread.
            "sim.run" => {
                let emitter = emitter.clone();
                std::thread::spawn(move || {
                    let result = (|| {
                        let spec: MacroSpec = param(&params, "macro")?;
                        let seconds = params["seconds"]
                            .as_f64()
                            .unwrap_or(30.0)
                            .clamp(0.1, 3600.0);
                        run_headless(spec, scenario(&params)?.unwrap_or_default(), seconds)
                    })();
                    emitter.reply(&id, result);
                });
            }
            _ => {
                let result = engine.handle(&method, &params);
                emitter.reply(&id, result);
            }
        }
    }
    // Stop the session (and release any held input) before exiting.
    *engine.session.lock().unwrap() = None;
}
