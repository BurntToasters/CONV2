#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_menu;
mod app_state;
mod command_builders;
mod constants;
mod conversion;
mod ffmpeg_args;
mod ffmpeg_failure;
mod ffmpeg_progress;
mod ffmpeg_status;
mod fs_util;
mod gpu;
mod ipc;
mod legacy;
mod logging;
mod media_info;
mod os_integration;
mod platform;
mod process_util;
mod settings;
mod types;
mod types_ffmpeg;
mod updater;
mod validation;
mod video_pipeline;
mod window;
mod window_state;

#[cfg(target_os = "macos")]
use tauri::Manager;

fn production_integrations_enabled() -> bool {
    !cfg!(feature = "e2e")
}

/// Emit late conversion events so the E2E suite can prove the renderer
/// ignores stale queue and progress traffic.
#[cfg(feature = "e2e")]
#[tauri::command]
fn e2e_emit_stale_conversion_events(
    window: tauri::WebviewWindow,
    progress_percent: f64,
) -> Result<(), String> {
    use crate::types::{ConversionProgress, QueueItemSnapshot, QueueItemStatus, QueueSnapshot};
    if window.label() != app_state::MAIN_WINDOW {
        return Err("Only the main window may emit E2E conversion events.".into());
    }
    if !(0.0..=100.0).contains(&progress_percent) {
        return Err("The E2E progress percent is outside the permitted range.".into());
    }
    let snapshot = QueueSnapshot {
        active: false,
        preset_id: "e2e-stale".to_string(),
        current_index: 0,
        total: 1,
        items: vec![QueueItemSnapshot {
            id: format!("e2e-stale-{progress_percent}"),
            input_path: "/tmp/e2e/stale-input.mp4".to_string(),
            file_name: "stale-input.mp4".to_string(),
            status: QueueItemStatus::Done,
            error: None,
            error_detail: None,
            output_path: Some("/tmp/e2e/stale-output.mp4".to_string()),
            used_cpu_fallback: Some(false),
        }],
    };
    app_state::emit("conversion-queue-updated", snapshot);
    app_state::emit(
        "conversion-progress",
        ConversionProgress {
            percent: progress_percent,
            frame: 0,
            fps: 0.0,
            time: "00:00:00.00".to_string(),
            bitrate: "N/A".to_string(),
            speed: "1x".to_string(),
        },
    );
    app_state::emit("conversion-log", "[e2e] stale conversion event".to_string());
    Ok(())
}

#[cfg(feature = "e2e")]
#[tauri::command]
fn e2e_updater_install_probe(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != app_state::MAIN_WINDOW {
        return Err("Only the main window may run the E2E updater install probe.".into());
    }
    window::shutdown()
}

macro_rules! generate_app_handler {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            settings::get_settings,
            settings::get_default_settings,
            settings::save_settings,
            settings::reset_settings,
            conversion::start_conversion_queue,
            conversion::cancel_conversion,
            platform::select_output_directory,
            platform::select_input_files,
            media_info::get_file_info,
            command_builders::get_presets,
            gpu::get_gpu_capabilities,
            gpu::refresh_gpu_capabilities,
            ffmpeg_status::check_ffmpeg,
            platform::get_app_platform,
            platform::get_distribution_channel,
            platform::get_system_theme,
            platform::open_external,
            platform::reveal_path,
            window::restart_app,
            window::set_conversion_menu_state,
            logging::log_error,
            window::mark_main_window_ready,
            updater::check_for_updates,
            updater::download_update,
            updater::install_update,
            updater::cancel_update_download,
            updater::set_update_channel,
            $($extra),*
        ]
    };
}

fn main() {
    logging::install_panic_hook();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(feature = "e2e")]
    {
        builder = builder
            .plugin(tauri_plugin_wdio::init())
            .plugin(tauri_plugin_wdio_webdriver::init());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if production_integrations_enabled() {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                // Window work from the single-instance callback can deadlock
                // WebView2 on Windows; dispatch after the callback returns.
                let handle = app.clone();
                std::thread::spawn(move || {
                    let main_thread = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Err(error) = window::show_main_window(&main_thread) {
                            logging::warn(&format!("Failed to focus main window: {error}"));
                        }
                    });
                });
            }));
        }
        // Microsoft Store builds update through the Store, never in-app.
        if platform::distribution_channel() != "msstore" {
            // Windows installs exit via process::exit, skipping RunEvent::Exit.
            builder = builder.plugin(
                tauri_plugin_updater::Builder::new()
                    .on_before_exit(|| {
                        logging::info("Flushing application state before installing the update.");
                        window::shutdown()
                    })
                    .build(),
            );
        }
    }

    #[cfg(feature = "e2e")]
    let invoke_handler: Box<tauri::ipc::InvokeHandler<tauri::Wry>> =
        Box::new(generate_app_handler![
            e2e_emit_stale_conversion_events,
            e2e_updater_install_probe,
            updater::e2e_configure_updater,
            updater::e2e_updater_probe,
            window::e2e_cancel_close_request,
        ]);
    #[cfg(not(feature = "e2e"))]
    let invoke_handler: Box<tauri::ipc::InvokeHandler<tauri::Wry>> =
        Box::new(generate_app_handler![]);

    let app = builder
        .setup(move |app| {
            #[cfg(all(feature = "e2e", target_os = "macos"))]
            if window::e2e_background() {
                // No Dock icon and no activation, so E2E launches never steal focus.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            app_state::init(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            logging::info(&format!(
                "CONV2 {} starting ({} {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            // Before anything reads settings or the queue.
            legacy::import_on_first_launch(app.handle());
            settings::init();
            conversion::init();
            os_integration::init(app.handle());
            if let Err(error) = app_menu::install(app.handle()) {
                logging::warn(&format!("Failed to install macOS app menu: {error}"));
            }
            window::show_main_window(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            Ok(())
        })
        .invoke_handler(invoke_handler)
        .build(tauri::generate_context!())
        .expect("failed to initialize Tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == app_state::MAIN_WINDOW => window::on_main_close_requested(app_handle, &api),
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_),
            ..
        } if label == app_state::MAIN_WINDOW => {
            if let Some(window) = app_state::main_window() {
                window_state::track(&window);
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == app_state::MAIN_WINDOW => window::on_main_destroyed(app_handle),
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            // macOS keeps running in the Dock after its last window closes.
            if cfg!(target_os = "macos")
                && code.is_none()
                && !window::APP_QUITTING.load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            if let Err(error) = window::shutdown() {
                logging::error(&format!(
                    "Could not confirm durable state during final shutdown: {error}"
                ));
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } if app_handle
            .get_webview_window(app_state::MAIN_WINDOW)
            .is_none() =>
        {
            if let Err(error) = window::show_main_window(app_handle) {
                logging::warn(&format!("Failed to reopen main window: {error}"));
            }
        }
        _ => {}
    });
}
