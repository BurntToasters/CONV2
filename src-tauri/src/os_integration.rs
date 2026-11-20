//! Desktop integration for conversions (v1 osIntegration.ts + queueSummary.ts):
//! taskbar/dock progress, sleep inhibition, completion notifications, and
//! macOS-style "click to reveal" behaviour via the notification plugin.

use crate::app_state;
use crate::types::{AppSettings, QueueItemSnapshot, QueueItemStatus};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub const CANCELLED_MESSAGE: &str = "Conversion cancelled";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProgressScope {
    pub file_index: usize,
    pub file_count: usize,
}

static QUEUE_SCOPE: Mutex<Option<ProgressScope>> = Mutex::new(None);
static ACTIVE_SESSIONS: AtomicUsize = AtomicUsize::new(0);
/// The current batch's last successful output, revealed when a completion
/// notification is clicked. Cleared at batch start.
static LAST_OUTPUT: Mutex<Option<String>> = Mutex::new(None);
static POWER_BLOCKER: Mutex<Option<power::Blocker>> = Mutex::new(None);

pub fn init(app: &tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let notification = app.notification();
    if let Err(error) = notification.on_action(|action| {
        if action.action_id() != "tap" {
            return;
        }
        if let Some(app) = app_state::app() {
            let _ = crate::window::show_main_window(app);
        }
        let path = LAST_OUTPUT
            .lock()
            .map(|slot| slot.clone())
            .unwrap_or_default();
        if let Some(path) = path {
            reveal_output(&path);
        }
    }) {
        crate::logging::warn(&format!("Notification actions are unavailable: {error}"));
    }
}

fn reveal_output(path: &str) {
    let Some(app) = app_state::app() else {
        return;
    };
    use tauri_plugin_opener::OpenerExt;
    if let Err(error) = app.opener().reveal_item_in_dir(std::path::Path::new(path)) {
        crate::logging::warn(&format!("Could not reveal {path}: {error}"));
    }
}

pub fn set_queue_scope(scope: Option<ProgressScope>) {
    if let Ok(mut slot) = QUEUE_SCOPE.lock() {
        *slot = scope;
    }
}

/// v1 computeOverallProgress, as a fraction of the whole batch.
pub fn compute_overall_progress(percent: f64, scope: Option<ProgressScope>) -> f64 {
    let file_fraction = percent.clamp(0.0, 100.0) / 100.0;
    let Some(scope) = scope.filter(|scope| scope.file_count > 0) else {
        return file_fraction;
    };
    ((scope.file_index as f64 + file_fraction) / scope.file_count as f64).min(1.0)
}

/// Windows taskbar / macOS Dock progress. Linux is skipped, as in ROSI.
pub fn update_taskbar_progress(percent: f64) {
    if cfg!(target_os = "linux") {
        return;
    }
    let Some(window) = app_state::main_window() else {
        return;
    };
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    let scope = QUEUE_SCOPE.lock().ok().and_then(|scope| *scope);
    let ratio = compute_overall_progress(percent, scope);
    let _ = window.set_progress_bar(ProgressBarState {
        status: Some(ProgressBarStatus::Normal),
        progress: Some((ratio * 100.0).round().clamp(0.0, 100.0) as u64),
    });
}

fn clear_taskbar_progress() {
    if cfg!(target_os = "linux") {
        return;
    }
    let Some(window) = app_state::main_window() else {
        return;
    };
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    let _ = window.set_progress_bar(ProgressBarState {
        status: Some(ProgressBarStatus::None),
        progress: None,
    });
}

/// A batch started: hold a sleep inhibitor when the setting asks for one.
pub fn conversion_activity_started(settings: &AppSettings) {
    set_last_output(None);
    let sessions = ACTIVE_SESSIONS.fetch_add(1, Ordering::SeqCst) + 1;
    if sessions != 1 || !settings.prevent_sleep_while_converting {
        return;
    }
    let blocker = power::acquire();
    if blocker.is_none() {
        crate::logging::warn("Could not prevent sleep while converting.");
    }
    if let Ok(mut slot) = POWER_BLOCKER.lock() {
        *slot = blocker;
    }
}

/// The batch ended: release the inhibitor and clear taskbar progress.
pub fn conversion_activity_ended() {
    let sessions = ACTIVE_SESSIONS.load(Ordering::SeqCst);
    ACTIVE_SESSIONS.store(sessions.saturating_sub(1), Ordering::SeqCst);
    if sessions > 1 {
        return;
    }
    set_queue_scope(None);
    clear_taskbar_progress();
    let blocker = POWER_BLOCKER
        .lock()
        .map(|mut slot| slot.take())
        .unwrap_or_default();
    if let Some(blocker) = blocker {
        power::release(blocker);
    }
}

