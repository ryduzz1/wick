//! macOS backend: thin Rust wrappers over `native/macos.m`.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;

use serde::Deserialize;

use crate::{Bounds, FrameSink, MouseButton, Permissions, WindowInfo};

pub const PLATFORM: &str = "macos";

type FrameCallback = extern "C" fn(*mut c_void, *const u8, usize, usize, usize);
type HotkeyCallback = extern "C" fn(*mut c_void);
type InputCallback = extern "C" fn(*mut c_void, c_int, c_int, c_int, f64, f64);

extern "C" {
    fn wick_mac_free(p: *mut c_char);
    fn wick_mac_list_windows() -> *mut c_char;
    fn wick_mac_screen_permission() -> c_int;
    fn wick_mac_accessibility_permission(prompt: c_int) -> c_int;
    fn wick_mac_request_screen_permission();
    fn wick_mac_capture_start(
        window_id: u32,
        width: u32,
        height: u32,
        fps: u32,
        callback: FrameCallback,
        context: *mut c_void,
        error: *mut *mut c_char,
    ) -> *mut c_void;
    fn wick_mac_capture_stop(handle: *mut c_void);
    fn wick_mac_mouse_move(x: f64, y: f64) -> c_int;
    fn wick_mac_mouse_move_relative(dx: f64, dy: f64) -> c_int;
    fn wick_mac_mouse_button(button: c_int, down: c_int) -> c_int;
    fn wick_mac_key(code: u16, down: c_int) -> c_int;
    fn wick_mac_hotkey_start(code: u16, callback: HotkeyCallback, context: *mut c_void) -> c_int;
    fn wick_mac_listen(on: c_int, callback: InputCallback, context: *mut c_void) -> c_int;
}

/// Takes ownership of a string returned by the native layer.
fn take_string(p: *mut c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe { wick_mac_free(p) };
    s
}

pub fn init() {}

#[derive(Deserialize)]
struct RawBounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize)]
struct RawWindow {
    id: u64,
    pid: u32,
    owner: String,
    title: String,
    layer: i64,
    bounds: RawBounds,
    client: RawBounds,
}

fn bounds(b: RawBounds) -> Bounds {
    Bounds {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
    }
}

pub fn list_windows() -> Vec<WindowInfo> {
    let json = take_string(unsafe { wick_mac_list_windows() });
    let raw: Vec<RawWindow> = serde_json::from_str(&json).unwrap_or_default();
    raw.into_iter()
        .map(|w| WindowInfo {
            id: w.id,
            pid: w.pid,
            owner: w.owner,
            title: w.title,
            layer: w.layer,
            bounds: bounds(w.bounds),
            client: bounds(w.client),
        })
        .collect()
}

pub fn frontmost_window() -> Option<u64> {
    // The window list is ordered front to back; the first normal-layer window
    // belongs to the app with keyboard focus.
    list_windows()
        .into_iter()
        .find(|w| w.layer == 0)
        .map(|w| w.id)
}

pub fn permissions() -> Permissions {
    Permissions {
        screen_recording: unsafe { wick_mac_screen_permission() } != 0,
        accessibility: unsafe { wick_mac_accessibility_permission(0) } != 0,
    }
}

pub fn request_permissions() {
    let current = permissions();
    if !current.screen_recording {
        unsafe { wick_mac_request_screen_permission() };
    }
    if !current.accessibility {
        unsafe { wick_mac_accessibility_permission(1) };
    }
}

extern "C" fn on_frame(
    context: *mut c_void,
    data: *const u8,
    width: usize,
    height: usize,
    stride: usize,
) {
    let sink = unsafe { &*(context as *const FrameSink) };
    let bytes = unsafe { std::slice::from_raw_parts(data, stride * height) };
    sink(bytes, width, height, stride);
}

pub struct Capture {
    handle: *mut c_void,
    sink: *mut FrameSink,
}

