//! Window lifecycle: the hidden main window built from tauri.conf.json, the
//! deferred reveal on renderer readiness, the close flow (confirm while a
//! conversion is active, then destroy), and restart.

use crate::app_state::MAIN_WINDOW;
use crate::constants::{CLOSE_GENERATION, MAIN_READY};
use crate::ipc::{FalliblePayload, JsonObject, VALIDATION_ERROR};
use crate::types::ConversionMenuStatePayload;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

static CLOSE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static CLOSE_CONFIRMING: AtomicBool = AtomicBool::new(false);
pub static APP_QUITTING: AtomicBool = AtomicBool::new(false);
/// The renderer's last reported menu enablement (v1's conversion-menu-state).
static CONVERSION_MENU_STATE: Mutex<ConversionMenuStatePayload> =
    Mutex::new(ConversionMenuStatePayload {
        converting: false,
        has_output: false,
    });

/// Only the bundled frontend (and the Vite dev server in debug builds) may
/// load in the main webview.
pub fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || (cfg!(debug_assertions)
                    && matches!(host, "localhost" | "127.0.0.1")
                    && url.port() == Some(5173))
        }
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

/// Hand a blocked navigation to the system browser when it is a safe
/// external URL; everything else is dropped. Validation resolves DNS, so it
/// runs off the UI thread that delivers navigation callbacks.
fn open_blocked_url(app: &AppHandle, url: &tauri::Url) {
    use tauri_plugin_opener::OpenerExt;
    let app = app.clone();
    let url = url.clone();
    std::thread::spawn(move || {
        if crate::validation::is_safe_external_url(url.as_str()) {
            if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
                crate::logging::warn(&format!("Could not open external URL: {error}"));
            }
        } else {
            crate::logging::warn(&format!("Blocked navigation to {}", url.scheme()));
        }
    });
}

fn build_main(app: &AppHandle) -> Result<WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .ok_or_else(|| "tauri.conf.json has no main window".to_string())?;
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let builder =
        WebviewWindowBuilder::from_config(app, &config).map_err(|error| error.to_string())?;
    // E2E specs keep sampling the page while the window sits behind other apps.
    // Windows ignores `focused` for a window created hidden; `e2e_background`
    // keeps the reveal from activating it there.
    #[cfg(feature = "e2e")]
    let builder = builder
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .focused(!e2e_background());
    // v1's window chrome: custom title bar on macOS and Windows, native frame
    // on Linux. The flat window config cannot scope `decorations`, so the
    // frameless Windows chrome is applied here.
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);
    builder
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            open_blocked_url(&navigation_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_blocked_url(&popup_app, &url);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())
        .inspect(|window| {
            crate::window_state::restore(window.app_handle(), window);
            #[cfg(all(feature = "e2e", target_os = "macos"))]
            if e2e_background() {
                e2e_occlusion::keep_rendering(window);
            }
        })
}

/// Background E2E runs on macOS and Windows: the app never takes focus and its
/// window stays below other apps. The E2E runner sets
/// `CONV2_E2E_BACKGROUND=1` unless CI or a foreground override is set.
#[cfg(feature = "e2e")]
pub fn e2e_background() -> bool {
    (cfg!(target_os = "macos") || cfg!(target_os = "windows"))
        && std::env::var("CONV2_E2E_BACKGROUND").as_deref() == Ok("1")
}

/// Win32 reveal for Windows background runs. tao cannot show a window that was
/// created hidden without activating it: it removes its no-activate marker when
/// creation ends, so its `show` calls `ShowWindow(SW_SHOW)`, and `unminimize`
/// restores with activation. This path therefore uses Win32 directly.
///
/// tao's VISIBLE flag stays clear on purpose. With it set, every later tao flag
/// change runs `ShowWindow(SW_SHOW)` and activates the window. With it clear,
/// every later tao flag change runs `ShowWindow(SW_HIDE)` and hides it. So the
/// background path makes no tao flag setter calls after the reveal, and it
/// does not call tao's `set_always_on_bottom`, which goes through the same path.
/// `is_visible` reads `IsWindowVisible`, so it still reports the real state.
#[cfg(all(feature = "e2e", target_os = "windows"))]
mod e2e_windows {
    use tauri::WebviewWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SW_SHOWNOACTIVATE,
    };

    pub fn reveal_without_activation(window: &WebviewWindow) {
        let hwnd = match window.hwnd() {
            Ok(hwnd) => hwnd.0,
            Err(error) => {
                crate::logging::warn(&format!(
                    "E2E background: could not reach the main window ({error}); it stays hidden."
                ));
                return;
            }
        };
        let flags = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE;
        // SAFETY: `hwnd` is the live main-window handle from tauri. These calls
        // only change z-order and show state; none of them activates a window.
        unsafe {
            // Move to the bottom while hidden, so the first visible frame is
            // already below other windows.
            let _ = SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, flags);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            // A newly shown window may land on top, so move it down again.
            let _ = SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, flags);
        }
    }
}

