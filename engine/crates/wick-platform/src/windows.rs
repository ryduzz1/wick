//! Windows backend: Windows Graphics Capture, SendInput and RegisterHotKey.
//!
//! Window owners are found with a Toolhelp snapshot, which lists executable
//! names by process id without opening a handle to any process.

use std::sync::{Arc, Mutex};

use windows::core::{Interface, BOOL};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{CloseHandle, HMODULE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Foundation::{LRESULT, WPARAM};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_FLAG,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_RESOURCE_MISC_FLAG, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, RegisterHotKey, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    MAPVK_VK_TO_VSC, MOD_NOREPEAT, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GetClientRect, GetForegroundWindow, GetMessageW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostThreadMessageW, SetCursorPos,
    SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
    LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_HOTKEY, WM_KEYDOWN,
    WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_QUIT,
    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::{Bounds, FrameSink, MouseButton, Permissions, WindowInfo};

pub const PLATFORM: &str = "windows";

pub fn init() {
    // Physical-pixel coordinates everywhere, so capture and input line up on
    // scaled displays. Fails harmlessly if a manifest already set it.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

// MARK: Windows

fn hwnd(id: u64) -> HWND {
    HWND(id as usize as *mut _)
}

fn rect_bounds(r: RECT) -> Bounds {
    Bounds {
        x: r.left as f64,
        y: r.top as f64,
        w: (r.right - r.left) as f64,
        h: (r.bottom - r.top) as f64,
    }
}

fn process_names() -> std::collections::HashMap<u32, String> {
    let mut names = std::collections::HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return names;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                names.insert(
                    entry.th32ProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..len]),
                );
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    names
}

unsafe extern "system" fn collect_window(window: HWND, list: LPARAM) -> BOOL {
    let list = unsafe { &mut *(list.0 as *mut Vec<HWND>) };
    list.push(window);
    BOOL(1)
}

fn window_info(window: HWND, names: &std::collections::HashMap<u32, String>) -> Option<WindowInfo> {
    unsafe {
        if !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
            return None;
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return None;
        }
        let mut frame = RECT::default();
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .ok()?;
        let mut client = RECT::default();
        GetClientRect(window, &mut client).ok()?;
        let mut origin = POINT { x: 0, y: 0 };
        let _ = ClientToScreen(window, &mut origin);
        let mut title = [0u16; 512];
        let len = GetWindowTextW(window, &mut title).max(0) as usize;
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        Some(WindowInfo {
            id: window.0 as usize as u64,
            pid,
            owner: names.get(&pid).cloned().unwrap_or_default(),
            title: String::from_utf16_lossy(&title[..len]),
            bounds: rect_bounds(frame),
            client: Bounds {
                x: origin.x as f64,
                y: origin.y as f64,
                w: (client.right - client.left) as f64,
                h: (client.bottom - client.top) as f64,
            },
            layer: 0,
        })
    }
}

pub fn list_windows() -> Vec<WindowInfo> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect_window),
            LPARAM(&mut handles as *mut Vec<HWND> as isize),
        );
    }
    let names = process_names();
    handles
        .into_iter()
        .filter_map(|h| window_info(h, &names))
        .collect()
}

pub fn frontmost_window() -> Option<u64> {
    let window = unsafe { GetForegroundWindow() };
    (!window.0.is_null()).then_some(window.0 as usize as u64)
}

pub fn permissions() -> Permissions {
    Permissions {
        screen_recording: true,
        accessibility: true,
    }
}

pub fn request_permissions() {}

// MARK: Capture

struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
}

// D3D11 devices are free-threaded; the immediate context is guarded by the mutex.
unsafe impl Send for Gpu {}

pub struct Capture {
    session: GraphicsCaptureSession,
    pool: Direct3D11CaptureFramePool,
}

unsafe impl Send for Capture {}

fn hr(e: windows::core::Error) -> String {
    format!("Windows capture error: {}", e.message())
}

