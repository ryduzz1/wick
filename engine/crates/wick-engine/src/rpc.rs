//! Newline-delimited JSON-RPC 2.0 over stdin/stdout.
//!
//! Stdout carries only protocol messages; diagnostics go to stderr.

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// Sends replies and events. Cloneable and usable from any thread.
#[derive(Clone)]
pub struct Emitter(Arc<Mutex<Box<dyn FnMut(Value) + Send>>>);

impl Emitter {
    pub fn stdout() -> Self {
        Emitter::new(|message| {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{message}");
            let _ = out.flush();
        })
    }

    pub fn new(sink: impl FnMut(Value) + Send + 'static) -> Self {
        Emitter(Arc::new(Mutex::new(Box::new(sink))))
    }

    fn send(&self, message: Value) {
        (self.0.lock().unwrap())(message);
    }

    pub fn event(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn reply(&self, id: &Value, result: Result<Value, String>) {
        match result {
            Ok(result) => self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
            Err(message) => {
                self.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } }))
            }
        }
    }
}
