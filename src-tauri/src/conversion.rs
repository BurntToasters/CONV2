//! Conversion queue: request validation, sequential FFmpeg runs with CPU and
//! software-decode fallbacks, cancellation, and progress reporting (v1
//! conversionController.ts + conversionQueue.ts + ffmpeg.ts convertVideo).

use crate::app_state;
use crate::command_builders::{self, get_preset, Preset, PresetContext, SourceStreamInfo};
use crate::ffmpeg_args;
use crate::ffmpeg_failure;
use crate::ffmpeg_progress;
use crate::ffmpeg_status;
use crate::gpu;
use crate::ipc::{self, FalliblePayload, IpcResult, JsonObject, INTERNAL_ERROR, VALIDATION_ERROR};
use crate::media_info;
use crate::os_integration;
use crate::process_util::{self, ManagedChild};
use crate::settings;
use crate::types::{
    AppSettings, ConversionProgress, GpuCodec, GpuVendor, QueueItemSnapshot, QueueItemStatus,
    QueueSnapshot, StartConversionQueuePayload,
};
use crate::validation;
use crate::video_pipeline;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// A single batch is bounded because every state change broadcasts a snapshot.
pub const MAX_QUEUE_ITEMS: usize = 500;

/// v1 MAX_PROGRESS_EMIT_INTERVAL_MS.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);
/// v1's stop() wait, then its second, shorter wait.
const STOP_WAIT: Duration = Duration::from_secs(3);
const STOP_RETRY_WAIT: Duration = Duration::from_millis(1500);

struct QueueState {
    active: bool,
    /// An update install owns the filesystem/restart window; queue claims and
    /// other installs are refused until its guard drops.
    install_reserved: bool,
    run: u64,
    cancelled: bool,
    child: Option<Arc<ManagedChild>>,
}

static STATE: Mutex<QueueState> = Mutex::new(QueueState {
    active: false,
    install_reserved: false,
    run: 0,
    cancelled: false,
    child: None,
});
static IDLE: Condvar = Condvar::new();
/// Lock-free mirror of `state.cancelled` for probes and reader threads.
static CANCELLED: AtomicBool = AtomicBool::new(false);

fn lock_state() -> std::sync::MutexGuard<'static, QueueState> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reserves the queue against conversions for one update install. Released by
/// Drop on success, failure, or a refused restart.
pub struct InstallReservation {
    _private: (),
}

impl Drop for InstallReservation {
    fn drop(&mut self) {
        {
            let mut state = lock_state();
            state.install_reserved = false;
        }
        IDLE.notify_all();
    }
}

/// Atomically acquire the install reservation only while no batch runs.
pub fn reserve_install() -> Option<InstallReservation> {
    let mut state = lock_state();
    if state.active || state.install_reserved {
        return None;
    }
    state.install_reserved = true;
    Some(InstallReservation { _private: () })
}

/// Initialize queue state at startup. v1 persisted no queue: every batch was
/// in-memory only, so there is nothing to load.
pub fn init() {}

pub fn is_active() -> bool {
    lock_state().active
}

fn is_cancelled(run: u64) -> bool {
    if CANCELLED.load(Ordering::SeqCst) {
        return true;
    }
    let state = lock_state();
    state.run != run || state.cancelled
}

/// v1 cancel(): mark the batch, stop the preflight probe, and terminate the
/// running FFmpeg. The worker also observes the flag and kills the tree.
pub fn cancel(force: bool) {
    CANCELLED.store(true, Ordering::SeqCst);
    media_info::cancel_conversion_probe();
    let child = {
        let mut state = lock_state();
        state.cancelled = true;
        state.child.clone()
    };
    if let Some(child) = child {
        if force {
            process_util::kill_tree(&child);
        } else {
            process_util::terminate_tree(&child);
        }
    }
}

/// Cancel and wait for the worker to finish, so FFmpeg cannot outlive CONV2.
pub fn stop() {
    if !is_active() {
        return;
    }
    cancel(true);
    if wait_for_idle(STOP_WAIT) {
        return;
    }
    cancel(true);
    let _ = wait_for_idle(STOP_RETRY_WAIT);
}

fn wait_for_idle(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut state = lock_state();
    while state.active {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let (next, _) = IDLE
            .wait_timeout(state, deadline.saturating_duration_since(now))
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state = next;
    }
    true
}

struct RunGuard {
    run: u64,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        os_integration::conversion_activity_ended();
        {
            let mut state = lock_state();
            if state.run == self.run {
                state.active = false;
                state.cancelled = false;
                state.child = None;
            }
        }
        CANCELLED.store(false, Ordering::SeqCst);
        IDLE.notify_all();
    }
}

// ---------------------------------------------------------------------------
// Request validation (v1 validateQueueRequest).
// ---------------------------------------------------------------------------

struct QueueRequest {
    input_paths: Vec<String>,
    preset: &'static Preset,
    preset_id: String,
    gpu: GpuVendor,
    remove_spaces_from_filenames: Option<bool>,
    output_directory: Option<String>,
    show_debug_output: Option<bool>,
}

enum Validation {
    Run(QueueRequest),
    Reject(QueueSnapshot),
}