// The handle is only touched on start and drop, and the native side
// serializes frame delivery on its own queue.
unsafe impl Send for Capture {}

impl Capture {
    pub fn start(window: &WindowInfo, fps: u32, sink: FrameSink) -> Result<Capture, String> {
        let sink = Box::into_raw(Box::new(sink));
        let mut error: *mut c_char = ptr::null_mut();
        let handle = unsafe {
            wick_mac_capture_start(
                window.id as u32,
                window.bounds.w.round().max(2.0) as u32,
                window.bounds.h.round().max(2.0) as u32,
                fps,
                on_frame,
                sink as *mut c_void,
                &mut error,
            )
        };
        if handle.is_null() {
            drop(unsafe { Box::from_raw(sink) });
            let message = take_string(error);
            return Err(if message.is_empty() {
                "Couldn't start capture.".into()
            } else {
                message
            });
        }
        Ok(Capture { handle, sink })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            wick_mac_capture_stop(self.handle);
            drop(Box::from_raw(self.sink));
        }
    }
}

fn check(ok: c_int, what: &str) -> Result<(), String> {
    if ok != 0 {
        Ok(())
    } else {
        Err(format!("macOS refused the {what} event"))
    }
}

pub fn mouse_move(x: f64, y: f64) -> Result<(), String> {
    check(unsafe { wick_mac_mouse_move(x, y) }, "mouse move")
}

pub fn mouse_move_relative(dx: f64, dy: f64) -> Result<(), String> {
    check(
        unsafe { wick_mac_mouse_move_relative(dx, dy) },
        "mouse move",
    )
}

pub fn mouse_button(button: MouseButton, down: bool) -> Result<(), String> {
    let index = match button {
        MouseButton::Left => 0,
        MouseButton::Right => 1,
        MouseButton::Middle => 2,
    };
    check(
        unsafe { wick_mac_mouse_button(index, c_int::from(down)) },
        "mouse button",
    )
}

pub fn key_code(name: &str) -> Option<u32> {
    crate::keys::mac_code(name)
}

pub fn key(code: u32, down: bool) -> Result<(), String> {
    check(
        unsafe { wick_mac_key(code as u16, c_int::from(down)) },
        "key",
    )
}

extern "C" fn on_hotkey(context: *mut c_void) {
    let callback = unsafe { &*(context as *const Box<dyn Fn() + Send + Sync>) };
    callback();
}

pub fn start_hotkey(
    code: u32,
    on_press: Box<dyn Fn() + Send + Sync + 'static>,
) -> Result<(), String> {
    // The callback lives for the rest of the process, like the event tap.
    let context = Box::into_raw(Box::new(on_press)) as *mut c_void;
    if unsafe { wick_mac_hotkey_start(code as u16, on_hotkey, context) } != 0 {
        Ok(())
    } else {
        drop(unsafe { Box::from_raw(context as *mut Box<dyn Fn() + Send + Sync>) });
        Err("The kill-switch hotkey needs Accessibility permission.".into())
    }
}

extern "C" fn on_input(
    _context: *mut c_void,
    kind: c_int,
    code: c_int,
    down: c_int,
    x: f64,
    y: f64,
) {
    let down = down != 0;
    let input = if kind == 0 {
        match crate::keys::mac_name(code as u32) {
            Some(name) => crate::UserInput::Key { name, down },
            None => return,
        }
    } else {
        let button = match code {
            0 => MouseButton::Left,
            1 => MouseButton::Right,
            _ => MouseButton::Middle,
        };
        crate::UserInput::Button { button, down, x, y }
    };
    crate::heard(input);
}

pub fn start_listener() -> Result<(), String> {
    if unsafe { wick_mac_listen(1, on_input, std::ptr::null_mut()) } != 0 {
        Ok(())
    } else {
        Err("Hearing your input needs Accessibility permission.".into())
    }
}

pub fn stop_listener() {
    unsafe { wick_mac_listen(0, on_input, std::ptr::null_mut()) };
}
