//! Main window bounds persistence (v1 `windowState.ts`). Stored in logical
//! (DIP) units so a v1 `windowState.json` imports unchanged.
//!
//! Failure modes, written before the code:
//! 1. File missing, unreadable, oversized, or not JSON: use defaults.
//! 2. Fields of the wrong type, NaN, or infinite: drop that field only.
//! 3. Width < 600 or height < 500 (v1 minimums): reset that axis to default.
//! 4. Saved monitor is gone: position off every display, fall back to center.
//! 5. Only a sliver of the title bar is visible: treat as off-screen.
//! 6. Saved size exceeds every connected display: clamp to the largest one.
//! 7. Maximized at close: save the last normal bounds, not the maximized ones.
//! 8. Minimized (Windows reports -32000) or fullscreen at close: never record
//!    those bounds.
//! 9. Disk write fails or the app is killed mid-write: atomic write, log only.
//! 10. No monitor list available: keep size, skip position.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

const FILE_NAME: &str = "windowState.json";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const DEFAULT_WIDTH: f64 = 1080.0;
pub const DEFAULT_HEIGHT: f64 = 880.0;
const MIN_WIDTH: f64 = 600.0;
const MIN_HEIGHT: f64 = 500.0;
/// Only the title bar strip must be visible, so height is not compared.
const TITLE_BAR_CLEARANCE: f64 = 64.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub is_maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            is_maximized: false,
        }
    }
}

/// A display in logical units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What to apply to a freshly built (hidden) window.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub width: f64,
    pub height: f64,
    /// None keeps the configured center.
    pub position: Option<(f64, f64)>,
    pub maximize: bool,
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

pub fn parse(text: &str) -> WindowState {
    let defaults = WindowState::default();
    let Ok(Value::Object(data)) = serde_json::from_str::<Value>(text) else {
        return defaults;
    };
    let width = data
        .get("width")
        .and_then(finite)
        .filter(|width| *width >= MIN_WIDTH)
        .unwrap_or(DEFAULT_WIDTH);
    let height = data
        .get("height")
        .and_then(finite)
        .filter(|height| *height >= MIN_HEIGHT)
        .unwrap_or(DEFAULT_HEIGHT);
    WindowState {
        x: data.get("x").and_then(finite),
        y: data.get("y").and_then(finite),
        width,
        height,
        is_maximized: data.get("isMaximized").and_then(Value::as_bool) == Some(true),
    }
}

pub fn is_on_screen(x: f64, y: f64, width: f64, displays: &[Rect]) -> bool {
    displays.iter().any(|bounds| {
        x + width > bounds.x
            && x < bounds.x + bounds.width
            && y + TITLE_BAR_CLEARANCE > bounds.y
            && y < bounds.y + bounds.height
    })
}

pub fn plan(state: &WindowState, displays: &[Rect]) -> Plan {
    let mut width = state.width;
    let mut height = state.height;
    if let Some(widest) = displays
        .iter()
        .map(|display| display.width)
        .reduce(f64::max)
    {
        width = width.min(widest).max(MIN_WIDTH.min(widest));
    }
    if let Some(tallest) = displays
        .iter()
        .map(|display| display.height)
        .reduce(f64::max)
    {
        height = height.min(tallest).max(MIN_HEIGHT.min(tallest));
    }
    let position = match (state.x, state.y) {
        (Some(x), Some(y)) if is_on_screen(x, y, width, displays) => Some((x, y)),
        _ => None,
    };
    Plan {
        width,
        height,
        position,
        maximize: state.is_maximized,
    }
}

fn state_path() -> PathBuf {
    crate::app_state::data_dir().join(FILE_NAME)
}

pub fn load() -> WindowState {
    match crate::fs_util::read_bounded(&state_path(), MAX_FILE_BYTES) {
        Ok(Some(text)) => parse(&text),
        _ => WindowState::default(),
    }
}

/// Last bounds seen while the window was in its normal state.
static NORMAL_BOUNDS: Mutex<Option<WindowState>> = Mutex::new(None);

fn displays(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor().max(0.1);
            let position = monitor.position();
            let size = monitor.size();
            Rect {
                x: f64::from(position.x) / scale,
                y: f64::from(position.y) / scale,
                width: f64::from(size.width) / scale,
                height: f64::from(size.height) / scale,
            }
        })
        .collect()
}