fn empty_snapshot() -> QueueSnapshot {
    QueueSnapshot {
        active: false,
        preset_id: String::new(),
        current_index: 0,
        total: 0,
        items: Vec::new(),
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn reject_all(input_paths: &[String], prefix: &str, error: &str, total: usize) -> QueueSnapshot {
    let mut snapshot = empty_snapshot();
    snapshot.total = total;
    snapshot.items = input_paths
        .iter()
        .take(MAX_QUEUE_ITEMS)
        .enumerate()
        .map(|(index, input_path)| QueueItemSnapshot {
            id: format!("{prefix}-{index}"),
            input_path: input_path.clone(),
            file_name: file_name(input_path),
            status: QueueItemStatus::Failed,
            error: Some(error.to_string()),
            error_detail: None,
            output_path: None,
            used_cpu_fallback: None,
        })
        .collect();
    snapshot
}

/// Validates and claims the single queue slot atomically, so two concurrent
/// invocations cannot both start a batch.
fn validate_and_claim(payload: &StartConversionQueuePayload) -> Validation {
    let input_paths: Vec<String> = payload
        .input_paths
        .iter()
        .filter(|path| !path.is_empty())
        .cloned()
        .collect();
    let mut state = lock_state();
    if state.active || state.install_reserved {
        let snapshot = reject_all(
            &input_paths,
            "busy",
            "Another conversion is already in progress",
            input_paths.len(),
        );
        return Validation::Reject(snapshot);
    }
    if input_paths.is_empty() {
        return Validation::Reject(empty_snapshot());
    }
    if input_paths.len() > MAX_QUEUE_ITEMS {
        return Validation::Reject(reject_all(
            &input_paths,
            "too-many",
            &format!("A single batch is limited to {MAX_QUEUE_ITEMS} files"),
            input_paths.len(),
        ));
    }
    let Some(preset) = get_preset(&payload.preset_id) else {
        let mut snapshot = reject_all(
            &input_paths,
            "invalid",
            "Invalid preset selected",
            input_paths.len(),
        );
        snapshot.preset_id = payload.preset_id.clone();
        return Validation::Reject(snapshot);
    };
    state.active = true;
    state.run = state.run.wrapping_add(1);
    state.cancelled = false;
    state.child = None;
    CANCELLED.store(false, Ordering::SeqCst);
    Validation::Run(QueueRequest {
        input_paths,
        preset,
        preset_id: payload.preset_id.clone(),
        gpu: payload.gpu,
        remove_spaces_from_filenames: payload.remove_spaces_from_filenames,
        output_directory: payload.output_directory.clone(),
        show_debug_output: payload.show_debug_output,
    })
}

// ---------------------------------------------------------------------------
// Queue commands.
// ---------------------------------------------------------------------------

/// Resolves when the whole batch ends, as v1's handler did. The batch runs on
/// the blocking pool so a long queue never occupies an async worker.
#[tauri::command]
pub async fn start_conversion_queue(
    payload: FalliblePayload<JsonObject<StartConversionQueuePayload>>,
) -> IpcResult<QueueSnapshot> {
    let request = match payload.into_typed(VALIDATION_ERROR, "Invalid conversion queue request.") {
        Ok(request) => request.0,
        Err(error) => return ipc::from_error(error),
    };
    match validate_and_claim(&request) {
        Validation::Reject(snapshot) => {
            app_state::emit("conversion-queue-updated", snapshot.clone());
            ipc::ok(snapshot)
        }
        Validation::Run(request) => {
            let run = lock_state().run;
            match tauri::async_runtime::spawn_blocking(move || run_queue(run, request)).await {
                Ok(snapshot) => ipc::ok(snapshot),
                Err(error) => ipc::err(INTERNAL_ERROR, error.to_string()),
            }
        }
    }
}

#[tauri::command(async)]
pub fn cancel_conversion(force: Option<FalliblePayload<bool>>) -> IpcResult<()> {
    let force = match force {
        None => false,
        Some(payload) => match payload.into_typed(VALIDATION_ERROR, "Invalid cancel request.") {
            Ok(value) => value,
            Err(error) => return ipc::from_error(error),
        },
    };
    cancel(force);
    ipc::ok(())
}

// ---------------------------------------------------------------------------
// Queue runner (v1 runConversionQueue).
// ---------------------------------------------------------------------------

fn snapshot_of(preset_id: &str, items: &[QueueItemSnapshot]) -> QueueSnapshot {
    QueueSnapshot {
        active: items.iter().any(|item| {
            matches!(
                item.status,
                QueueItemStatus::Pending | QueueItemStatus::Running
            )
        }),
        preset_id: preset_id.to_string(),
        current_index: items
            .iter()
            .position(|item| {
                matches!(
                    item.status,
                    QueueItemStatus::Running | QueueItemStatus::Pending
                )
            })
            .unwrap_or(0),
        total: items.len(),
        items: items.to_vec(),
    }
}

fn run_queue(run: u64, request: QueueRequest) -> QueueSnapshot {
    let _guard = RunGuard { run };
    let now = app_state::now_ms();
    let mut items: Vec<QueueItemSnapshot> = request
        .input_paths
        .iter()
        .enumerate()
        .map(|(index, input_path)| QueueItemSnapshot {
            id: format!("q-{index}-{now}"),
            input_path: input_path.clone(),
            file_name: file_name(input_path),
            status: QueueItemStatus::Pending,
            error: None,
            error_detail: None,
            output_path: None,
            used_cpu_fallback: None,
        })
        .collect();

    let settings = settings::current();
    let codec =
        command_builders::preset_gpu_codec(request.preset, &settings.advanced_format_settings);
    let show_debug = request
        .show_debug_output
        .unwrap_or(settings.show_debug_output);
    let remove_spaces = request
        .remove_spaces_from_filenames
        .unwrap_or(settings.remove_spaces_from_filenames);

    app_state::emit(
        "conversion-queue-updated",
        snapshot_of(&request.preset_id, &items),
    );
    os_integration::set_queue_scope(None);
    os_integration::conversion_activity_started(&settings);

    let mut gpu = request.gpu;
    for index in 0..items.len() {
        if is_cancelled(run) {
            for item in items.iter_mut().skip(index) {
                if item.status == QueueItemStatus::Pending {
                    item.status = QueueItemStatus::Cancelled;
                }
            }
            app_state::emit(
                "conversion-queue-updated",
                snapshot_of(&request.preset_id, &items),
            );
            break;
        }
        items[index].status = QueueItemStatus::Running;
        app_state::emit(
            "conversion-queue-updated",
            snapshot_of(&request.preset_id, &items),
        );
        os_integration::set_queue_scope(Some(os_integration::ProgressScope {
            file_index: index,
            file_count: items.len(),
        }));
        let reporter = Reporter { show_debug };
        if show_debug && items.len() > 1 {
            reporter.log(&format!(
                "\n=== [{}/{}] {} ===\n",
                index + 1,
                items.len(),
                items[index].file_name
            ));
        }

        let options = ConvertOptions {
            suppress_gpu_error_event: true,
            remove_spaces,
            output_directory: request.output_directory.clone(),
            show_debug,
        };
        let mut outcome = convert_one(run, request.preset, &items[index].input_path, gpu, &options);
        let mut used_cpu_fallback = false;
        if !is_cancelled(run)
            && ffmpeg_failure::should_retry_with_cpu(
                outcome.success,
                outcome.error.as_deref() == Some(os_integration::CANCELLED_MESSAGE),
                gpu,
                codec.is_some(),
                &format!(
                    "{}\n{}",
                    outcome.error.as_deref().unwrap_or(""),
                    outcome.error_detail.as_deref().unwrap_or("")
                ),
                outcome.retry_with_cpu_suggested,
            )
        {
            reporter.log(&format!(
                "[GPU fallback] Retry with CPU for {}\n",
                items[index].file_name
            ));
            outcome = convert_one(
                run,
                request.preset,
                &items[index].input_path,
                GpuVendor::Cpu,
                &options,
            );
            used_cpu_fallback = true;
            if gpu != GpuVendor::Cpu {
                gpu = GpuVendor::Cpu;
            }
        }

        if outcome.success {
            items[index].status = QueueItemStatus::Done;
            items[index].output_path = Some(outcome.output_path.clone());
            items[index].used_cpu_fallback = used_cpu_fallback.then_some(true);
        } else if outcome.error.as_deref() == Some(os_integration::CANCELLED_MESSAGE)
            || is_cancelled(run)
        {
            items[index].status = QueueItemStatus::Cancelled;
            items[index].error = outcome.error.clone();
            for item in items.iter_mut().skip(index + 1) {
                item.status = QueueItemStatus::Cancelled;
            }
            app_state::emit(
                "conversion-queue-updated",
                snapshot_of(&request.preset_id, &items),
            );
            break;
        } else {
            items[index].status = QueueItemStatus::Failed;
            items[index].error = outcome.error.clone();
            items[index].error_detail = outcome.error_detail.clone();
            items[index].used_cpu_fallback = used_cpu_fallback.then_some(true);
        }
        app_state::emit(
            "conversion-queue-updated",
            snapshot_of(&request.preset_id, &items),
        );
    }

    let mut final_snapshot = snapshot_of(&request.preset_id, &items);
    final_snapshot.active = false;
    app_state::emit("conversion-queue-updated", final_snapshot.clone());
    os_integration::set_queue_scope(None);
    let summary = os_integration::summarize_queue(final_snapshot.total, &items);
    os_integration::notify_conversion_complete(&summary, &settings);
    final_snapshot
}

// ---------------------------------------------------------------------------
// One conversion (v1 performSingleConversion + convertVideo).
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ConvertOptions {
    suppress_gpu_error_event: bool,
    remove_spaces: bool,
    output_directory: Option<String>,
    show_debug: bool,
}

#[derive(Clone, Copy)]
struct Reporter {
    show_debug: bool,
}

impl Reporter {
    fn progress(&self, progress: ConversionProgress) {
        os_integration::update_taskbar_progress(progress.percent);
        app_state::emit("conversion-progress", progress);
    }

    fn log(&self, message: &str) {
        if self.show_debug {
            self.log_always(message);
        }
    }

    fn log_always(&self, message: &str) {
        app_state::emit("conversion-log", validation::redact_paths(message));
    }
}

struct Outcome {
    success: bool,
    output_path: String,
    error: Option<String>,
    error_detail: Option<String>,
    retry_with_cpu_suggested: bool,
}

impl Outcome {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            success: false,
            output_path: String::new(),
            error: Some(message.into()),
            error_detail: None,
            retry_with_cpu_suggested: false,
        }
    }
}

