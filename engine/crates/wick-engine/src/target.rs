//! Targets: the one window a macro may watch and control.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::frame::{Frame, Rect};
use crate::input::Action;

pub trait Target {
    fn id(&self) -> &'static str;
    /// Waits up to `wait` for a frame newer than the last one returned.
    fn next_frame(&mut self, wait: Duration) -> Option<Arc<Frame>>;
    /// Milliseconds since the target started.
    fn now_ms(&self) -> f64;
    /// The game area inside the frame, in frame pixels.
    fn viewport(&self) -> Rect;
    fn focused(&mut self) -> bool;
    /// Estimated delay from sending input to the game reacting, in seconds.
    fn latency(&self) -> f64;
    fn send(&mut self, action: &Action) -> Result<(), String>;
    /// Whether the window was found, its size and focus, for the app.
    fn status(&mut self) -> Value;
    /// A target-specific score, if it can judge how well the macro did.
    fn score(&self) -> Option<Value> {
        None
    }
}
