//! Native macOS application menu (v1 `applicationMenu.ts`). Custom items are
//! delivered to the renderer as `app-menu-action` events shaped
//! `{ action, payload? }`, queued until the main window reports ready.
//!
//! Failure modes, written before the code:
//! 1. Menu click while the window is closed (macOS Dock): recreate the window,
//!    queue the action, flush on `mark_main_window_ready`.
//! 2. Several clicks before ready: keep order, deliver each once.
//! 3. Open… cancelled or returns nothing: emit nothing.
//! 4. Open… dialog blocks: run it off the menu thread.
//! 5. `refresh()` runs on the updater state thread: never query the updater
//!    here, read the mirrored atomic. Apply on the main thread without waiting.
//! 6. Updates disabled (Store build, env switch): Check and Install disabled.
//! 7. Install Update is enabled only with a downloaded, not-installing update.
//! 8. Cancel Conversion enabled only while converting. Show Output only with
//!    output.
//! 9. `refresh()` before `install()` or on another platform: no-op.
//! 10. Quit goes through the close-confirmation flow, never `exit` directly.

use crate::types::ConversionMenuStatePayload;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;

static PENDING_MENU_ACTIONS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
static UPDATE_READY: AtomicBool = AtomicBool::new(false);

/// Mirrors the updater's "downloaded and not installing" state.
pub fn set_update_ready(ready: bool) {
    UPDATE_READY.store(ready, Ordering::SeqCst);
}

#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Enablement {
    check_updates: bool,
    install_update: bool,
    show_output: bool,
    cancel_conversion: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn enablement(
    conversion: ConversionMenuStatePayload,
    update_ready: bool,
    updates_disabled: bool,
) -> Enablement {
    Enablement {
        check_updates: !updates_disabled,
        install_update: !updates_disabled && update_ready,
        show_output: conversion.has_output,
        cancel_conversion: conversion.converting,
    }
}

fn event_body(action: &str, payload: Option<Value>) -> Value {
    match payload {
        Some(payload) => json!({ "action": action, "payload": payload }),
        None => json!({ "action": action }),
    }
}