fn remove_output(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            crate::logging::warn(&format!("Failed to delete {}: {error}", path.display()))
        }
    }
}

/// A private staging area for one FFmpeg attempt. FFmpeg writes here only;
/// the reserved public leaf is replaced atomically after a verified success.
struct StagedOutput {
    dir: PathBuf,
    file: PathBuf,
}

impl StagedOutput {
    fn create(output_path: &Path) -> Result<Self, String> {
        let Some(parent) = output_path.parent() else {
            return Err(format!(
                "Could not stage output next to {}: no parent directory",
                output_path.display()
            ));
        };
        let Some(name) = output_path.file_name() else {
            return Err(format!(
                "Could not stage output for {}: no file name",
                output_path.display()
            ));
        };
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        for _ in 0..64 {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let dir = parent.join(format!(".conv2-stage-{}-{sequence}", std::process::id()));
            match create_private_dir(&dir) {
                Ok(()) => {
                    return Ok(Self {
                        file: dir.join(Path::new(name)),
                        dir,
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not create staging directory {}: {error}",
                        dir.display()
                    ))
                }
            }
        }
        Err(format!(
            "Could not create a staging directory next to {}",
            output_path.display()
        ))
    }

    fn path(&self) -> &Path {
        &self.file
    }

    /// Verify the staged result, then replace the reserved leaf atomically.
    fn promote(self, output_path: &Path) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(&self.file).map_err(|error| {
            format!(
                "Could not verify staged output {}: {error}",
                self.file.display()
            )
        })?;
        if !metadata.file_type().is_file() || metadata.len() == 0 {
            return Err("FFmpeg reported success but produced no output file.".to_string());
        }
        replace_output_leaf(&self.file, output_path)
    }
}

