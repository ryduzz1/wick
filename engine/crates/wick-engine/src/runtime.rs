//! The sandboxed QuickJS runtime macros run in.
//!
//! A macro gets a plain QuickJS context: the language and its built-ins, plus
//! the Wick API from `prelude.js`. There is no filesystem, network, process,
//! timer or OS access. Modules load only from the macro's own files, held in
//! memory, and `wick` is the only bare import. Each step has a time limit, so
//! a runaway loop is stopped instead of freezing the engine.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{CatchResultExt, Context, Ctx, Function, Module, Runtime};
use serde::Deserialize;
use serde_json::Value;

const PRELUDE: &str = include_str!("prelude.js");
const WICK_MODULE: &str = "export const macro = (definition) => definition;\n";
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const MAX_JOBS_PER_STEP: usize = 100_000;

/// How long one step may run before the macro is stopped.
pub const STEP_LIMIT: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Starting,
    Running,
    Done,
    Error(String),
}

/// What a step returns: the macro's status and the commands it queued.
pub struct Drained {
    pub status: Status,
    pub commands: Vec<Value>,
}

#[derive(Deserialize)]
struct RawDrain {
    status: String,
    error: Option<String>,
    cmds: Vec<Value>,
}

/// Resolves a module specifier against the importing module's path.
fn resolve_path(files: &HashMap<String, String>, base: &str, name: &str) -> Result<String, String> {
    if name == "wick" {
        return Ok(name.into());
    }
    let joined = if name.starts_with("./") || name.starts_with("../") {
        let dir = base.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
        for part in name.split('/') {
            match part {
                "." | "" => {}
                ".." => {
                    if parts.pop().is_none() {
                        return Err(format!("\"{name}\" points outside the macro folder"));
                    }
                }
                p => parts.push(p),
            }
        }
        parts.join("/")
    } else if files.contains_key(name) {
        name.to_string()
    } else {
        return Err(format!(
            "Macros can only import \"wick\" and their own files (\"./file.ts\"), not \"{name}\"."
        ));
    };
    for candidate in [
        joined.clone(),
        format!("{joined}.ts"),
        format!("{joined}.js"),
        format!("{joined}/index.ts"),
    ] {
        if files.contains_key(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!("Couldn't find \"{name}\" in the macro folder"))
}

struct MemoryResolver(Rc<HashMap<String, String>>);

impl Resolver for MemoryResolver {
    fn resolve<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        resolve_path(&self.0, base, name)
            .map_err(|message| rquickjs::Exception::throw_reference(ctx, &message))
    }
}

struct MemoryLoader(Rc<HashMap<String, String>>);

impl Loader for MemoryLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        let source = if name == "wick" {
            WICK_MODULE.to_string()
        } else {
            self.0.get(name).cloned().ok_or_else(|| {
                rquickjs::Exception::throw_reference(
                    ctx,
                    &format!("Couldn't find \"{name}\" in the macro folder"),
                )
            })?
        };
        Module::declare(ctx.clone(), name, source)
    }
}

pub struct MacroRuntime {
    runtime: Runtime,
    context: Context,
    deadline: Rc<Cell<Option<Instant>>>,
}

