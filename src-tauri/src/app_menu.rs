//! Native macOS application menu. Custom items are delivered to the renderer
//! as `app-menu-action` events (queued until the main window reports ready),
//! matching v1's `AppMenuActionEvent` shape.

use tauri::AppHandle;

static PENDING_MENU_ACTIONS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn flush_pending_menu_actions(_app: &AppHandle) {
    let pending = PENDING_MENU_ACTIONS
        .lock()
        .map(|mut actions| std::mem::take(&mut *actions))
        .unwrap_or_default();
    for action in pending {
        crate::app_state::emit("app-menu-action", serde_json::json!({ "action": action }));
    }
}

/// Re-evaluate menu item enablement after the renderer reports conversion or
/// updater state. The controller lands with the conversion port.
pub fn refresh() {}

#[cfg(target_os = "macos")]
fn deliver(app: &AppHandle, action: &str) {
    if let Err(error) = crate::window::show_main_window(app) {
        crate::logging::warn(&format!(
            "Failed to show main window for menu action: {error}"
        ));
    }
    if crate::constants::MAIN_READY.load(std::sync::atomic::Ordering::SeqCst) {
        crate::app_state::emit("app-menu-action", serde_json::json!({ "action": action }));
    } else if let Ok(mut pending) = PENDING_MENU_ACTIONS.lock() {
        pending.push(action.to_string());
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, SubmenuBuilder};
    use tauri_plugin_opener::OpenerExt;

    const SETTINGS: &str = "open-settings";
    const OPEN_FILES: &str = "open-files";
    const DOCS: &str = "menu-docs";
    const ISSUES: &str = "menu-issues";
    const QUIT: &str = "menu-quit";
    const DOCS_URL: &str = "https://github.com/BurntToasters/CONV2#readme";
    const ISSUES_URL: &str = "https://github.com/BurntToasters/CONV2/issues";

    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, label, true, accelerator).map_err(|error| error.to_string())
    };
    let settings = item(SETTINGS, "Settings…", Some("CmdOrCtrl+,"))?;
    let open_files = item(OPEN_FILES, "Open Files…", Some("CmdOrCtrl+O"))?;
    let docs = item(DOCS, "Documentation", None)?;
    let issues = item(ISSUES, "Report an Issue", None)?;
    let quit = item(QUIT, "Quit CONV2", Some("CmdOrCtrl+Q"))?;

    let about = AboutMetadata {
        name: Some("CONV2".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("Copyright © BurntToasters".into()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, "CONV2")
        .about(Some(about))
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
        .map_err(|error| error.to_string())?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&open_files)
        .build()
        .map_err(|error| error.to_string())?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
        .map_err(|error| error.to_string())?;
    let window = SubmenuBuilder::new(app, "Window")
        .close_window()
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()
        .map_err(|error| error.to_string())?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&docs)
        .item(&issues)
        .build()
        .map_err(|error| error.to_string())?;
    let _ = help.set_as_help_menu_for_nsapp();
    let _ = window.set_as_windows_menu_for_nsapp();
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file)
        .item(&edit)
        .item(&window)
        .item(&help)
        .build()
        .map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;

    app.on_menu_event(|app, event| match event.id().as_ref() {
        id @ (SETTINGS | OPEN_FILES) => deliver(app, id),
        DOCS => {
            let _ = app.opener().open_url(DOCS_URL, None::<&str>);
        }
        ISSUES => {
            let _ = app.opener().open_url(ISSUES_URL, None::<&str>);
        }
        QUIT => crate::window::request_quit(app),
        _ => {}
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
