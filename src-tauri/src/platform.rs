//! Platform queries and OS handoffs: distribution channel, external URLs,
//! reveal in file manager, and the output directory / input file pickers.

use crate::ipc::{self, FalliblePayload, IpcResult, INVALID_PATH, NOT_AVAILABLE, VALIDATION_ERROR};

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
        .map(|exe| exe.to_string_lossy().to_lowercase().contains("\\windowsapps\\"))
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_distribution_channel() -> IpcResult<&'static str> {
    ipc::ok(distribution_channel())
}

/// Node-style platform name (`darwin` / `win32` / `linux`) for the frontend.
#[tauri::command(async)]
pub fn get_app_platform() -> IpcResult<&'static str> {
    ipc::err(
        NOT_AVAILABLE,
        "The platform query is not implemented yet.",
    )
}

/// v1 answered from Electron's nativeTheme; the Tauri port reads the window
/// theme. Stub until the theme port lands.
#[tauri::command(async)]
pub fn get_system_theme(_app: tauri::AppHandle) -> IpcResult<&'static str> {
    ipc::err(
        NOT_AVAILABLE,
        "The system theme query is not implemented yet.",
    )
}

#[tauri::command]
pub async fn open_external(
    _app: tauri::AppHandle,
    url: FalliblePayload<String>,
) -> IpcResult<()> {
    let _url = match url.into_typed(VALIDATION_ERROR, "Invalid external URL payload.") {
        Ok(url) => url,
        Err(error) => return ipc::from_error(error),
    };
    // v1 dropped unsafe URLs silently; only real opens will surface errors.
    ipc::err(NOT_AVAILABLE, "Opening external URLs is not implemented yet.")
}

/// shell.showItemInFolder: reveals, never opens or executes.
#[tauri::command(async)]
pub fn reveal_path(_app: tauri::AppHandle, file_path: FalliblePayload<String>) -> IpcResult<()> {
    let _path = match file_path.into_typed(INVALID_PATH, "File path must be a non-empty string.") {
        Ok(path) => path,
        Err(error) => return ipc::from_error(error),
    };
    ipc::err(NOT_AVAILABLE, "Revealing paths is not implemented yet.")
}

/// v1's select-output-directory: null when the dialog is cancelled.
#[tauri::command]
pub async fn select_output_directory(_app: tauri::AppHandle) -> IpcResult<Option<String>> {
    ipc::err(
        NOT_AVAILABLE,
        "The output directory picker is not implemented yet.",
    )
}

/// v1's video file dialog (mp4, mkv, avi, mov, wmv, flv, webm, m4v, mpeg,
/// mpg, 3gp, plus all files) with multi-selection.
#[tauri::command]
pub async fn select_input_files(_app: tauri::AppHandle) -> IpcResult<Vec<String>> {
    ipc::err(
        NOT_AVAILABLE,
        "The input file picker is not implemented yet.",
    )
}
