//! Platform queries and OS handoffs: distribution channel, external URLs,
//! reveal in file manager, and the output directory / input file pickers.
//!
//! Failure modes, written before the code:
//! 1. `open_external` gets a non-string payload: VALIDATION_ERROR.
//! 2. URL is http, has credentials, targets a local or private host, or is
//!    over 2048 bytes: dropped silently, as v1 did.
//! 3. The OS refuses to launch the browser: logged, not surfaced.
//! 4. `reveal_path` gets a relative or empty path: INVALID_PATH.
//! 5. Revealed path is gone: silent no-op, as v1 did.
//! 6. The file manager reveal fails (Linux without FileManager1): open the
//!    containing folder instead.
//! 7. Picker cancelled: `None` / empty list, never an error.
//! 8. Picker returns a non-filesystem path: skipped.
//! 9. The main window is gone while a picker is requested: still show the
//!    dialog, without a parent.
//! 10. `get_system_theme` with no window: report `light`.

use crate::ipc::{self, FalliblePayload, IpcResult, INVALID_PATH, VALIDATION_ERROR};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// v1's video file dialog filter.
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "3gp",
];

/// `msstore` builds are produced with `CONV2_DISTRIBUTION_CHANNEL=msstore`
/// and never use the in-app updater. Baked value first, then the runtime
/// override for unpackaged dev and E2E runs, then the Store install path.
pub fn distribution_channel() -> &'static str {
    if let Some("msstore") = option_env!("CONV2_DISTRIBUTION_CHANNEL") {
        return "msstore";
    }
    if let Ok(runtime) = std::env::var("CONV2_DISTRIBUTION_CHANNEL") {
        match runtime.as_str() {
            "msstore" => return "msstore",
            "github" => return "github",
            _ => {}
        }
    }
    #[cfg(windows)]
    if looks_like_msstore_install() {
        return "msstore";
    }
    "github"
}

/// Store (APPX/MSIX) installs run from `WindowsApps`.
#[cfg(windows)]
fn looks_like_msstore_install() -> bool {
    std::env::current_exe()
        .map(|exe| {
            exe.to_string_lossy()
                .to_lowercase()
                .contains("\\windowsapps\\")
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_distribution_channel() -> IpcResult<&'static str> {
    ipc::ok(distribution_channel())
}

/// Node-style platform name (`darwin` / `win32` / `linux`) for the frontend.
fn platform_name(os: &str) -> &'static str {
    match os {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

#[tauri::command]
pub fn get_app_platform() -> IpcResult<&'static str> {
    ipc::ok(platform_name(std::env::consts::OS))
}

/// v1 answered from Electron's nativeTheme.shouldUseDarkColors. No code sets
/// a window theme override, so the window theme tracks the OS.
#[tauri::command]
pub fn get_system_theme(app: tauri::AppHandle) -> IpcResult<&'static str> {
    use tauri::Manager;
    let dark = app
        .get_webview_window(crate::app_state::MAIN_WINDOW)
        .and_then(|window| window.theme().ok())
        .is_some_and(|theme| theme == tauri::Theme::Dark);
    ipc::ok(if dark { "dark" } else { "light" })
}

#[tauri::command]
pub async fn open_external(app: tauri::AppHandle, url: FalliblePayload<String>) -> IpcResult<()> {
    let url = match url.into_typed(VALIDATION_ERROR, "Invalid external URL payload.") {
        Ok(url) => url,
        Err(error) => return ipc::from_error(error),
    };
    // v1 dropped unsafe URLs silently and ignored launch failures.
    if let Some(safe) = crate::validation::safe_external_url(&url) {
        if let Err(error) = app.opener().open_url(safe, None::<&str>) {
            crate::logging::warn(&format!("Failed to open external URL: {error}"));
        }
    }
    ipc::ok(())
}

/// shell.showItemInFolder: reveals, never opens or executes.
#[tauri::command(async)]
pub fn reveal_path(app: tauri::AppHandle, file_path: FalliblePayload<String>) -> IpcResult<()> {
    let value = match file_path.into_typed(INVALID_PATH, "File path must be a non-empty string.") {
        Ok(value) => value,
        Err(error) => return ipc::from_error(error),
    };
    let Some(path) = crate::validation::resolve_absolute(&value) else {
        return ipc::err(INVALID_PATH, "File path must be an absolute path.");
    };
    if !path.exists() {
        return ipc::ok(());
    }
    if let Err(error) = app.opener().reveal_item_in_dir(&path) {
        crate::logging::warn(&format!(
            "Reveal in file manager failed ({error}); opening the folder instead."
        ));
        if let Some(dir) = path.parent().filter(|dir| dir.exists()) {
            let _ = app
                .opener()
                .open_path(dir.to_string_lossy().into_owned(), None::<&str>);
        }
    }
    ipc::ok(())
}

fn path_string(path: tauri_plugin_dialog::FilePath) -> Option<String> {
    path.into_path()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// v1's select-output-directory: null when the dialog is cancelled.
#[tauri::command]
pub async fn select_output_directory(app: tauri::AppHandle) -> IpcResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(window) = crate::app_state::main_window() {
            dialog = dialog.set_parent(&window);
        }
        dialog.blocking_pick_folder().and_then(path_string)
    })
    .await
    .unwrap_or(None);
    ipc::ok(picked)
}

/// Blocking multi-select video picker: v1's dialog filters. Empty on cancel.
pub fn pick_video_files(app: &tauri::AppHandle) -> Vec<String> {
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Video Files", VIDEO_EXTENSIONS)
        .add_filter("All Files", &["*"]);
    if let Some(window) = crate::app_state::main_window() {
        dialog = dialog.set_parent(&window);
    }
    dialog
        .blocking_pick_files()
        .map(|files| files.into_iter().filter_map(path_string).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn select_input_files(app: tauri::AppHandle) -> IpcResult<Vec<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || pick_video_files(&app))
        .await
        .unwrap_or_default();
    ipc::ok(picked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_names_match_node() {
        assert_eq!(platform_name("macos"), "darwin");
        assert_eq!(platform_name("windows"), "win32");
        assert_eq!(platform_name("linux"), "linux");
        assert_eq!(platform_name("freebsd"), "linux");
    }

    #[test]
    fn video_filter_matches_v1() {
        assert_eq!(VIDEO_EXTENSIONS.len(), 11);
        assert!(VIDEO_EXTENSIONS.contains(&"3gp"));
        assert!(!VIDEO_EXTENSIONS.iter().any(|ext| ext.starts_with('.')));
    }
}