impl MacroRuntime {
    /// Loads the prelude and starts the macro's `run`. `files` holds the
    /// macro's JavaScript (types already stripped), keyed by path in the folder.
    pub fn start(
        files: HashMap<String, String>,
        entry: &str,
        init: &Value,
    ) -> Result<Self, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(1024 * 1024);
        let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
        let watch = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            watch.get().is_some_and(|d| Instant::now() > d)
        })));
        let files = Rc::new(files);
        runtime.set_loader(MemoryResolver(files.clone()), MemoryLoader(files.clone()));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;

        let rt = MacroRuntime {
            runtime,
            context,
            deadline,
        };
        let mut init = init.clone();
        init["entry"] = Value::String(entry.to_string());
        let init = init.to_string();
        rt.guarded(|ctx| {
            ctx.eval::<(), _>(PRELUDE)
                .catch(&ctx)
                .map_err(|e| format!("Wick prelude failed: {e}"))?;
            let f: Function = ctx
                .globals()
                .get("__wick_init")
                .map_err(|e| e.to_string())?;
            f.call::<_, ()>((init,))
                .catch(&ctx)
                .map_err(|e| e.to_string())
        })?;
        Ok(rt)
    }

    /// Runs `f` inside the context with the step time limit armed, then
    /// settles pending promise jobs.
    fn guarded<T>(&self, f: impl FnOnce(Ctx<'_>) -> Result<T, String>) -> Result<T, String> {
        self.deadline.set(Some(Instant::now() + STEP_LIMIT));
        let result = self
            .context
            .with(f)
            .and_then(|v| self.run_jobs().map(|_| v));
        let timed_out = self.deadline.get().is_some_and(|d| Instant::now() > d);
        self.deadline.set(None);
        match result {
            Err(_) if timed_out => Err(format!(
                "The macro ran for more than {} ms in one step and was stopped. Avoid long loops inside a tick; use loop.hz or await ctx.wait instead.",
                STEP_LIMIT.as_millis()
            )),
            other => other,
        }
    }

    fn run_jobs(&self) -> Result<(), String> {
        for _ in 0..MAX_JOBS_PER_STEP {
            if !self.runtime.is_job_pending() {
                return Ok(());
            }
            if self.runtime.execute_pending_job().is_err() {
                return Err("A promise job failed".into());
            }
        }
        Err("The macro queued too many promise jobs in one step".into())
    }

    /// Delivers a frame's worth of state and returns what the macro queued.
    pub fn step(&self, state: &Value) -> Result<Drained, String> {
        let json = state.to_string();
        self.guarded(|ctx| {
            let f: Function = ctx
                .globals()
                .get("__wick_step")
                .map_err(|e| e.to_string())?;
            f.call::<_, ()>((json,))
                .catch(&ctx)
                .map_err(|e| e.to_string())
        })?;
        self.drain()
    }

    pub fn drain(&self) -> Result<Drained, String> {
        let raw: String = self.guarded(|ctx| {
            let f: Function = ctx
                .globals()
                .get("__wick_drain")
                .map_err(|e| e.to_string())?;
            f.call::<_, String>(())
                .catch(&ctx)
                .map_err(|e| e.to_string())
        })?;
        let raw: RawDrain = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let status = match raw.status.as_str() {
            "starting" => Status::Starting,
            "running" => Status::Running,
            "done" => Status::Done,
            _ => Status::Error(raw.error.unwrap_or_else(|| "The macro failed".into())),
        };
        Ok(Drained {
            status,
            commands: raw.cmds,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn files(main: &str) -> HashMap<String, String> {
        HashMap::from([("main.ts".to_string(), main.to_string())])
    }

    fn state(now: f64) -> Value {
        json!({ "now": now, "latency": 0.03, "focused": true, "viewport": { "width": 100, "height": 100 }, "trackers": {} })
    }

    fn run_until_settled(rt: &MacroRuntime, steps: usize) -> (Status, Vec<Value>) {
        let mut all = Vec::new();
        let mut status = Status::Starting;
        for i in 0..steps {
            let d = rt.step(&state(i as f64 * 10.0)).unwrap();
            all.extend(d.commands);
            status = d.status;
            if matches!(status, Status::Done | Status::Error(_)) {
                break;
            }
        }
        (status, all)
    }

    #[test]
    fn runs_a_macro_with_waits_and_loops() {
        let src = r#"
            import { macro } from "wick";
            export default macro({
              async run(ctx) {
                ctx.log("start", ctx.settings.speed);
                await ctx.wait(50);
                let n = 0;
                await ctx.loop.hz(100, () => { n++; ctx.input.click({ minGap: 0 }); }, { until: () => n >= 3 });
                ctx.log("clicks", n);
              },
            });
        "#;
        let rt = MacroRuntime::start(
            files(src),
            "main.ts",
            &json!({ "settings": { "speed": 2 } }),
        )
        .unwrap();
        let (status, cmds) = run_until_settled(&rt, 100);
        assert_eq!(status, Status::Done);
        let logs: Vec<_> = cmds
            .iter()
            .filter(|c| c["t"] == "log")
            .map(|c| c["text"].clone())
            .collect();
        assert_eq!(logs, vec![json!("start 2"), json!("clicks 3")]);
        assert_eq!(cmds.iter().filter(|c| c["t"] == "click").count(), 3);
    }

    #[test]
    fn imports_sibling_files() {
        let mut f = files(
            r#"import { double } from "./lib/math"; export default { async run(ctx) { ctx.log(double(21)); } };"#,
        );
        f.insert(
            "lib/math.ts".into(),
            "export const double = (n) => n * 2;".into(),
        );
        let rt = MacroRuntime::start(f, "main.ts", &json!({})).unwrap();
        let (status, cmds) = run_until_settled(&rt, 5);
        assert_eq!(status, Status::Done);
        assert_eq!(cmds[0]["text"], "42");
    }

    #[test]
    fn has_no_io_globals() {
        let src = r#"export default { async run(ctx) {
            ctx.log([typeof fetch, typeof require, typeof process, typeof setTimeout, typeof std, typeof os].join(","));
        } };"#;
        let rt = MacroRuntime::start(files(src), "main.ts", &json!({})).unwrap();
        let (_, cmds) = run_until_settled(&rt, 5);
        assert_eq!(
            cmds[0]["text"],
            "undefined,undefined,undefined,undefined,undefined,undefined"
        );
    }

    #[test]
    fn blocks_imports_outside_the_macro() {
        for spec in [
            "os",
            "std",
            "node:fs",
            "../secret.ts",
            "https://example.com/x.js",
        ] {
            let src = format!(r#"import "{spec}"; export default {{ async run() {{}} }};"#);
            let rt = MacroRuntime::start(files(&src), "main.ts", &json!({})).unwrap();
            let (status, _) = run_until_settled(&rt, 5);
            assert!(
                matches!(status, Status::Error(_)),
                "{spec} should fail, got {status:?}"
            );
        }
    }

    #[test]
    fn stops_runaway_loops() {
        let src = r#"export default { async run(ctx) { await ctx.loop.hz(60, () => { for (;;) {} }); } };"#;
        let rt = MacroRuntime::start(files(src), "main.ts", &json!({})).unwrap();
        let err = rt.step(&state(0.0)).err().unwrap();
        assert!(err.contains("more than 250 ms"), "{err}");
    }

    #[test]
    fn reports_errors_with_a_message() {
        let src = r#"export default { async run(ctx) { await ctx.wait(10); throw new Error("zone not found"); } };"#;
        let rt = MacroRuntime::start(files(src), "main.ts", &json!({})).unwrap();
        let (status, _) = run_until_settled(&rt, 5);
        match status {
            Status::Error(message) => assert!(message.contains("zone not found"), "{message}"),
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[test]
    fn needs_a_default_export_with_run() {
        let rt = MacroRuntime::start(files("export const x = 1;"), "main.ts", &json!({})).unwrap();
        let (status, _) = run_until_settled(&rt, 5);
        assert!(matches!(status, Status::Error(m) if m.contains("export default macro")));
    }

    #[test]
    fn resolves_paths() {
        let f: HashMap<String, String> = ["main.ts", "a/b.ts", "a/c/index.ts"]
            .iter()
            .map(|k| (k.to_string(), String::new()))
            .collect();
        assert_eq!(resolve_path(&f, "main.ts", "./a/b").unwrap(), "a/b.ts");
        assert_eq!(resolve_path(&f, "a/b.ts", "./c").unwrap(), "a/c/index.ts");
        assert_eq!(
            resolve_path(&f, "a/c/index.ts", "../../main.ts").unwrap(),
            "main.ts"
        );
        assert!(resolve_path(&f, "main.ts", "../x").is_err());
        assert!(resolve_path(&f, "main.ts", "lodash").is_err());
    }
}