/// Apply saved bounds to the hidden main window. Runs after build so the
/// configured `center` cannot override the restored position.
pub fn restore(app: &AppHandle, window: &WebviewWindow) {
    let state = load();
    let plan = plan(&state, &displays(app));
    let _ = window.set_size(tauri::LogicalSize::new(plan.width, plan.height));
    match plan.position {
        Some((x, y)) => {
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
        None => {
            let _ = window.center();
        }
    }
    if let Ok(mut slot) = NORMAL_BOUNDS.lock() {
        *slot = Some(WindowState {
            x: plan.position.map(|position| position.0),
            y: plan.position.map(|position| position.1),
            width: plan.width,
            height: plan.height,
            is_maximized: false,
        });
    }
    if plan.maximize {
        let _ = window.maximize();
    }
}

/// Call on every Moved/Resized event of the main window.
pub fn track(window: &WebviewWindow) {
    if window.is_maximized().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    let scale = scale.max(0.1);
    if let Ok(mut slot) = NORMAL_BOUNDS.lock() {
        *slot = Some(WindowState {
            x: Some(f64::from(position.x) / scale),
            y: Some(f64::from(position.y) / scale),
            width: f64::from(size.width) / scale,
            height: f64::from(size.height) / scale,
            is_maximized: false,
        });
    }
}

/// Persist the last normal bounds plus the current maximized flag.
pub fn save(app: &AppHandle) {
    let Some(window) = app.get_webview_window(crate::app_state::MAIN_WINDOW) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        track(&window);
    }
    let Some(mut state) = NORMAL_BOUNDS.lock().ok().and_then(|slot| *slot) else {
        return;
    };
    state.is_maximized = window.is_maximized().unwrap_or(false);
    if let Err(error) = crate::fs_util::write_json(&state_path(), &state) {
        crate::logging::warn(&format!("Failed to save window state: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    #[test]
    fn corrupt_or_wrong_shape_files_give_defaults() {
        for text in ["", "not json", "[]", "null", "42", "\"x\""] {
            assert_eq!(parse(text), WindowState::default(), "{text}");
        }
    }

    #[test]
    fn bad_fields_drop_individually() {
        let state = parse(r#"{"width":"900","height":700,"x":"1","y":5,"isMaximized":"yes"}"#);
        assert_eq!(state.width, DEFAULT_WIDTH);
        assert_eq!(state.height, 700.0);
        assert_eq!(state.x, None);
        assert_eq!(state.y, Some(5.0));
        assert!(!state.is_maximized);
    }

    #[test]
    fn undersized_axes_reset() {
        let state = parse(r#"{"width":599,"height":499}"#);
        assert_eq!((state.width, state.height), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        let state = parse(r#"{"width":600,"height":500}"#);
        assert_eq!((state.width, state.height), (600.0, 500.0));
    }

    #[test]
    fn v1_file_round_trips() {
        let state = parse(r#"{"width":1000,"height":800,"x":10,"y":20,"isMaximized":true}"#);
        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["isMaximized"], true);
        assert_eq!(json["x"], 10.0);
    }

    #[test]
    fn gone_monitor_and_sliver_fall_back_to_center() {
        let off = WindowState {
            x: Some(3000.0),
            y: Some(100.0),
            ..WindowState::default()
        };
        assert_eq!(plan(&off, &[SCREEN]).position, None);
        let below = WindowState {
            x: Some(100.0),
            y: Some(1080.0),
            ..WindowState::default()
        };
        assert_eq!(plan(&below, &[SCREEN]).position, None);
        let above = WindowState {
            x: Some(100.0),
            y: Some(-900.0),
            ..WindowState::default()
        };
        assert_eq!(plan(&above, &[SCREEN]).position, None);
    }

    #[test]
    fn visible_title_bar_keeps_position() {
        let state = WindowState {
            x: Some(-500.0),
            y: Some(-20.0),
            ..WindowState::default()
        };
        assert_eq!(plan(&state, &[SCREEN]).position, Some((-500.0, -20.0)));
    }

    #[test]
    fn oversize_clamps_to_largest_display() {
        let state = WindowState {
            width: 3000.0,
            height: 2000.0,
            ..WindowState::default()
        };
        let planned = plan(&state, &[SCREEN]);
        assert_eq!((planned.width, planned.height), (1920.0, 1080.0));
    }

    #[test]
    fn no_displays_keeps_size_and_skips_position() {
        let state = WindowState {
            x: Some(10.0),
            y: Some(10.0),
            ..WindowState::default()
        };
        let planned = plan(&state, &[]);
        assert_eq!(planned.position, None);
        assert_eq!(planned.width, DEFAULT_WIDTH);
    }

    #[test]
    fn maximized_flag_carries_through() {
        let state = WindowState {
            is_maximized: true,
            ..WindowState::default()
        };
        assert!(plan(&state, &[SCREEN]).maximize);
    }
}