/// E2E background runs keep the main page rendering while the window sits
/// behind other apps. WebKit treats a covered window as occluded and marks the
/// page hidden, which stops animation frames and CSS transitions. Turning
/// WebKit's occlusion detection off for the main webview leaves the window's
/// level, focus and visibility alone. The selector is private, so every call
/// goes through `respondsToSelector:` first and a missing selector is only
/// logged.
#[cfg(all(feature = "e2e", target_os = "macos"))]
mod e2e_occlusion {
    use std::ffi::{c_char, c_void};
    use tauri::WebviewWindow;

    type Id = *mut c_void;
    type Sel = *mut c_void;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> Sel;
        // Never called through this declaration. Each call casts its address to
        // the exact signature it uses, which arm64 requires.
        fn objc_msgSend();
    }

    /// Stops WebKit from reporting the main webview as occluded. `with_webview`
    /// runs the closure on the main thread (WKWebView access requires it) and
    /// does nothing if the webview is already gone.
    pub fn keep_rendering(window: &WebviewWindow) {
        let result = window.with_webview(|webview| {
            // SAFETY: called on the main thread by `with_webview`; the pointer
            // is the live WKWebView that wry owns for this webview.
            let outcome = unsafe { disable_occlusion_detection(webview.inner()) };
            match outcome {
                Ok(previous) => crate::logging::info(&format!(
                    "E2E background: WebKit occlusion detection off for the main webview (was {}).",
                    if previous { "on" } else { "off" }
                )),
                Err(reason) => crate::logging::warn(&format!(
                    "E2E background: occlusion detection not changed ({reason}); the page may pause while hidden."
                )),
            }
        });
        if let Err(error) = result {
            crate::logging::warn(&format!(
                "E2E background: could not reach the main webview ({error})."
            ));
        }
    }

    /// Returns the previous setting when the private accessors exist.
    ///
    /// # Safety
    /// `view` must be null or a valid WKWebView pointer, and the caller must be
    /// on the main thread.
    unsafe fn disable_occlusion_detection(view: *mut c_void) -> Result<bool, &'static str> {
        if view.is_null() {
            return Err("no WKWebView");
        }
        let send_responds: unsafe extern "C" fn(Id, Sel, Sel) -> i8 =
            std::mem::transmute(objc_msgSend as *const c_void);
        let send_get: unsafe extern "C" fn(Id, Sel) -> i8 =
            std::mem::transmute(objc_msgSend as *const c_void);
        let send_set: unsafe extern "C" fn(Id, Sel, i8) =
            std::mem::transmute(objc_msgSend as *const c_void);

        let responds = sel_registerName(c"respondsToSelector:".as_ptr());
        let getter = sel_registerName(c"_windowOcclusionDetectionEnabled".as_ptr());
        let setter = sel_registerName(c"_setWindowOcclusionDetectionEnabled:".as_ptr());
        if send_responds(view, responds, getter) == 0 || send_responds(view, responds, setter) == 0
        {
            return Err("private selector missing on this WebKit");
        }
        let previous = send_get(view, getter) != 0;
        send_set(view, setter, 0);
        Ok(previous)
    }
}

fn reveal(window: &WebviewWindow) {
    #[cfg(feature = "e2e")]
    if e2e_background() {
        reveal_e2e_background(window);
        return;
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// macOS keeps its tao-based reveal. Windows never calls tao's `unminimize`,
/// `show`, or `set_focus` here; see `e2e_windows`.
#[cfg(feature = "e2e")]
fn reveal_e2e_background(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    e2e_windows::reveal_without_activation(window);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.unminimize();
        let _ = window.set_always_on_bottom(true);
        let _ = window.show();
    }
}

/// Create the (hidden) main window if needed, or focus the existing one. The
/// reveal waits for `mark_main_window_ready`, mirroring v1's ready-to-show.
pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if MAIN_READY.load(Ordering::SeqCst) {
            reveal(&window);
        }
        return Ok(());
    }
    MAIN_READY.store(false, Ordering::SeqCst);
    let window = build_main(app)?;
    let generation = CLOSE_GENERATION.load(Ordering::SeqCst);
    let handle = app.clone();
    // Fallback: reveal even if the renderer never reports readiness.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(15));
        if CLOSE_GENERATION.load(Ordering::SeqCst) != generation
            || MAIN_READY.load(Ordering::SeqCst)
        {
            return;
        }
        crate::logging::warn("Main window did not report ready in time; showing it anyway.");
        let _ = handle.run_on_main_thread(move || {
            reveal(&window);
        });
    });
    Ok(())
}

#[tauri::command]
pub fn mark_main_window_ready(app: AppHandle, window: WebviewWindow) {
    if window.label() != MAIN_WINDOW || MAIN_READY.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::logging::info("Main window reported ready.");
    std::thread::spawn(move || {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            reveal(&window);
            crate::app_menu::flush_pending_menu_actions(&handle);
        });
    });
}

