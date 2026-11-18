//! Limits and lifecycle flags shared by validation, settings, the conversion
//! queue, and the window close flow.

use std::sync::atomic::{AtomicBool, AtomicU64};

/// Largest FFmpeg stderr tail kept for the Details view and GPU retry logic.
#[allow(dead_code)]
pub const MAX_ERROR_BUFFER: usize = 100_000;
/// `settingsSchemaVersion` of v1's settings.json (settingsSchema.ts).
#[allow(dead_code)]
pub const CURRENT_SETTINGS_VERSION: u32 = 7;

/// Set once the renderer reports startup readiness via
/// `mark_main_window_ready`; gates the deferred main-window reveal.
pub static MAIN_READY: AtomicBool = AtomicBool::new(false);
/// Bumped on every close attempt; the fallback reveal thread uses it to
/// detect that its window was closed and reopened meanwhile.
pub static CLOSE_GENERATION: AtomicU64 = AtomicU64::new(0);