impl Capture {
    pub fn start(window: &WindowInfo, _fps: u32, sink: FrameSink) -> Result<Capture, String> {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
            let interop =
                windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                    .map_err(hr)?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd(window.id)).map_err(hr)?;

            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(hr)?;
            let device = device.ok_or("No Direct3D device")?;
            let context = context.ok_or("No Direct3D context")?;
            let dxgi: IDXGIDevice = device.cast().map_err(hr)?;
            let d3d: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
                .map_err(hr)?
                .cast()
                .map_err(hr)?;

            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &d3d,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                item.Size().map_err(hr)?,
            )
            .map_err(hr)?;
            let session = pool.CreateCaptureSession(&item).map_err(hr)?;
            // Not available on older Windows 10 builds; capture still works.
            let _ = session.SetIsBorderRequired(false);
            let _ = session.SetIsCursorCaptureEnabled(false);

            let gpu = Arc::new(Mutex::new(Gpu {
                device,
                context,
                staging: None,
            }));
            pool.FrameArrived(&TypedEventHandler::new(
                move |pool: windows::core::Ref<Direct3D11CaptureFramePool>, _| {
                    let Some(pool) = pool.as_ref() else {
                        return Ok(());
                    };
                    let frame = pool.TryGetNextFrame()?;
                    let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
                    let texture: ID3D11Texture2D = access.GetInterface()?;
                    let mut gpu = gpu.lock().unwrap();
                    deliver(&mut gpu, &texture, &sink)
                },
            ))
            .map_err(hr)?;
            session.StartCapture().map_err(hr)?;
            Ok(Capture { session, pool })
        }
    }
}

unsafe fn deliver(
    gpu: &mut Gpu,
    texture: &ID3D11Texture2D,
    sink: &FrameSink,
) -> windows::core::Result<()> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    let (width, height) = (desc.Width, desc.Height);
    let fits = matches!(&gpu.staging, Some((_, w, h)) if *w == width && *h == height);
    if !fits {
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            BindFlags: D3D11_BIND_FLAG(0).0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: D3D11_RESOURCE_MISC_FLAG(0).0 as u32,
            ..desc
        };
        let mut staging = None;
        unsafe {
            gpu.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))?
        };
        gpu.staging = staging.map(|t| (t, width, height));
    }
    let Some((staging, _, _)) = &gpu.staging else {
        return Ok(());
    };
    unsafe {
        gpu.context.CopyResource(staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        gpu.context
            .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let stride = mapped.RowPitch as usize;
        let bytes = std::slice::from_raw_parts(mapped.pData as *const u8, stride * height as usize);
        sink(bytes, width as usize, height as usize, stride);
        gpu.context.Unmap(staging, 0);
    }
    Ok(())
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

// MARK: Input

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows blocked the input (another app may have higher privileges)".into())
    }
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub fn mouse_move(x: f64, y: f64) -> Result<(), String> {
    unsafe { SetCursorPos(x.round() as i32, y.round() as i32) }.map_err(|e| e.message())
}

pub fn mouse_move_relative(dx: f64, dy: f64) -> Result<(), String> {
    send(&[mouse_input(
        MOUSEEVENTF_MOVE,
        dx.round() as i32,
        dy.round() as i32,
    )])
}