pub struct QueueSummary {
    pub title: String,
    pub body: String,
}

struct OutcomeCounts {
    total: usize,
    done: usize,
    failed: usize,
    cancelled: usize,
    cpu_fallback: usize,
}

fn count_outcomes(total: usize, items: &[QueueItemSnapshot]) -> OutcomeCounts {
    let total = if total == 0 { items.len() } else { total };
    OutcomeCounts {
        total,
        done: items
            .iter()
            .filter(|item| item.status == QueueItemStatus::Done)
            .count(),
        failed: items
            .iter()
            .filter(|item| item.status == QueueItemStatus::Failed)
            .count(),
        cancelled: items
            .iter()
            .filter(|item| item.status == QueueItemStatus::Cancelled)
            .count(),
        cpu_fallback: items
            .iter()
            .filter(|item| {
                item.status == QueueItemStatus::Done && item.used_cpu_fallback == Some(true)
            })
            .count(),
    }
}

/// v1 summarizeQueueForNotification: one title/body for the completion toast.
pub fn summarize_queue(total: usize, items: &[QueueItemSnapshot]) -> QueueSummary {
    let counts = count_outcomes(total, items);
    let total = counts.total;
    let fixed = |title: &str, body: String| QueueSummary {
        title: title.to_string(),
        body,
    };
    if total <= 1 {
        let Some(item) = items.first() else {
            return fixed(
                "Conversion failed",
                "Conversion did not complete.".to_string(),
            );
        };
        let file_name = if item.file_name.is_empty() {
            None
        } else {
            Some(item.file_name.clone())
        };
        match item.status {
            QueueItemStatus::Done => {
                let suffix = if item.used_cpu_fallback == Some(true) || counts.cpu_fallback > 0 {
                    " (CPU fallback)"
                } else {
                    ""
                };
                return fixed(
                    "Conversion complete",
                    format!(
                        "{}{suffix}",
                        file_name.unwrap_or_else(|| "Your video is ready.".to_string())
                    ),
                );
            }
            QueueItemStatus::Cancelled => {
                return fixed(
                    "Conversion cancelled",
                    file_name.unwrap_or_else(|| "Conversion was cancelled.".to_string()),
                );
            }
            _ => {
                return fixed(
                    "Conversion failed",
                    item.error
                        .clone()
                        .or(file_name)
                        .unwrap_or_else(|| "Conversion did not complete.".to_string()),
                );
            }
        }
    }
    if counts.cancelled > 0 && counts.done > 0 {
        return fixed(
            "Batch cancelled",
            format!("{} of {total} videos converted before cancel.", counts.done),
        );
    }
    if counts.cancelled > 0 {
        return fixed("Batch cancelled", "No videos were converted.".to_string());
    }
    if counts.failed == 0 && counts.done == total {
        let fallback_note = if counts.cpu_fallback > 0 {
            format!(" ({} used CPU fallback)", counts.cpu_fallback)
        } else {
            String::new()
        };
        return fixed(
            "Batch complete",
            format!("All {total} videos converted successfully.{fallback_note}"),
        );
    }
    if counts.done == 0 {
        return fixed(
            "Batch failed",
            format!("None of the {total} videos converted."),
        );
    }
    let fallback_note = if counts.cpu_fallback > 0 {
        format!(", {} CPU fallback", counts.cpu_fallback)
    } else {
        String::new()
    };
    fixed(
        "Batch finished",
        format!(
            "{} succeeded, {} failed ({total} total{fallback_note}).",
            counts.done, counts.failed
        ),
    )
}

fn set_last_output(path: Option<String>) {
    if let Ok(mut slot) = LAST_OUTPUT.lock() {
        *slot = path;
    }
}

/// v1 resolveRevealOutputPath: the batch's last `done` item with an output.
fn reveal_output_path(items: &[QueueItemSnapshot]) -> Option<String> {
    items
        .iter()
        .rev()
        .filter(|item| item.status == QueueItemStatus::Done)
        .find_map(|item| item.output_path.clone().filter(|path| !path.is_empty()))
}

