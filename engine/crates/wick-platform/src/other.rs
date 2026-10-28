//! Fallback for platforms Wick doesn't support yet: everything reports
//! unavailable, so the engine still builds and the `sim` target still works.

use crate::{FrameSink, MouseButton, Permissions, WindowInfo};

pub const PLATFORM: &str = "unsupported";

const UNSUPPORTED: &str = "capture and input aren't supported on this platform";

pub struct Capture;

impl Capture {
    pub fn start(_window: &WindowInfo, _fps: u32, _sink: FrameSink) -> Result<Capture, String> {
        Err(UNSUPPORTED.into())
    }
}

pub fn init() {}

pub fn list_windows() -> Vec<WindowInfo> {
    Vec::new()
}

pub fn frontmost_window() -> Option<u64> {
    None
}

pub fn permissions() -> Permissions {
    Permissions { screen_recording: false, accessibility: false }
}

pub fn request_permissions() {}

pub fn mouse_move(_x: f64, _y: f64) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

pub fn mouse_move_relative(_dx: f64, _dy: f64) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

pub fn mouse_button(_button: MouseButton, _down: bool) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

pub fn key_code(name: &str) -> Option<u32> {
    crate::keys::windows_code(name)
}

pub fn key(_code: u32, _down: bool) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

pub fn start_hotkey(_code: u32, _on_press: Box<dyn Fn() + Send + Sync + 'static>) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
