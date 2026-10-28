//! Targets: the one window a macro may watch and control.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::frame::{Frame, Rect};
use crate::human::Step;
use crate::input::Action;

/// What the macro says about its game, from `wick.json`.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GameInfo {
    pub name: Option<String>,
    pub place_id: Option<u64>,
}

/// One click or key press the person made in the target window.
#[derive(Clone, Debug, PartialEq)]
pub struct HeardInput {
    /// In target time, like `now_ms`.
    pub t: f64,
    pub action: Action,
    /// Where a click landed, in frame pixels.
    pub at: Option<(f64, f64)>,
}

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
    /// Starts or stops hearing the person's own input, for recordings.
    fn listen(&mut self, _on: bool) -> Result<(), String> {
        Ok(())
    }
    /// The person's input since the last call, while the window had focus.
    fn heard(&mut self) -> Vec<HeardInput> {
        Vec::new()
    }
    /// A target-specific action, such as resetting the character. Macros
    /// need a permission of the same name. Returns input to send, timed in
    /// ms from now, or does the action itself and returns nothing.
    fn special(&mut self, name: &str, _game: &GameInfo) -> Result<Vec<Step>, String> {
        Err(format!(
            "\"{name}\" isn't available on the {} target.",
            self.id()
        ))
    }
    /// A target-specific score, if it can judge how well the macro did.
    fn score(&self) -> Option<Value> {
        None
    }
}