/// Shows the completion toast when the setting is on and the window is in the
/// background. The setting is read now, not at batch start, so turning it off
/// mid-batch suppresses the toast. A click reveals only this batch's output.
/// Returns whether a notification was handed to the OS.
pub fn notify_conversion_complete(summary: &QueueSummary, items: &[QueueItemSnapshot]) -> bool {
    let reveal = reveal_output_path(items);
    set_last_output(reveal.clone());
    if !crate::settings::current().notify_on_conversion_complete {
        return false;
    }
    let Some(window) = app_state::main_window() else {
        return false;
    };
    if window.is_focused().unwrap_or(false) {
        return false;
    }
    let Some(app) = app_state::app() else {
        return false;
    };
    let body = if reveal.is_some() {
        format!("{}\nClick to show output in folder.", summary.body)
    } else {
        summary.body.clone()
    };
    use tauri_plugin_notification::NotificationExt;
    match app
        .notification()
        .builder()
        .title(summary.title.clone())
        .body(body)
        .show()
    {
        Ok(()) => true,
        Err(error) => {
            crate::logging::warn(&format!("Could not show completion notification: {error}"));
            false
        }
    }
}

pub fn register_recent_output(output_path: &str) {
    if output_path.is_empty() {
        return;
    }
    set_last_output(Some(output_path.to_string()));
}

mod power {
    pub struct Blocker(inner::Blocker);

    pub fn acquire() -> Option<Blocker> {
        inner::acquire().map(Blocker)
    }

    pub fn release(blocker: Blocker) {
        inner::release(blocker.0);
    }

    #[cfg(target_os = "macos")]
    mod inner {
        use std::ffi::{c_void, CString};

        type CFTypeRef = *const c_void;
        const ASSERTION_LEVEL_ON: u32 = 255;
        const UTF8: u32 = 0x0800_0100;

        #[link(name = "IOKit", kind = "framework")]
        extern "C" {
            fn IOPMAssertionCreateWithName(
                assertion_type: CFTypeRef,
                level: u32,
                name: CFTypeRef,
                id: *mut u32,
            ) -> i32;
            fn IOPMAssertionRelease(id: u32) -> i32;
        }

        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFStringCreateWithCString(
                alloc: CFTypeRef,
                c_str: *const i8,
                encoding: u32,
            ) -> CFTypeRef;
            fn CFRelease(value: CFTypeRef);
        }

        pub struct Blocker(u32);

        /// `kIOPMAssertionTypeNoIdleSleep` is a header macro, not a linkable
        /// symbol, so the CFString is built from its documented value.
        const ASSERTION_TYPE: &str = "NoIdleSleepAssertion";

        /// Caller releases the returned string.
        unsafe fn cf_string(value: &str) -> Option<CFTypeRef> {
            let value = CString::new(value).ok()?;
            let string = CFStringCreateWithCString(std::ptr::null(), value.as_ptr(), UTF8);
            (!string.is_null()).then_some(string)
        }

        pub fn acquire() -> Option<Blocker> {
            unsafe {
                let assertion_type = cf_string(ASSERTION_TYPE)?;
                let Some(name) = cf_string("CONV2 is converting video") else {
                    CFRelease(assertion_type);
                    return None;
                };
                let mut id = 0u32;
                let result =
                    IOPMAssertionCreateWithName(assertion_type, ASSERTION_LEVEL_ON, name, &mut id);
                CFRelease(name);
                CFRelease(assertion_type);
                (result == 0).then_some(Blocker(id))
            }
        }