impl Drop for StagedOutput {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Replace only the argv output operand with the staged path, preserving the
/// output extension/format.
fn replace_output_operand(args: &[String], staged: &Path) -> Option<Vec<String>> {
    let mut next = args.to_vec();
    let output = next.pop()?;
    if output.is_empty() {
        return None;
    }
    next.push(staged.to_string_lossy().into_owned());
    Some(next)
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir(path)
    }
}

/// Replace the leaf entry itself, never a symlink or hardlink target. Unix
/// rename replaces the entry atomically; Windows refuses an existing
/// destination, so unlink the occupant and retry once, failing safely if
/// another entry appears.
fn replace_output_leaf(staged: &Path, output_path: &Path) -> Result<(), String> {
    match std::fs::rename(staged, output_path) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Could not finalize output {}: {error}",
                output_path.display()
            ))
        }
    }
    match std::fs::remove_file(output_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not replace output {}: {error}",
                output_path.display()
            ))
        }
    }
    match std::fs::rename(staged, output_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "Output path was replaced before FFmpeg finished: {}",
            output_path.display()
        )),
        Err(error) => Err(format!(
            "Could not finalize output {}: {error}",
            output_path.display()
        )),
    }
}

fn cancelled_outcome(output_path: &Path) -> Outcome {
    remove_output(output_path);
    Outcome {
        success: false,
        output_path: output_path.to_string_lossy().into_owned(),
        error: Some(os_integration::CANCELLED_MESSAGE.to_string()),
        error_detail: None,
        retry_with_cpu_suggested: false,
    }
}

fn cancelled_before_claim() -> Outcome {
    Outcome {
        success: false,
        output_path: String::new(),
        error: Some(os_integration::CANCELLED_MESSAGE.to_string()),
        error_detail: None,
        retry_with_cpu_suggested: false,
    }
}

fn ffmpeg_unavailable_message(status: &crate::types::FFmpegStatus) -> String {
    use crate::types::FFmpegStatusReason;
    if !status.using_bundled {
        return "FFmpeg was not found on your system PATH. Install FFmpeg, or turn off System FFmpeg in Settings.".to_string();
    }
    match status.reason {
        FFmpegStatusReason::VerificationFailed => {
            "CONV2's bundled FFmpeg failed its integrity check. Reinstall CONV2, or enable System FFmpeg in Settings.".to_string()
        }
        FFmpegStatusReason::NotRunnable => {
            "CONV2's bundled FFmpeg could not start. Reinstall CONV2.".to_string()
        }
        _ => "CONV2's bundled FFmpeg is missing. Reinstall CONV2, or enable System FFmpeg in Settings."
            .to_string(),
    }
}