pub fn flush_pending_menu_actions(_app: &AppHandle) {
    let pending = PENDING_MENU_ACTIONS
        .lock()
        .map(|mut actions| std::mem::take(&mut *actions))
        .unwrap_or_default();
    for body in pending {
        crate::app_state::emit("app-menu-action", body);
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::sync::OnceLock;
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, SubmenuBuilder};
    use tauri::Wry;
    use tauri_plugin_opener::OpenerExt;

    const SETTINGS: &str = "open-settings";
    const OPEN_FILES: &str = "open-files";
    const SHOW_IN_FOLDER: &str = "show-in-folder";
    const START: &str = "start-conversion";
    const CANCEL: &str = "cancel-conversion";
    const LOGS: &str = "show-logs";
    const CREDITS: &str = "open-credits";
    const CHECK_UPDATES: &str = "check-for-updates";
    const INSTALL_UPDATE: &str = "install-update";
    const HELP: &str = "menu-help";
    const SUPPORT: &str = "menu-support";
    const QUIT: &str = "menu-quit";
    const HELP_URL: &str = "https://help.rosie.run/conv2/en-us/faq";
    const SUPPORT_URL: &str = "https://rosie.run/support";

    struct Items {
        check_updates: MenuItem<Wry>,
        install_update: MenuItem<Wry>,
        show_output: MenuItem<Wry>,
        cancel_conversion: MenuItem<Wry>,
    }

    static ITEMS: OnceLock<Items> = OnceLock::new();

    fn deliver(app: &AppHandle, action: &str, payload: Option<Value>) {
        if let Err(error) = crate::window::show_main_window(app) {
            crate::logging::warn(&format!(
                "Failed to show main window for menu action: {error}"
            ));
        }
        let body = event_body(action, payload);
        if crate::constants::MAIN_READY.load(Ordering::SeqCst) {
            crate::app_state::emit("app-menu-action", body);
        } else if let Ok(mut pending) = PENDING_MENU_ACTIONS.lock() {
            pending.push(body);
        }
    }

    fn apply() {
        let Some(items) = ITEMS.get() else { return };
        let state = enablement(
            crate::window::conversion_menu_state(),
            UPDATE_READY.load(Ordering::SeqCst),
            crate::updater::updates_disabled(),
        );
        let _ = items.check_updates.set_enabled(state.check_updates);
        let _ = items.install_update.set_enabled(state.install_update);
        let _ = items.show_output.set_enabled(state.show_output);
        let _ = items.cancel_conversion.set_enabled(state.cancel_conversion);
    }

    pub fn refresh() {
        if ITEMS.get().is_none() {
            return;
        }
        // Queue to the main thread without waiting: callers may hold locks.
        if let Some(app) = crate::app_state::app() {
            let _ = app.run_on_main_thread(apply);
        }
    }

    pub fn install(app: &AppHandle) -> Result<(), String> {
        let item = |id: &str, label: &str, accelerator: Option<&str>, enabled: bool| {
            MenuItem::with_id(app, id, label, enabled, accelerator).map_err(|e| e.to_string())
        };
        let build_error = |error: tauri::Error| error.to_string();

        let check_updates = item(CHECK_UPDATES, "Check for Updates…", None, true)?;
        let install_update = item(INSTALL_UPDATE, "Install Update…", None, false)?;
        let settings = item(SETTINGS, "Settings…", Some("CmdOrCtrl+,"), true)?;
        let open_files = item(OPEN_FILES, "Open…", Some("CmdOrCtrl+O"), true)?;
        let show_output = item(SHOW_IN_FOLDER, "Show Output in Finder", None, false)?;
        // No accelerator: bare Enter is handled in the renderer.
        let start = item(START, "Start Conversion", None, true)?;
        let cancel = item(CANCEL, "Cancel Conversion", None, false)?;
        let logs = item(LOGS, "Show Debug Logs", None, true)?;
        let help = item(HELP, "CONV2 Help", None, true)?;
        let support = item(SUPPORT, "Support", None, true)?;
        let credits = item(CREDITS, "View Credits", None, true)?;
        let quit = item(QUIT, "Quit CONV2", Some("CmdOrCtrl+Q"), true)?;

        let about = AboutMetadata {
            name: Some("CONV2".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            copyright: Some("Copyright © BurntToasters".into()),
            ..Default::default()
        };
        let app_menu = SubmenuBuilder::new(app, "CONV2")
            .about(Some(about))
            .separator()
            .item(&check_updates)
            .item(&install_update)
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()
            .map_err(build_error)?;
        let file = SubmenuBuilder::new(app, "File")
            .item(&open_files)
            .item(&show_output)
            .separator()
            .close_window()
            .build()
            .map_err(build_error)?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()
            .map_err(build_error)?;
        let convert = SubmenuBuilder::new(app, "Convert")
            .item(&start)
            .item(&cancel)
            .build()
            .map_err(build_error)?;
        let view = SubmenuBuilder::new(app, "View")
            .item(&logs)
            .separator()
            .fullscreen()
            .build()
            .map_err(build_error)?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .bring_all_to_front()
            .build()
            .map_err(build_error)?;
        let help_menu = SubmenuBuilder::new(app, "Help")
            .item(&help)
            .item(&support)
            .separator()
            .item(&credits)
            .build()
            .map_err(build_error)?;
        let _ = help_menu.set_as_help_menu_for_nsapp();
        let _ = window.set_as_windows_menu_for_nsapp();
        let menu = MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file)
            .item(&edit)
            .item(&convert)
            .item(&view)
            .item(&window)
            .item(&help_menu)
            .build()
            .map_err(build_error)?;
        app.set_menu(menu).map_err(build_error)?;

        let _ = ITEMS.set(Items {
            check_updates,
            install_update,
            show_output,
            cancel_conversion: cancel,
        });
        apply();

        app.on_menu_event(|app, event| match event.id().as_ref() {
            id @ (SETTINGS | SHOW_IN_FOLDER | START | CANCEL | LOGS | CREDITS) => {
                deliver(app, id, None)
            }
            OPEN_FILES => {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let paths = crate::platform::pick_video_files(&handle);
                    if !paths.is_empty() {
                        deliver(&handle, OPEN_FILES, Some(json!({ "paths": paths })));
                    }
                });
            }
            CHECK_UPDATES => {
                tauri::async_runtime::spawn(async {
                    let _ = crate::updater::check_for_updates().await;
                });
            }
            INSTALL_UPDATE => {
                tauri::async_runtime::spawn(async {
                    let _ = crate::updater::install_update().await;
                });
            }
            HELP => {
                let _ = app.opener().open_url(HELP_URL, None::<&str>);
            }
            SUPPORT => {
                let _ = app.opener().open_url(SUPPORT_URL, None::<&str>);
            }
            QUIT => crate::window::request_quit(app),
            _ => {}
        });
        Ok(())
    }
}

/// Re-evaluate item enablement after conversion or updater state changes.
#[cfg(target_os = "macos")]
pub fn refresh() {
    mac::refresh();
}

#[cfg(not(target_os = "macos"))]
pub fn refresh() {}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> Result<(), String> {
    mac::install(app)
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(converting: bool, has_output: bool) -> ConversionMenuStatePayload {
        ConversionMenuStatePayload {
            converting,
            has_output,
        }
    }

    #[test]
    fn idle_start_disables_cancel_install_and_show() {
        let value = enablement(state(false, false), false, false);
        assert_eq!(
            value,
            Enablement {
                check_updates: true,
                install_update: false,
                show_output: false,
                cancel_conversion: false,
            }
        );
    }

    #[test]
    fn converting_enables_cancel_only() {
        let value = enablement(state(true, false), false, false);
        assert!(value.cancel_conversion && !value.show_output);
    }

    #[test]
    fn output_enables_show() {
        assert!(enablement(state(false, true), false, false).show_output);
    }

    #[test]
    fn ready_update_enables_install() {
        assert!(enablement(state(false, false), true, false).install_update);
    }

    #[test]
    fn disabled_updates_lock_check_and_install() {
        let value = enablement(state(false, false), true, true);
        assert!(!value.check_updates && !value.install_update);
    }

    #[test]
    fn event_body_omits_absent_payload() {
        assert_eq!(
            event_body("open-settings", None),
            json!({"action": "open-settings"})
        );
        assert_eq!(
            event_body("open-files", Some(json!({"paths": ["/a.mp4"]}))),
            json!({"action": "open-files", "payload": {"paths": ["/a.mp4"]}})
        );
    }
}