pub fn mouse_button(button: MouseButton, down: bool) -> Result<(), String> {
    let flags = match (button, down) {
        (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
        (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    };
    send(&[mouse_input(flags, 0, 0)])
}

pub fn key_code(name: &str) -> Option<u32> {
    crate::keys::windows_code(name)
}

pub fn key(code: u32, down: bool) -> Result<(), String> {
    // Games read scan codes, so send those rather than virtual keys.
    let scan = unsafe { MapVirtualKeyW(code, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = KEYEVENTF_SCANCODE;
    if matches!(code, 0x21..=0x28 | 0x2D | 0x2E | 0x5B) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    send(&[INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan,
                dwFlags: KEYBD_EVENT_FLAGS(flags.0),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }])
}

// MARK: Hotkey

pub fn start_hotkey(
    code: u32,
    on_press: Box<dyn Fn() + Send + Sync + 'static>,
) -> Result<(), String> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("wick-hotkey".into())
        .spawn(move || unsafe {
            if let Err(e) = RegisterHotKey(None, 1, MOD_NOREPEAT, code) {
                let _ = ready_tx.send(Err(format!(
                    "Couldn't register the kill-switch hotkey: {}",
                    e.message()
                )));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_HOTKEY {
                    on_press();
                }
            }
        })
        .map_err(|e| e.to_string())?;
    ready_rx
        .recv()
        .unwrap_or_else(|_| Err("The hotkey thread stopped".into()))
}

// MARK: Input listener

/// The thread running the low-level hooks, while listening.
static LISTENER: Mutex<Option<u32>> = Mutex::new(None);
/// The last cursor position the mouse hook saw, for motion deltas.
static LAST_POINT: Mutex<Option<(i32, i32)>> = Mutex::new(None);

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let down = match wparam.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
            WM_KEYUP | WM_SYSKEYUP => Some(false),
            _ => None,
        };
        if let (Some(down), false) = (down, k.flags.contains(LLKHF_INJECTED)) {
            if let Some(name) = crate::keys::windows_name(k.vkCode) {
                crate::heard(crate::UserInput::Key { name, down });
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let m = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let button = match wparam.0 as u32 {
            WM_LBUTTONDOWN => Some((MouseButton::Left, true)),
            WM_LBUTTONUP => Some((MouseButton::Left, false)),
            WM_RBUTTONDOWN => Some((MouseButton::Right, true)),
            WM_RBUTTONUP => Some((MouseButton::Right, false)),
            WM_MBUTTONDOWN => Some((MouseButton::Middle, true)),
            WM_MBUTTONUP => Some((MouseButton::Middle, false)),
            WM_MOUSEMOVE if m.flags & LLMHF_INJECTED == 0 => {
                let (x, y) = (m.pt.x, m.pt.y);
                let last = LAST_POINT.lock().unwrap().replace((x, y));
                if let Some((lx, ly)) = last {
                    crate::heard(crate::UserInput::Motion {
                        dx: f64::from(x - lx),
                        dy: f64::from(y - ly),
                        x: f64::from(x),
                        y: f64::from(y),
                    });
                }
                None
            }
            _ => None,
        };
        if let (Some((button, down)), true) = (button, m.flags & LLMHF_INJECTED == 0) {
            crate::heard(crate::UserInput::Button {
                button,
                down,
                x: f64::from(m.pt.x),
                y: f64::from(m.pt.y),
            });
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

pub fn start_listener() -> Result<(), String> {
    let mut listener = LISTENER.lock().unwrap();
    if listener.is_some() {
        return Ok(());
    }
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("wick-listen".into())
        .spawn(move || unsafe {
            let hooks = (
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0),
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0),
            );
            let (keyboard, mouse) = match hooks {
                (Ok(k), Ok(m)) => (k, m),
                (k, m) => {
                    for hook in [k, m].into_iter().flatten() {
                        let _ = UnhookWindowsHookEx(hook);
                    }
                    let _ = ready_tx.send(Err("Windows didn't allow the input hooks.".to_string()));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            let _ = UnhookWindowsHookEx(keyboard);
            let _ = UnhookWindowsHookEx(mouse);
        })
        .map_err(|e| e.to_string())?;
    let thread = ready_rx
        .recv()
        .unwrap_or_else(|_| Err("The input listener stopped".into()))?;
    *listener = Some(thread);
    Ok(())
}

pub fn stop_listener() {
    *LAST_POINT.lock().unwrap() = None;
    if let Some(thread) = LISTENER.lock().unwrap().take() {
        let _ = unsafe { PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}