fn convert_one(
    run: u64,
    preset: &'static Preset,
    input_path: &str,
    gpu_override: GpuVendor,
    options: &ConvertOptions,
) -> Outcome {
    let Some(input) = validation::existing_file(input_path) else {
        return Outcome::failed("Invalid input file path");
    };
    let settings = settings::current();
    let platform = crate::types_ffmpeg::node_platform();
    let arch = crate::types_ffmpeg::node_arch();
    let requested_gpu = gpu_override;
    let codec = command_builders::preset_gpu_codec(preset, &settings.advanced_format_settings);
    let effective_gpu =
        command_builders::effective_conversion_gpu(requested_gpu, codec, platform, arch);
    let reporter = Reporter {
        show_debug: options.show_debug,
    };

    if is_cancelled(run) {
        return cancelled_before_claim();
    }
    if let Some(codec) = codec {
        if effective_gpu != GpuVendor::Cpu {
            let support = gpu::check_encoder_support(effective_gpu, codec, &CANCELLED);
            if is_cancelled(run) {
                return cancelled_before_claim();
            }
            if !support.available {
                if let Some(error) = support.error {
                    if !options.suppress_gpu_error_event {
                        app_state::emit("gpu-encoder-error", error.clone());
                    }
                    return Outcome {
                        success: false,
                        output_path: String::new(),
                        error: Some(error.message),
                        error_detail: None,
                        retry_with_cpu_suggested: error.can_retry_with_cpu,
                    };
                }
            }
        }
    }

    let output_dir = options
        .output_directory
        .as_deref()
        .and_then(validation::existing_directory)
        .or_else(|| validation::existing_directory(&settings.output_directory))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(&input)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        });

    let input_basename = Path::new(&input)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| input.clone());
    let basename_without_spaces: String = input_basename
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let output_base_name = if options.remove_spaces && !basename_without_spaces.is_empty() {
        basename_without_spaces
    } else {
        input_basename
    };
    if !is_dir_writable(&output_dir) {
        return Outcome::failed(format!(
            "Output directory is not writable: {}",
            output_dir.display()
        ));
    }
    let output_path = match ffmpeg_args::resolve_unique_output_path(
        &output_dir,
        &output_base_name,
        preset.extension,
    ) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Outcome::failed(format!(
                "Output directory is not writable: {}",
                output_dir.display()
            ))
        }
        Err(error) => return Outcome::failed(error.to_string()),
    };

    let mut total_duration = 0.0;
    let mut video_info = None;
    match media_info::probe_for_conversion(&input) {
        Ok(info) => {
            total_duration = info.duration;
            video_info = Some(info);
        }
        Err(media_info::ProbeError::Cancelled) => return cancelled_outcome(&output_path),
        Err(media_info::ProbeError::Failed) => {}
    }
    if video_info
        .as_ref()
        .is_some_and(|info| info.has_video == Some(false))
        && ffmpeg_args::is_video_output_category(preset.category)
    {
        remove_output(&output_path);
        return Outcome::failed(ffmpeg_failure::NO_VIDEO_MESSAGE);
    }
    if preset.category == "remux" {
        let Some(info) = video_info.as_ref() else {
            remove_output(&output_path);
            return Outcome::failed(
                "Could not read input media for remux. The file may be unreadable or corrupt.",
            );
        };
        if let Some(reason) = ffmpeg_args::get_remux_incompatibility_reason(
            Some(&info.codec),
            preset.extension,
            info.audio_codec.as_deref(),
        ) {
            remove_output(&output_path);
            return Outcome::failed(reason);
        }
    }
    if total_duration <= 0.0 {
        match media_info::probe_duration_for_conversion(&input) {
            Ok(duration) => total_duration = duration,
            Err(media_info::ProbeError::Cancelled) => return cancelled_outcome(&output_path),
            Err(media_info::ProbeError::Failed) => {
                crate::logging::warn("Could not get video duration, progress may be inaccurate");
            }
        }
    }
    warn_when_disk_space_is_low(&input, &output_dir, &reporter);

    let is_video_preset = codec.is_some();
    let mut active_gpu = effective_gpu;
    let render_node = if is_video_preset && gpu::uses_vaapi(effective_gpu, platform) {
        match gpu::find_vaapi_render_node(effective_gpu) {
            Some(node) => Some(node),
            None => {
                reporter.log(&format!(
                    "No {} render node found under /dev/dri; converting on CPU.\n",
                    gpu::gpu_name(effective_gpu)
                ));
                active_gpu = GpuVendor::Cpu;
                None
            }
        }
    } else {
        None
    };
    let use_hardware_decode =
        is_video_preset && !(settings.use_cpu_decoding_when_gpu && active_gpu != GpuVendor::Cpu);
    let input_codec = video_info.as_ref().map(|info| info.codec.clone());
    let decode_args = if use_hardware_decode {
        gpu::hardware_decode_args(active_gpu, input_codec.as_deref())
    } else {
        Vec::new()
    };
    if is_cancelled(run) {
        return cancelled_outcome(&output_path);
    }

    let streams = video_info.as_ref().map(|info| SourceStreamInfo {
        subtitle_codecs: info.subtitle_codecs.clone(),
        audio_channels: info.audio_channels.clone(),
    });
    let context = PresetContext {
        advanced_format_settings: Some(&settings.advanced_format_settings),
        source_streams: streams.as_ref(),
        platform,
    };
    let mut preset_args = command_builders::build_args(
        preset,
        &input,
        &output_path.to_string_lossy(),
        active_gpu,
        context,
    );
    preset_args = ffmpeg_args::ensure_mp4_playback_compatibility_args(
        preset,
        &preset_args,
        input_codec.as_deref(),
    );
    let Some(guarded) = ffmpeg_args::with_input_protocol_args(&preset_args, &input) else {
        remove_output(&output_path);
        return Outcome::failed("Internal error: preset has no input.");
    };
    preset_args = guarded;
    if let Some(node) = &render_node {
        // Upload first, so a tone-map prepended later runs before it.
        preset_args = ffmpeg_args::insert_before_input(
            &preset_args,
            &["-vaapi_device".to_string(), node.clone()],
        );
        preset_args = video_pipeline::apply_video_filter(
            &preset_args,
            &video_pipeline::vaapi_upload_filter(
                preset.category,
                codec.unwrap_or(GpuCodec::H264),
                video_info.as_ref().and_then(|info| info.pix_fmt.as_deref()),
            ),
        );
    }

    let mut active_decode_args = decode_args.clone();
    let needs_video_plan = is_video_preset || matches!(preset.category, "gif" | "webp");
    if needs_video_plan
        && (video_info.is_some() || active_gpu == GpuVendor::Qualcomm)
        && !preset_args.is_empty()
    {
        let source = video_info.as_ref().map(|info| video_pipeline::SourceColor {
            pix_fmt: info.pix_fmt.as_deref(),
            color_primaries: info.color_primaries.as_deref(),
            color_transfer: info.color_transfer.as_deref(),
            color_space: info.color_space.as_deref(),
            color_range: info.color_range.as_deref(),
        });
        let pipeline = video_pipeline::plan_video_pipeline(video_pipeline::PipelineInput {
            category: preset.category,
            encode_vendor: command_builders::resolve_encode_vendor(
                codec.unwrap_or(GpuCodec::H264),
                active_gpu,
                platform,
            ),
            source,
            decode_args: decode_args.clone(),
            can_tonemap: gpu::can_tonemap_hdr(),
        });
        active_decode_args = pipeline.decode_args;
        if let Some(filter) = pipeline.filter {
            preset_args = video_pipeline::apply_video_filter(&preset_args, &filter);
            reporter.log("HDR source: tone-mapping to SDR (BT.709) for an 8-bit output.\n");
        }
        if let Some(warning) = pipeline.warning {
            reporter.log(&format!("Warning: {warning}\n"));
        }
        let output_args = if matches!(preset.category, "gif" | "webp") {
            Vec::new()
        } else {
            pipeline.output_args
        };
        preset_args = ffmpeg_args::splice_output_args(&preset_args, &output_args);
    }

    let mut outcome = run_attempts(
        run,
        &preset_args,
        active_decode_args,
        &output_path,
        total_duration,
        &reporter,
    );
    if !outcome.success
        && outcome.error.as_deref() != Some(os_integration::CANCELLED_MESSAGE)
        && outcome.error.as_deref().is_some()
        && effective_gpu != GpuVendor::Cpu
    {
        if let Some(codec) = codec {
            let stderr = outcome.error_detail.as_deref().unwrap_or("");
            if let Some(error) = gpu::parse_gpu_error(stderr, effective_gpu, Some(codec)) {
                outcome.retry_with_cpu_suggested = error.can_retry_with_cpu;
                if !options.suppress_gpu_error_event {
                    app_state::emit("gpu-encoder-error", error);
                }
            }
        }
    }

    if outcome.success {
        maybe_trash_original(&input, &outcome.output_path, &settings, &reporter, run);
        os_integration::register_recent_output(&outcome.output_path);
    }
    if let Some(error) = outcome.error.as_mut() {
        *error = validation::redact_paths(error);
    }
    if let Some(detail) = outcome.error_detail.as_mut() {
        *detail = validation::redact_paths(detail);
    }
    outcome
}

