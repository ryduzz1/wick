//! Targets backed by a real window: `roblox` and `testbench`.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use wick_platform::{Capture, WindowInfo};

use crate::frame::{Frame, Rect};
use crate::input::Action;
use crate::target::Target;

/// The test bench window's title. Open it from the Wick app, which gives it a
/// window of its own; in a browser tab the browser's toolbars would sit inside
/// the captured area and throw off region positions.
pub const TESTBENCH_TITLE: &str = "Wick Test Bench";
const CAPTURE_FPS: u32 = 120;
const LOOKUP_EVERY: Duration = Duration::from_secs(1);
const FOCUS_EVERY: Duration = Duration::from_millis(100);
/// Until Wick measures it, a typical capture-to-game delay.
const DEFAULT_LATENCY: f64 = 0.04;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowKind {
    Roblox,
    Testbench,
}

impl WindowKind {
    pub fn id(self) -> &'static str {
        match self {
            WindowKind::Roblox => "roblox",
            WindowKind::Testbench => "testbench",
        }
    }

    pub fn matches(self, w: &WindowInfo) -> bool {
        if w.layer != 0 || w.bounds.w < 200.0 || w.bounds.h < 150.0 {
            return false;
        }
        match self {
            WindowKind::Roblox => {
                let owner = w.owner.to_ascii_lowercase();
                owner == "roblox" || owner.starts_with("robloxplayer")
            }
            WindowKind::Testbench => w.title.contains(TESTBENCH_TITLE),
        }
    }

    /// The largest matching window, if any.
    pub fn find(self) -> Option<WindowInfo> {
        wick_platform::list_windows()
            .into_iter()
            .filter(|w| self.matches(w))
            .max_by(|a, b| (a.bounds.w * a.bounds.h).total_cmp(&(b.bounds.w * b.bounds.h)))
    }
}

#[derive(Default)]
struct Slot {
    seq: u64,
    frame: Option<Arc<Frame>>,
}

#[derive(Default)]
struct Shared {
    slot: Mutex<Slot>,
    arrived: Condvar,
}

pub struct WindowTarget {
    kind: WindowKind,
    window: Option<WindowInfo>,
    capture: Option<Capture>,
    shared: Arc<Shared>,
    last_seq: u64,
    frame_size: (usize, usize),
    looked_up: Option<Instant>,
    focus: (Option<Instant>, bool),
    started: Instant,
    error: Option<String>,
}

impl WindowTarget {
    pub fn new(kind: WindowKind) -> Self {
        WindowTarget {
            kind,
            window: None,
            capture: None,
            shared: Arc::default(),
            last_seq: 0,
            frame_size: (0, 0),
            looked_up: None,
            focus: (None, false),
            started: Instant::now(),
            error: None,
        }
    }

    /// Finds the window again every second, restarting capture if it moved,
    /// resized or was replaced.
    fn refresh(&mut self) {
        if self.looked_up.is_some_and(|t| t.elapsed() < LOOKUP_EVERY) {
            return;
        }
        self.looked_up = Some(Instant::now());
        let found = self.kind.find();
        let same = match (&found, &self.window) {
            (Some(a), Some(b)) => a.id == b.id && a.bounds == b.bounds,
            (None, None) => true,
            _ => false,
        };
        if same && (self.capture.is_some() || found.is_none()) {
            if let (Some(f), Some(w)) = (&found, &mut self.window) {
                w.client = f.client;
            }
            return;
        }
        self.capture = None;
        self.window = found;
        let Some(window) = &self.window else {
            self.error = None;
            return;
        };
        let shared = self.shared.clone();
        let sink = Box::new(move |data: &[u8], w: usize, h: usize, stride: usize| {
            let frame = Arc::new(Frame::from_bgra(data, w, h, stride));
            let mut slot = shared.slot.lock().unwrap();
            slot.seq += 1;
            slot.frame = Some(frame);
            shared.arrived.notify_all();
        });
        match Capture::start(window, CAPTURE_FPS, sink) {
            Ok(c) => {
                self.capture = Some(c);
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
    }

    fn to_screen(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let w = self.window.as_ref()?;
        let (fw, fh) = self.frame_size;
        if fw == 0 || fh == 0 {
            return None;
        }
        Some((
            w.bounds.x + x * w.bounds.w / fw as f64,
            w.bounds.y + y * w.bounds.h / fh as f64,
        ))
    }
}

impl Target for WindowTarget {
    fn id(&self) -> &'static str {
        self.kind.id()
    }

    fn next_frame(&mut self, wait: Duration) -> Option<Arc<Frame>> {
        self.refresh();
        if self.capture.is_none() {
            std::thread::sleep(wait);
            return None;
        }
        let slot = self.shared.slot.lock().unwrap();
        let (slot, _) = self
            .shared
            .arrived
            .wait_timeout_while(slot, wait, |s| s.seq <= self.last_seq)
            .unwrap();
        if slot.seq <= self.last_seq {
            return None;
        }
        self.last_seq = slot.seq;
        let frame = slot.frame.clone()?;
        self.frame_size = (frame.width, frame.height);
        Some(frame)
    }

    fn now_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn viewport(&self) -> Rect {
        let (Some(w), (fw, fh)) = (&self.window, self.frame_size) else {
            return Rect::default();
        };
        let sx = fw as f64 / w.bounds.w.max(1.0);
        let sy = fh as f64 / w.bounds.h.max(1.0);
        Rect::new(
            (w.client.x - w.bounds.x) * sx,
            (w.client.y - w.bounds.y) * sy,
            w.client.w * sx,
            w.client.h * sy,
        )
    }

    fn focused(&mut self) -> bool {
        if self.focus.0.is_some_and(|t| t.elapsed() < FOCUS_EVERY) {
            return self.focus.1;
        }
        let focused = match &self.window {
            Some(w) => wick_platform::frontmost_window() == Some(w.id),
            None => false,
        };
        self.focus = (Some(Instant::now()), focused);
        focused
    }

    fn latency(&self) -> f64 {
        DEFAULT_LATENCY
    }

    fn send(&mut self, action: &Action) -> Result<(), String> {
        match action {
            Action::MoveTo { x, y } => {
                let (sx, sy) = self
                    .to_screen(*x, *y)
                    .ok_or("The window isn't being captured yet")?;
                wick_platform::mouse_move(sx, sy)
            }
            Action::Turn { dx, dy } => wick_platform::mouse_move_relative(*dx, *dy),
            Action::Button { button, down } => wick_platform::mouse_button(*button, *down),
            Action::Key { name, down } => wick_platform::key(name, *down),
        }
    }

    fn status(&mut self) -> Value {
        let focused = self.focused();
        json!({
            "found": self.window.is_some(),
            "capturing": self.capture.is_some(),
            "focused": focused,
            "window": self.window.as_ref().map(|w| json!({ "title": w.title, "owner": w.owner, "width": w.bounds.w, "height": w.bounds.h })),
            "error": self.error,
        })
    }
}
