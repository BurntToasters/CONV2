//! Process-wide handles: the Tauri app handle, the resolved data directory,
//! and the single event sink used by conversion and updater threads.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

static APP: OnceLock<AppHandle> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub const MAIN_WINDOW: &str = "main";

pub fn init(app: &AppHandle) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the app data directory: {error}"))?;
    // Unpackaged E2E builds isolate all persisted state in a temporary profile.
    #[cfg(feature = "e2e")]
    let data = std::env::var_os("CONV2_E2E_DATA_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or(data);
    std::fs::create_dir_all(&data)
        .map_err(|error| format!("Could not create {}: {error}", data.display()))?;
    let _ = DATA_DIR.set(data);
    let _ = APP.set(app.clone());
    Ok(())
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("run.rosie.conv2"))
}

/// Whether `data_dir()` resolves to the real app data directory.
pub fn data_dir_ready() -> bool {
    DATA_DIR.get().is_some()
}

/// The main window handle, for dialogs that need a parent.
#[allow(dead_code)]
pub fn main_window() -> Option<WebviewWindow> {
    app().and_then(|app| app.get_webview_window(MAIN_WINDOW))
}

/// Emit an event to the main window. Background threads use this instead of
/// holding an AppHandle of their own.
pub fn emit<S: Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = app() {
        if let Err(error) = app.emit_to(MAIN_WINDOW, event, payload) {
            crate::logging::warn(&format!("Failed to emit {event}: {error}"));
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