fn maybe_trash_original(
    input: &str,
    output_path: &str,
    settings: &AppSettings,
    reporter: &Reporter,
    run: u64,
) {
    if !settings.move_original_to_trash_on_success {
        return;
    }
    if is_cancelled(run) {
        return;
    }
    let ready = !output_path.is_empty()
        && std::fs::metadata(output_path)
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false);
    if !ready {
        reporter.log_always("Skipped trashing original: output file missing or empty.\n");
        return;
    }
    match trash::delete(input) {
        Ok(()) => reporter.log(&format!("Moved original file to trash: {input}\n")),
        Err(error) => {
            let message = error.to_string();
            reporter.log_always(&format!(
                "Failed to move original file to trash: {message}\n"
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// FFmpeg attempts, stderr capture, and progress throttling.
// ---------------------------------------------------------------------------

fn run_attempts(
    run: u64,
    preset_args: &[String],
    decode_args: Vec<String>,
    output_path: &Path,
    total_duration: f64,
    reporter: &Reporter,
) -> Outcome {
    let args: Vec<String> = {
        let mut args = ["-hide_banner", "-y", "-progress", "pipe:1"]
            .map(str::to_string)
            .to_vec();
        args.extend(decode_args.iter().cloned());
        args.extend(preset_args.iter().cloned());
        args
    };
    reporter.log(&format!("Running command: ffmpeg {}\n", args.join(" ")));
    let mut attempt = run_ffmpeg(run, &args, output_path, total_duration, reporter);
    if attempt.cancelled {
        remove_output(output_path);
        return cancelled_outcome(output_path);
    }
    if let Some(message) = attempt.failure_message {
        remove_output(output_path);
        return Outcome {
            success: false,
            output_path: output_path.to_string_lossy().into_owned(),
            error: Some(message),
            error_detail: None,
            retry_with_cpu_suggested: false,
        };
    }
    if attempt.code == Some(0) {
        return Outcome {
            success: true,
            output_path: output_path.to_string_lossy().into_owned(),
            error: None,
            error_detail: None,
            retry_with_cpu_suggested: false,
        };
    }
    // Keep the public leaf reserved across the software-decode retry; the next
    // attempt stages privately and promotes over our own claim.
    if !decode_args.is_empty() && ffmpeg_failure::should_retry_with_software_decode(&attempt.stderr)
    {
        reporter.log("Hardware decode failed; retrying with software decode.\n");
        attempt = run_ffmpeg(
            run,
            &args_without_decode(&args, decode_args.len()),
            output_path,
            total_duration,
            reporter,
        );
        if attempt.cancelled {
            remove_output(output_path);
            return cancelled_outcome(output_path);
        }
        if let Some(message) = attempt.failure_message {
            remove_output(output_path);
            return Outcome {
                success: false,
                output_path: output_path.to_string_lossy().into_owned(),
                error: Some(message),
                error_detail: None,
                retry_with_cpu_suggested: false,
            };
        }
        if attempt.code == Some(0) {
            return Outcome {
                success: true,
                output_path: output_path.to_string_lossy().into_owned(),
                error: None,
                error_detail: None,
                retry_with_cpu_suggested: false,
            };
        }
    }
    remove_output(output_path);
    Outcome {
        success: false,
        output_path: output_path.to_string_lossy().into_owned(),
        error: Some(ffmpeg_failure::describe(Some(&attempt.stderr))),
        error_detail: Some(ffmpeg_failure::detail(Some(&attempt.stderr))),
        retry_with_cpu_suggested: false,
    }
}

fn args_without_decode(args: &[String], decode_len: usize) -> Vec<String> {
    // `run_attempts` builds `-hide_banner -y -progress pipe:1`, then decode
    // options, then the preset argv.
    const PREFIX_LEN: usize = 4;
    let mut next = args[..PREFIX_LEN].to_vec();
    next.extend(args[PREFIX_LEN + decode_len..].iter().cloned());
    next
}

struct Attempt {
    code: Option<i32>,
    cancelled: bool,
    failure_message: Option<String>,
    stderr: String,
}

struct ProgressGate {
    last_emit: Option<Instant>,
    pending: Option<ConversionProgress>,
}

impl ProgressGate {
    fn new() -> Self {
        Self {
            last_emit: None,
            pending: None,
        }
    }

    fn offer(&mut self, progress: ConversionProgress) -> Option<ConversionProgress> {
        let now = Instant::now();
        let due = self
            .last_emit
            .map(|last| now.duration_since(last) >= PROGRESS_INTERVAL)
            .unwrap_or(true)
            || progress.percent >= 100.0;
        if due {
            self.last_emit = Some(now);
            self.pending = None;
            return Some(progress);
        }
        self.pending = Some(progress);
        None
    }

    fn due(&mut self) -> Option<ConversionProgress> {
        let pending = self.pending.as_ref()?;
        let last = self.last_emit?;
        if last.elapsed() < PROGRESS_INTERVAL && pending.percent < 100.0 {
            return None;
        }
        let progress = self.pending.take();
        self.last_emit = Some(Instant::now());
        progress
    }

    fn flush(&mut self) -> Option<ConversionProgress> {
        self.pending.take()
    }
}

struct AttemptShared {
    total_duration: f64,
    reporter: Reporter,
    stderr: Mutex<String>,
    gate: Mutex<ProgressGate>,
}

impl AttemptShared {
    fn new(total_duration: f64, reporter: Reporter) -> Self {
        Self {
            total_duration,
            reporter,
            stderr: Mutex::new(String::new()),
            gate: Mutex::new(ProgressGate::new()),
        }
    }

    fn offer(&self, progress: ConversionProgress) {
        let emit = self
            .gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .offer(progress);
        if let Some(progress) = emit {
            self.reporter.progress(progress);
        }
    }

    fn flush_due(&self) {
        let emit = self
            .gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .due();
        if let Some(progress) = emit {
            self.reporter.progress(progress);
        }
    }

    fn flush(&self) {
        let emit = self
            .gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .flush();
        if let Some(progress) = emit {
            self.reporter.progress(progress);
        }
    }

    fn append_stderr(&self, chunk: &str) {
        if let Ok(mut buffer) = self.stderr.lock() {
            ffmpeg_failure::append_bounded_error_output(&mut buffer, chunk);
        }
    }

    fn stderr(&self) -> String {
        self.stderr
            .lock()
            .map(|buffer| buffer.clone())
            .unwrap_or_default()
    }
}

fn pump_stdout(mut stream: std::process::ChildStdout, shared: Arc<AttemptShared>) {
    let mut chunk = [0u8; 16384];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
                shared.reporter.log(&text);
                for line in text.lines() {
                    if let Some((percent, seconds)) =
                        ffmpeg_progress::parse_out_time_ms(line, shared.total_duration)
                    {
                        shared.offer(ConversionProgress {
                            percent,
                            frame: 0,
                            fps: 0.0,
                            time: ffmpeg_progress::format_time(seconds),
                            bitrate: "N/A".to_string(),
                            speed: "N/A".to_string(),
                        });
                    }
                }
            }
        }
    }
}

fn pump_stderr(mut stream: std::process::ChildStderr, shared: Arc<AttemptShared>) {
    let mut chunk = [0u8; 16384];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
                shared.reporter.log(&text);
                shared.append_stderr(&text);
                for line in text.lines() {
                    if let Some(progress) =
                        ffmpeg_progress::parse_progress(line, shared.total_duration)
                    {
                        shared.offer(progress);
                    }
                }
            }
        }
    }
}