        pub fn release(blocker: Blocker) {
            unsafe {
                let _ = IOPMAssertionRelease(blocker.0);
            }
        }
    }

    #[cfg(windows)]
    mod inner {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        };

        pub struct Blocker {
            running: Arc<AtomicBool>,
            thread: Option<std::thread::JoinHandle<()>>,
        }

        pub fn acquire() -> Option<Blocker> {
            let running = Arc::new(AtomicBool::new(true));
            let flag = Arc::clone(&running);
            let thread = std::thread::Builder::new()
                .name("conv2-power".to_string())
                .spawn(move || {
                    // ES_CONTINUOUS persists for this thread until reset.
                    unsafe {
                        SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
                    }
                    while flag.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    unsafe {
                        SetThreadExecutionState(ES_CONTINUOUS);
                    }
                })
                .ok()?;
            Some(Blocker {
                running,
                thread: Some(thread),
            })
        }

        pub fn release(mut blocker: Blocker) {
            blocker.running.store(false, Ordering::SeqCst);
            if let Some(thread) = blocker.thread.take() {
                let _ = thread.join();
            }
        }
    }

    #[cfg(target_os = "linux")]
    mod inner {
        use crate::process_util::{self, ManagedChild};
        use std::process::Stdio;
        use std::sync::Arc;

        /// Best effort: `systemd-inhibit` holds a block inhibitor for the
        /// lifetime of the sleep helper. Sandboxes without it silently skip.
        /// Spawned via process_util, so it gets a scrubbed env, its own
        /// process group, and PDEATHSIG: it dies with CONV2.
        pub struct Blocker(Arc<ManagedChild>);

        pub fn acquire() -> Option<Blocker> {
            let args = [
                "--what=idle:sleep",
                "--who=CONV2",
                "--why=Converting video",
                "--mode=block",
                "sleep",
                "2147483647",
            ]
            .map(str::to_string);
            let mut command = process_util::command("systemd-inhibit", &args, &[], true);
            command.stdout(Stdio::null()).stderr(Stdio::null());
            let child = process_util::spawn(&mut command).ok()?;
            Some(Blocker(child))
        }

        pub fn release(blocker: Blocker) {
            // Waits for the group to exit, so the inhibitor is gone on return.
            process_util::terminate_tree(&blocker.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(status: QueueItemStatus, name: &str, cpu: bool) -> QueueItemSnapshot {
        QueueItemSnapshot {
            id: format!("q-{name}"),
            input_path: format!("/in/{name}"),
            file_name: name.to_string(),
            status,
            error: (status == QueueItemStatus::Failed).then(|| "boom".to_string()),
            error_detail: None,
            output_path: (status == QueueItemStatus::Done).then(|| format!("/out/{name}")),
            used_cpu_fallback: cpu.then_some(true),
        }
    }

    #[test]
    fn overall_progress_weights_files_in_the_batch() {
        assert_eq!(compute_overall_progress(50.0, None), 0.5);
        assert_eq!(
            compute_overall_progress(
                50.0,
                Some(ProgressScope {
                    file_index: 1,
                    file_count: 4
                })
            ),
            0.375
        );
        assert_eq!(
            compute_overall_progress(
                150.0,
                Some(ProgressScope {
                    file_index: 3,
                    file_count: 4
                })
            ),
            1.0
        );
        assert_eq!(
            compute_overall_progress(
                10.0,
                Some(ProgressScope {
                    file_index: 0,
                    file_count: 0
                })
            ),
            0.1
        );
    }

    #[test]
    fn summaries_cover_single_batch_and_fallback_outcomes() {
        let done = summarize_queue(1, &[item(QueueItemStatus::Done, "a.mp4", true)]);
        assert_eq!(done.title, "Conversion complete");
        assert_eq!(done.body, "a.mp4 (CPU fallback)");
        let failed = summarize_queue(1, &[item(QueueItemStatus::Failed, "a.mp4", false)]);
        assert_eq!(failed.title, "Conversion failed");
        assert_eq!(failed.body, "boom");
        let all = summarize_queue(
            2,
            &[
                item(QueueItemStatus::Done, "a.mp4", false),
                item(QueueItemStatus::Done, "b.mp4", true),
            ],
        );
        assert_eq!(all.title, "Batch complete");
        assert_eq!(
            all.body,
            "All 2 videos converted successfully. (1 used CPU fallback)"
        );
        let mixed = summarize_queue(
            3,
            &[
                item(QueueItemStatus::Done, "a.mp4", false),
                item(QueueItemStatus::Failed, "b.mp4", false),
                item(QueueItemStatus::Cancelled, "c.mp4", false),
            ],
        );
        assert_eq!(mixed.title, "Batch cancelled");
        assert_eq!(mixed.body, "1 of 3 videos converted before cancel.");
        let cancelled = summarize_queue(
            2,
            &[
                item(QueueItemStatus::Cancelled, "a.mp4", false),
                item(QueueItemStatus::Cancelled, "b.mp4", false),
            ],
        );
        assert_eq!(cancelled.title, "Batch cancelled");
        assert_eq!(cancelled.body, "No videos were converted.");
        let failed_batch = summarize_queue(
            2,
            &[
                item(QueueItemStatus::Failed, "a.mp4", false),
                item(QueueItemStatus::Failed, "b.mp4", false),
            ],
        );
        assert_eq!(failed_batch.title, "Batch failed");
        assert_eq!(failed_batch.body, "None of the 2 videos converted.");
        let partial = summarize_queue(
            2,
            &[
                item(QueueItemStatus::Done, "a.mp4", false),
                item(QueueItemStatus::Failed, "b.mp4", false),
            ],
        );
        assert_eq!(partial.title, "Batch finished");
        assert_eq!(partial.body, "1 succeeded, 1 failed (2 total).");
    }
}