pub fn conversion_menu_state() -> ConversionMenuStatePayload {
    CONVERSION_MENU_STATE
        .lock()
        .map(|slot| *slot)
        .unwrap_or_default()
}

/// v1's `conversion-menu-state` IPC: the renderer reports whether a batch is
/// running and whether any output exists, so menu items can enable/disable.
#[tauri::command(async)]
pub fn set_conversion_menu_state(
    window: WebviewWindow,
    state: FalliblePayload<JsonObject<ConversionMenuStatePayload>>,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Err("Only the main window may set the conversion menu state.".into());
    }
    let state = state
        .into_typed(VALIDATION_ERROR, "Invalid conversion menu state.")
        .map_err(|error| error.message)?;
    if let Ok(mut slot) = CONVERSION_MENU_STATE.lock() {
        *slot = state.0;
    }
    crate::app_menu::refresh();
    Ok(())
}

fn destroy_main(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Err("The main window was unavailable.".into());
    };
    window
        .destroy()
        .map_err(|error| format!("Could not close the main window: {error}"))
}

/// Main window close: confirm while a conversion is active (v1's quit
/// guard), then destroy the window. The settings-flush acknowledgement
/// lands with the settings port.
pub fn on_main_close_requested(app: &AppHandle, api: &tauri::CloseRequestApi) {
    api.prevent_close();
    crate::window_state::save(app);
    if CLOSE_IN_PROGRESS.load(Ordering::SeqCst) || CLOSE_CONFIRMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    if !crate::conversion::is_active() {
        CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
        if let Err(error) = destroy_main(&handle) {
            crate::logging::error(&format!("Could not close the main window: {error}"));
        }
        return;
    }
    std::thread::spawn(move || {
        let mut dialog = handle
            .dialog()
            .message(
                "A conversion is still running.\n\nQuitting stops it and deletes the partially converted file. Files already finished are kept.",
            )
            .title("Conversion in Progress")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit Anyway".to_string(),
                "Keep Converting".to_string(),
            ));
        if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
            dialog = dialog.parent(&window);
        }
        let confirmed = dialog.blocking_show();
        CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
        if confirmed {
            if let Err(error) = destroy_main(&handle) {
                crate::logging::error(&format!("Could not close the main window: {error}"));
            }
        } else {
            APP_QUITTING.store(false, Ordering::SeqCst);
        }
    });
}

pub fn on_main_destroyed(app: &AppHandle) {
    crate::logging::info("Main window closed.");
    MAIN_READY.store(false, Ordering::SeqCst);
    {
        CLOSE_IN_PROGRESS.store(false, Ordering::SeqCst);
        CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
        CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    if cfg!(target_os = "macos") && !APP_QUITTING.load(Ordering::SeqCst) {
        // macOS keeps the app in the Dock; a closed window still stops work.
        stop_active_work();
        return;
    }
    if APP_QUITTING.load(Ordering::SeqCst) {
        app.exit(0);
    }
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_cancel_close_request(window: WebviewWindow, generation: u64) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Err("Only the main window may cancel an E2E close request.".into());
    }
    if CLOSE_GENERATION.load(Ordering::SeqCst) != generation
        || !CLOSE_IN_PROGRESS.load(Ordering::SeqCst)
    {
        return Err("The E2E close request is no longer current.".into());
    }
    CLOSE_IN_PROGRESS.store(false, Ordering::SeqCst);
    CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
    CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst);
    APP_QUITTING.store(false, Ordering::SeqCst);
    crate::logging::info("E2E close request retired.");
    Ok(())
}

/// Quit from the app menu: run the normal close flow first, then exit.
#[cfg(target_os = "macos")]
pub fn request_quit(app: &AppHandle) {
    APP_QUITTING.store(true, Ordering::SeqCst);
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => {
            if let Err(error) = window.close() {
                APP_QUITTING.store(false, Ordering::SeqCst);
                crate::logging::error(&format!("Could not begin a durable quit: {error}"));
            }
        }
        None => {
            let _ = shutdown();
            app.exit(0);
        }
    }
}

pub fn stop_active_work() {
    crate::conversion::stop();
}

/// Stop background work before an update install or restart. v1 noted that
/// `app.exit` skips before-quit, so FFmpeg must stop here or it outlives the
/// app (it was detached on POSIX). Durable-state writes land with the queue
/// port.
pub fn shutdown() -> Result<(), String> {
    stop_active_work();
    Ok(())
}

/// v1's restart-app: stop FFmpeg, then relaunch.
#[tauri::command]
pub async fn restart_app(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restart(&app))
        .await
        .map_err(|error| error.to_string())?
}

pub fn restart(app: &AppHandle) -> Result<(), String> {
    APP_QUITTING.store(true, Ordering::SeqCst);
    shutdown()?;
    app.restart()
}