fn run_ffmpeg(
    run: u64,
    args: &[String],
    output_path: &Path,
    total_duration: f64,
    reporter: &Reporter,
) -> Attempt {
    if is_cancelled(run) {
        return Attempt {
            code: None,
            cancelled: true,
            failure_message: None,
            stderr: String::new(),
        };
    }
    let status = ffmpeg_status::current_status();
    if !status.ok {
        return Attempt {
            code: None,
            cancelled: false,
            failure_message: Some(ffmpeg_unavailable_message(&status)),
            stderr: String::new(),
        };
    }
    let Some(tools) = ffmpeg_status::effective_tools() else {
        let status = ffmpeg_status::current_status();
        return Attempt {
            code: None,
            cancelled: false,
            failure_message: Some(ffmpeg_unavailable_message(&status)),
            stderr: String::new(),
        };
    };
    if is_cancelled(run) {
        return Attempt {
            code: None,
            cancelled: true,
            failure_message: None,
            stderr: String::new(),
        };
    }
    // FFmpeg writes only into a private staging directory; the reserved public
    // leaf is replaced atomically after a verified success.
    let stage = match StagedOutput::create(output_path) {
        Ok(stage) => stage,
        Err(message) => {
            crate::logging::warn(&message);
            remove_output(output_path);
            return Attempt {
                code: None,
                cancelled: false,
                failure_message: Some(message),
                stderr: String::new(),
            };
        }
    };
    let staged_args = match replace_output_operand(args, stage.path()) {
        Some(args) => args,
        None => {
            remove_output(output_path);
            return Attempt {
                code: None,
                cancelled: false,
                failure_message: Some("Internal error: preset has no output.".to_string()),
                stderr: String::new(),
            };
        }
    };
    let mut command = process_util::command(&tools.ffmpeg, &staged_args, &[], true);
    let child = match process_util::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            crate::logging::warn(&format!("Failed to start FFmpeg: {error}"));
            remove_output(output_path);
            return Attempt {
                code: None,
                cancelled: false,
                failure_message: Some(format!("Could not start FFmpeg: {error}")),
                stderr: String::new(),
            };
        }
    };
    {
        let mut state = lock_state();
        if state.run != run || state.cancelled {
            drop(state);
            process_util::kill_tree(&child);
            return Attempt {
                code: None,
                cancelled: true,
                failure_message: None,
                stderr: String::new(),
            };
        }
        state.child = Some(Arc::clone(&child));
    }

    let shared = Arc::new(AttemptShared::new(total_duration, *reporter));
    let stdout_reader = child.take_stdout().map(|stream| {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || pump_stdout(stream, shared))
    });
    let stderr_reader = child.take_stderr().map(|stream| {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || pump_stderr(stream, shared))
    });

    let mut cancelled = false;
    let exit = loop {
        if !cancelled && is_cancelled(run) {
            cancelled = true;
            process_util::terminate_tree(&child);
        }
        match child.wait_timeout(Duration::from_millis(50)) {
            Ok(Some(status)) => break Some(status),
            Ok(None) => shared.flush_due(),
            Err(error) => {
                crate::logging::warn(&format!("FFmpeg wait failed: {error}"));
                break None;
            }
        }
    };
    if let Some(reader) = stdout_reader {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    shared.flush();
    {
        let mut state = lock_state();
        if state
            .child
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &child))
        {
            state.child = None;
        }
    }
    let code = exit.and_then(|status| status.code());
    let cancelled = cancelled || is_cancelled(run);
    let stderr = shared.stderr();
    if !cancelled && code == Some(0) {
        if let Err(message) = stage.promote(output_path) {
            crate::logging::warn(&message);
            return Attempt {
                code: None,
                cancelled: false,
                failure_message: Some(message),
                stderr,
            };
        }
    }
    Attempt {
        code,
        cancelled,
        failure_message: None,
        stderr,
    }
}

