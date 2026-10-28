//! OS-level window listing, capture, input and hotkeys.
//!
//! Everything here works from outside other processes: window lists come from
//! the window server, frames from the OS capture APIs, and input is posted as
//! ordinary OS events. Nothing opens, reads or injects into another process.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as imp;

#[cfg(not(any(target_os = "macos", windows)))]
mod other;
#[cfg(not(any(target_os = "macos", windows)))]
use other as imp;

pub mod keys;

/// A rectangle in the platform's input coordinate space: points on macOS,
/// physical pixels on Windows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WindowInfo {
    pub id: u64,
    pub pid: u32,
    /// Owning app name on macOS, executable name on Windows.
    pub owner: String,
    pub title: String,
    /// The area a window capture covers.
    pub bounds: Bounds,
    /// The window's content area, without its title bar and borders.
    pub client: Bounds,
    pub layer: i64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub screen_recording: bool,
    pub accessibility: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

impl MouseButton {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "middle" => Some(Self::Middle),
            _ => None,
        }
    }
}

/// Receives each captured frame as tightly or loosely packed BGRA rows:
/// `(data, width, height, bytes_per_row)`.
pub type FrameSink = Box<dyn Fn(&[u8], usize, usize, usize) + Send + Sync + 'static>;

/// A running window capture. Dropping it stops the capture.
pub struct Capture {
    _inner: imp::Capture,
}

impl Capture {
    /// Starts capturing `window` at up to `fps` frames per second. Frames are
    /// delivered at the window's size in input coordinates (points on macOS).
    pub fn start(window: &WindowInfo, fps: u32, sink: FrameSink) -> Result<Capture, String> {
        imp::Capture::start(window, fps, sink).map(|inner| Capture { _inner: inner })
    }
}

pub const PLATFORM: &str = imp::PLATFORM;

/// Process-wide setup, such as DPI awareness on Windows. Call once at startup.
pub fn init() {
    imp::init()
}

/// On-screen windows, front to back.
pub fn list_windows() -> Vec<WindowInfo> {
    imp::list_windows()
}

/// The process of the app that currently receives keyboard input.
pub fn frontmost_pid() -> Option<u32> {
    imp::frontmost_pid()
}

/// Whether `window`'s app has keyboard focus. Compared by process, because
/// a game can keep small windows of its own in front of its main one
/// (Roblox's menu button is a separate window on macOS).
pub fn is_frontmost(window: &WindowInfo) -> bool {
    frontmost_pid() == Some(window.pid)
}

pub fn permissions() -> Permissions {
    imp::permissions()
}

/// Shows the OS prompts for any missing permission.
pub fn request_permissions() {
    imp::request_permissions()
}

pub fn mouse_move(x: f64, y: f64) -> Result<(), String> {
    imp::mouse_move(x, y)
}

/// Moves the mouse by a relative amount, as games read it for camera turns.
pub fn mouse_move_relative(dx: f64, dy: f64) -> Result<(), String> {
    imp::mouse_move_relative(dx, dy)
}

pub fn mouse_button(button: MouseButton, down: bool) -> Result<(), String> {
    imp::mouse_button(button, down)
}

/// Presses or releases a key by its Wick name (see [`keys`]).
pub fn key(name: &str, down: bool) -> Result<(), String> {
    let code = imp::key_code(name).ok_or_else(|| format!("unknown key \"{name}\""))?;
    imp::key(code, down)
}

/// Calls `on_press` whenever the named key is pressed, system-wide.
pub fn start_hotkey(
    name: &str,
    on_press: Box<dyn Fn() + Send + Sync + 'static>,
) -> Result<(), String> {
    let code = imp::key_code(name).ok_or_else(|| format!("unknown key \"{name}\""))?;
    imp::start_hotkey(code, on_press)
}

/// A line of text read from an image, with its box as fractions of the
/// image from the top left.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct TextLine {
    pub text: String,
    /// 0 to 1, where the platform reports it (Windows doesn't: always 1).
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Reads text in a BGRA image with the system's text recognition (Vision on
/// macOS, Windows.Media.Ocr on Windows). Slow next to a frame: call it off
/// the frame loop. `accurate` trades speed for better results on macOS.
pub fn read_text(
    bgra: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    accurate: bool,
) -> Result<Vec<TextLine>, String> {
    if width == 0 || height == 0 || bgra.len() < stride * height {
        return Err("There's no image to read.".into());
    }
    imp::read_text(bgra, width, height, stride, accurate)
}

/// Opens a link with the system's handler for its scheme, as clicking it
/// would. Callers check the scheme; this just hands it to the OS.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(url).status();
    #[cfg(windows)]
    let status = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .status();
    #[cfg(not(any(target_os = "macos", windows)))]
    let status: std::io::Result<std::process::ExitStatus> =
        Err(std::io::Error::other("opening links isn't supported here"));
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("Couldn't open {url} ({s})")),
        Err(e) => Err(format!("Couldn't open {url}: {e}")),
    }
}

/// One click or key press the person made, seen while listening.
#[derive(Clone, Debug, PartialEq)]
pub enum UserInput {
    /// `x` and `y` in input coordinates, like [`Bounds`].
    Button {
        button: MouseButton,
        down: bool,
        x: f64,
        y: f64,
    },
    Key {
        name: String,
        down: bool,
    },
    /// Mouse movement: `dx`, `dy` are raw deltas (camera turns while a game
    /// locks the cursor); `x`, `y` is where the cursor ended up.
    Motion {
        dx: f64,
        dy: f64,
        x: f64,
        y: f64,
    },
}

struct Heard {
    events: Vec<(Instant, UserInput)>,
    held: HashSet<String>,
}

static HEARD: Mutex<Option<Heard>> = Mutex::new(None);
const MAX_HEARD: usize = 20_000;

/// Starts or stops collecting the person's own clicks and key presses, for
/// recordings. Only buttons and keys, never typed text as such and never
/// Wick's own input. The OS hook is removed again when listening stops.
pub fn listen_input(on: bool) -> Result<(), String> {
    if on {
        imp::start_listener()?;
        *HEARD.lock().unwrap() = Some(Heard {
            events: Vec::new(),
            held: HashSet::new(),
        });
    } else {
        *HEARD.lock().unwrap() = None;
        imp::stop_listener();
    }
    Ok(())
}

/// Everything heard since the last call.
pub fn take_input() -> Vec<(Instant, UserInput)> {
    match HEARD.lock().unwrap().as_mut() {
        Some(h) => std::mem::take(&mut h.events),
        None => Vec::new(),
    }
}

/// Called by the platform hooks. Drops key repeats.
#[allow(dead_code)]
pub(crate) fn heard(input: UserInput) {
    let mut guard = HEARD.lock().unwrap();
    let Some(h) = guard.as_mut() else { return };
    if let UserInput::Key { name, down } = &input {
        if *down && !h.held.insert(name.clone()) {
            return;
        }
        if !*down {
            h.held.remove(name);
        }
    }
    // Motion arrives hundreds of times a second; runs of it are merged.
    if let UserInput::Motion { dx, dy, x, y } = input {
        if let Some((
            _,
            UserInput::Motion {
                dx: sx,
                dy: sy,
                x: lx,
                y: ly,
            },
        )) = h.events.last_mut()
        {
            *sx += dx;
            *sy += dy;
            (*lx, *ly) = (x, y);
            return;
        }
    }
    if h.events.len() < MAX_HEARD {
        h.events.push((Instant::now(), input));
    }
}