// ---------------------------------------------------------------------------
// Platform helpers.
// ---------------------------------------------------------------------------

fn is_dir_writable(dir: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
    }
    #[cfg(windows)]
    {
        let probe = dir.join(format!(".conv2-write-test-{}", std::process::id()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
        {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        dir.is_dir()
    }
}

fn free_bytes(dir: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
            return None;
        }
        Some(stats.f_bavail as u64 * stats.f_frsize as u64)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut available = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(available)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = dir;
        None
    }
}

fn warn_when_disk_space_is_low(input: &str, output_dir: &Path, reporter: &Reporter) {
    let Ok(input_size) = std::fs::metadata(input).map(|meta| meta.len()) else {
        return;
    };
    let Some(available) = free_bytes(output_dir) else {
        return;
    };
    if available < input_size {
        reporter.log(&format!(
            "Warning: Low disk space - available: {} MB, input size: {} MB\n",
            available / 1024 / 1024,
            input_size / 1024 / 1024
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_validation_rejects_and_claims_the_slot() {
        let mut payload = StartConversionQueuePayload {
            input_paths: vec!["/tmp/a.mp4".to_string(), String::new()],
            preset_id: "h264-fast".to_string(),
            gpu: GpuVendor::Cpu,
            remove_spaces_from_filenames: None,
            output_directory: None,
            show_debug_output: None,
        };
        match validate_and_claim(&payload) {
            Validation::Run(request) => {
                assert_eq!(request.input_paths, vec!["/tmp/a.mp4".to_string()]);
            }
            Validation::Reject(_) => panic!("expected a run"),
        }
        // A second request while the first holds the slot is rejected as busy.
        match validate_and_claim(&payload) {
            Validation::Reject(snapshot) => {
                assert_eq!(
                    snapshot.items[0].error.as_deref(),
                    Some("Another conversion is already in progress")
                );
            }
            Validation::Run(_) => panic!("expected busy rejection"),
        }
        {
            let mut state = lock_state();
            state.active = false;
        }
        payload.preset_id = "nope".to_string();
        match validate_and_claim(&payload) {
            Validation::Reject(snapshot) => {
                assert_eq!(snapshot.preset_id, "nope");
                assert_eq!(
                    snapshot.items[0].error.as_deref(),
                    Some("Invalid preset selected")
                );
            }
            Validation::Run(_) => panic!("expected preset rejection"),
        }
        payload.preset_id = "h264-fast".to_string();
        payload.input_paths = Vec::new();
        match validate_and_claim(&payload) {
            Validation::Reject(snapshot) => assert_eq!(snapshot.total, 0),
            Validation::Run(_) => panic!("expected empty rejection"),
        }
    }

    #[test]
    fn progress_gate_throttles_and_keeps_the_last_value() {
        let mut gate = ProgressGate::new();
        let progress = |percent: f64| ConversionProgress {
            percent,
            frame: 0,
            fps: 0.0,
            time: "00:00:00".to_string(),
            bitrate: "N/A".to_string(),
            speed: "N/A".to_string(),
        };
        assert_eq!(gate.offer(progress(10.0)).map(|p| p.percent), Some(10.0));
        assert!(gate.offer(progress(20.0)).is_none());
        assert!(gate.offer(progress(30.0)).is_none());
        assert!(gate.due().is_none());
        std::thread::sleep(PROGRESS_INTERVAL + Duration::from_millis(10));
        assert_eq!(gate.due().map(|p| p.percent), Some(30.0));
        assert!(gate.flush().is_none());
        assert_eq!(gate.offer(progress(100.0)).map(|p| p.percent), Some(100.0));
    }

    #[test]
    fn decode_args_are_spliced_out_for_the_retry() {
        let args: Vec<String> = [
            "-hide_banner",
            "-y",
            "-progress",
            "pipe:1",
            "-hwaccel",
            "cuda",
            "-i",
            "in",
            "out",
        ]
        .map(str::to_string)
        .to_vec();
        assert_eq!(
            args_without_decode(&args, 2),
            [
                "-hide_banner",
                "-y",
                "-progress",
                "pipe:1",
                "-i",
                "in",
                "out"
            ]
            .map(str::to_string)
            .to_vec()
        );
    }
}
