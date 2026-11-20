//! Update engine: channel resolution, feed checks, downloads, installs, and
//! the `update-state` events the renderer renders (v1 updater.ts semantics).
//! One state thread owns every decision and emit; workers only ask
//! (`request`) and report (`submit`), and never block it on I/O.
//!
//! Failure modes, written before the code:
//! 1. A feed answer after a channel switch: discard it, queue a silent recheck.
//! 2. Download bytes race a channel switch: the epoch fence drops them.
//! 3. Two checks at once: single-flight; manual re-entry reports
//!    `already-checking`, silent re-entry stays quiet.
//! 4. Two downloads: refused while one runs. Cancel discards the result.
//! 5. The beta feed has nothing newer on a prerelease: recheck stable once.
//! 6. settings.json missing or corrupt: channel `auto`, auto-check on.
//! 7. Store, CONV2_DISABLE_UPDATES, or dev builds never hit the feed; Flatpak
//!    refuses download and install with a manual-reinstall notice.
//! 8. Conversions running at install: INTERNAL_ERROR plus a manual
//!    `update-state` notice; the download stays installable once they finish.
//! 9. Install fails: keep the download; a retry restarts without reinstalling.
//! 10. A feed or download error never clobbers a downloaded update.
//! 11. A check is refused (quietly) while a live download or install runs.
//! 12. A fenced download result touches nothing: the channel switch already
//!     cleared its offer, and a newer offer may exist.

use crate::app_state;
use crate::constants;
use crate::ipc::{self, FalliblePayload, IpcResult, INTERNAL_ERROR, VALIDATION_ERROR};
use crate::types::{UpdateChannel, UpdatePhase, UpdateStatePayload};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
// Bundles carry FFmpeg and ffprobe, so slow connections must finish.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
// v1 fired the silent check 3 s after the window was ready to show.
const SILENT_CHECK_DELAY: Duration = Duration::from_secs(3);
const MAIN_READY_POLL: Duration = Duration::from_millis(200);
const MAIN_READY_TIMEOUT: Duration = Duration::from_secs(120);
const COMPACT_TARGET_SUFFIX: &str = "-app-zst";

const CHECKING_MESSAGE: &str = "Checking for updates...";
const ALREADY_CHECKING_MESSAGE: &str = "Update check already in progress.";
const LATEST_MESSAGE: &str = "You have the latest version.";
const DOWNLOADING_MESSAGE: &str = "Downloading update...";
const INSTALLING_MESSAGE: &str = "Restarting to install update...";
const NO_DOWNLOADED_UPDATE: &str = "No downloaded update is ready to install.";
const NO_UPDATE_TO_DOWNLOAD: &str = "No update is available to download.";
const CANCELLED_MESSAGE: &str = "Update download cancelled.";
const DOWNLOAD_ACTIVE_MESSAGE: &str = "An update download is already in progress.";
const DOWNLOAD_STOPPING_MESSAGE: &str =
    "The previous update download is still stopping. Try again when it finishes.";
const INSTALL_ACTIVE_MESSAGE: &str = "This update is already being installed.";
const DISABLED_MESSAGE: &str = "Auto-updates are disabled for this installation.";
const CHANNEL_CHANGED_MESSAGE: &str = "Update channel changed.";
const CHANNEL_WRITE_PENDING_MESSAGE: &str =
    "An update channel change is in progress. Try again when it finishes.";
const CHANNEL_NOT_SAVED: &str =
    "The selected update channel could not be saved before revalidation.";
const DEV_MODE_MESSAGE: &str = "Update checking is not available in development mode.";
const BUSY_CONVERSIONS_MESSAGE: &str = "conversions still running";
const BUSY_INSTALL_NOTICE: &str =
    "Finish or cancel the running conversions, then install the update.";
const FLATPAK_NOTICE: &str =
    "Flatpak builds cannot update in the app. Reinstall the latest version from the release page manually.";
const FLATPAK_REFUSAL: &str =
    "Flatpak builds cannot download or install updates in the app. Install the latest version from the release page manually.";

// ── v1 policy port (updaterPolicy.ts) ─────────────────────────────────────

/// Cut `+build` metadata, as v1's stripBuildMetadata.
fn strip_build_metadata(version: &str) -> &str {
    match version.find('+') {
        Some(index) => &version[..index],
        None => version,
    }
}

/// The first `-(beta|alpha|rc)(.N)?` marker (v1 PRERELEASE_PATTERN): its
/// position, tag, and number.
fn prerelease_marker(version: &str) -> Option<(usize, &'static str, u64)> {
    let stripped = strip_build_metadata(version);
    let lower = stripped.to_ascii_lowercase();
    for (index, byte) in lower.bytes().enumerate() {
        if byte != b'-' {
            continue;
        }
        let rest = &lower[index + 1..];
        let tag = if rest.starts_with("beta") {
            "beta"
        } else if rest.starts_with("alpha") {
            "alpha"
        } else if rest.starts_with("rc") {
            "rc"
        } else {
            continue;
        };
        let after = &rest[tag.len()..];
        let number = after.strip_prefix('.').map_or(0, |digits| {
            let end = digits
                .bytes()
                .position(|byte| !byte.is_ascii_digit())
                .unwrap_or(digits.len());
            if end == 0 {
                0
            } else {
                digits[..end].parse().unwrap_or(0)
            }
        });
        return Some((index, tag, number));
    }
    None
}

/// v1 getBaseVersion: the numeric parts before the prerelease marker.
fn base_parts(version: &str) -> [f64; 3] {
    let stripped = strip_build_metadata(version);
    let base = match prerelease_marker(version) {
        Some((index, _, _)) => &stripped[..index],
        None => stripped,
    };
    let mut parts = [0.0; 3];
    for (slot, part) in base.split('.').take(3).enumerate() {
        parts[slot] = numeric_part(part);
    }
    parts
}

/// JS Number(): empty or malformed parts read as 0, never as NaN or infinity.
fn numeric_part(part: &str) -> f64 {
    match part.trim().parse::<f64>() {
        Ok(value) if value.is_finite() => value,
        _ => 0.0,
    }
}

fn prerelease_order(tag: &str) -> u32 {
    match tag {
        "alpha" => 1,
        "beta" => 2,
        "rc" => 3,
        _ => 0,
    }
}

/// v1 compareVersions: higher base wins; same base, stable beats prerelease;
/// same tag, higher number wins.
fn compare_versions(left: &str, right: &str) -> i32 {
    let left_base = base_parts(left);
    let right_base = base_parts(right);
    for slot in 0..3 {
        if left_base[slot] > right_base[slot] {
            return 1;
        }
        if left_base[slot] < right_base[slot] {
            return -1;
        }
    }
    match (prerelease_marker(left), prerelease_marker(right)) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some((_, left_tag, left_number)), Some((_, right_tag, right_number))) => {
            let left_order = prerelease_order(left_tag);
            let right_order = prerelease_order(right_tag);
            if left_order != right_order {
                return if left_order > right_order { 1 } else { -1 };
            }
            if left_number != right_number {
                return if left_number > right_number { 1 } else { -1 };
            }
            0
        }
    }
}

/// v1 shouldAcceptUpdate: only strictly newer versions, so channel switches
/// can never select a downgrade.
fn should_accept_update(offered: &str, current: &str) -> bool {
    compare_versions(offered, current) > 0
}

fn is_prerelease_version(version: &str) -> bool {
    prerelease_marker(version).is_some()
}

/// v1 shouldUseBetaChannel: beta resolves to the beta feed, stable to the
/// stable feed, auto to beta iff the running version is a prerelease.
fn resolved_beta_feed(channel: UpdateChannel, current_version: &str) -> bool {
    match channel {
        UpdateChannel::Beta => true,
        UpdateChannel::Stable => false,
        UpdateChannel::Auto => is_prerelease_version(current_version),
    }
}

// ── state thread ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckMode {
    Manual,
    Silent,
}

/// Which feed a check used; the fallback moves from Beta to Stable.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FeedPhase {
    Beta,
    Stable,
}

/// Platform gate answers, computed by the caller so the machine stays testable.
#[derive(Clone, Copy)]
struct Gates {
    disabled: bool,
    packaged: bool,
    flatpak: bool,
}

struct ActiveCheck {
    generation: u64,
    mode: CheckMode,
    /// The beta feed already rechecked the stable feed once.
    fallback_used: bool,
    /// The channel moved under this check; its reports are dropped.
    discard: bool,
}

struct ActiveDownload {
    version: String,
    /// The channel and epoch the download started under; a switch invalidates
    /// both.
    channel: UpdateChannel,
    epoch: u64,
    cancelled: bool,
    started_at: Instant,
    last_emit: Option<Instant>,
}

/// Plugin objects the scalar machine must not carry. Owned by the state
/// thread, beside `State`, so `State` stays constructible in tests.
#[derive(Default)]
struct Candidates {
    /// Mirrors `State.offer`.
    offer: Option<Update>,
    /// Mirrors `State.downloaded`.
    downloaded: Option<DownloadedCandidate>,
}

struct DownloadedCandidate {
    update: Update,
    bytes: Arc<Vec<u8>>,
    /// The channel and epoch this fetch belonged to.
    channel: UpdateChannel,
    epoch: u64,
}

enum FeedOutcome {
    Offered {
        version: String,
        update: Box<Update>,
    },
    NoneNewer,
    Failed(String),
    /// The settings channel moved without set_update_channel.
    ChannelMoved,
}

enum FeedDecision {
    Done,
    /// One fallback tick: the worker rechecks the stable feed.
    FallbackStable,
    Stale,
}

enum CheckStart {
    Started(u64),
    /// The engine emitted any refusal payload; the worker stops.
    Terminal,
}

enum DownloadGate {
    Start { epoch: u64 },
    Terminal,
}

enum FinishOutcome {
    Accepted,
    Fenced,
    Cancelled,
    Failed,
}

enum InstallGate {
    Proceed {
        version: String,
        /// Install already ran once; the retry only restarts.
        already_installed: bool,
    },
    Terminal,
}

enum InstallOutcome {
    Failed(String),
    Restarted,
}

#[allow(clippy::large_enum_variant)] // one-shot channel messages
enum Command {
    BeginCheck {
        mode: CheckMode,
        reply: Sender<CheckStart>,
    },
    ReportFeed {
        generation: u64,
        phase: FeedPhase,
        outcome: FeedOutcome,
        reply: Sender<FeedDecision>,
    },
    BeginDownload {
        reply: Sender<DownloadStartReply>,
    },
    DownloadProgress {
        transferred: u64,
        total: u64,
    },
    FinishDownload {
        result: Result<(Vec<u8>, Update), String>,
        epoch: u64,
        reply: Sender<()>,
    },
    CancelDownload,
    /// Conversions blocked an install; tell the renderer.
    InstallBusy {
        reply: Sender<()>,
    },
    ReserveChannelWrite {
        reply: Sender<bool>,
    },
    ReleaseChannelWrite,
    ChannelChanged {
        channel: UpdateChannel,
        /// The channel on disk before this transaction persisted.
        previous: UpdateChannel,
        saved: Result<(), String>,
        reply: Sender<()>,
    },
    BeginInstall {
        reply: Sender<InstallStartReply>,
    },
    ConfirmInstall {
        version: String,
        reply: Sender<bool>,
    },
    InstallWritten {
        version: String,
        reply: Sender<bool>,
    },
    FinishInstall {
        version: String,
        outcome: InstallOutcome,
        reply: Sender<()>,
    },
    CurrentState {
        reply: Sender<UpdateStatePayload>,
    },
}

fn idle_payload() -> UpdateStatePayload {
    UpdateStatePayload {
        phase: UpdatePhase::NotAvailable,
        manual: false,
        message: None,
        percent: None,
    }
}

/// The scalar half of v1's updateMachine: every phase decision and emit.
struct State {
    /// Bumped only by channel switches; fences download results (v1 epoch).
    epoch: u64,
    /// Bumped by every check start; identifies the running check worker.
    checks: u64,
    check: Option<ActiveCheck>,
    recheck_queued: bool,
    /// Offered version; the plugin object lives in `Candidates`.
    offer: Option<String>,
    download: Option<ActiveDownload>,
    /// Downloaded version, installable.
    downloaded: Option<String>,
    /// Version whose install already ran; restart retries use it.
    installed: Option<String>,
    installing: bool,
    /// BeginInstall returned an update; the reserved install worker will
    /// confirm next.
    install_pending: bool,
    /// A channel write holds the engine until its persistence and
    /// ChannelChanged transition complete.
    channel_reserved: bool,
    /// A recheck must start after the in-flight channel write releases.
    recheck_pending: bool,
    known_channel: Option<UpdateChannel>,
    channel_unsaved: bool,
    flatpak: bool,
    last: UpdateStatePayload,
}

impl Default for State {
    fn default() -> Self {
        Self {
            epoch: 0,
            checks: 0,
            check: None,
            recheck_queued: false,
            offer: None,
            download: None,
            downloaded: None,
            installed: None,
            installing: false,
            install_pending: false,
            channel_reserved: false,
            recheck_pending: false,
            known_channel: None,
            channel_unsaved: false,
            flatpak: false,
            last: idle_payload(),
        }
    }
}

impl State {
    /// A download (not fenced or cancelled) or an install is in flight.
    /// A fenced (old-epoch) download does not block a recheck.
    fn busy(&self) -> bool {
        let live_download = self
            .download
            .as_ref()
            .is_some_and(|active| !active.cancelled && active.epoch == self.epoch);
        self.installing || self.install_pending || live_download
    }

    /// Tell the app menu whether Install Update is available and whether
    /// Check for Updates is blocked by a live download/install, then refresh.
    fn sync_menu(&self) {
        crate::app_menu::set_update_ready(self.downloaded.is_some() && !self.installing);
        crate::app_menu::set_update_busy(self.busy());
        crate::app_menu::refresh();
    }

    /// Every emit updates the engine's current state so each command can
    /// answer with the payload the renderer last saw.
    fn send(&mut self, phase: UpdatePhase, manual: bool, message: impl Into<String>) {
        let payload = UpdateStatePayload {
            phase,
            manual,
            message: Some(message.into()),
            percent: None,
        };
        self.last = payload.clone();
        app_state::emit("update-state", payload);
    }

    fn send_downloaded(&mut self, version: &str) {
        self.send(
            UpdatePhase::Downloaded,
            false,
            format!("Version {version} downloaded."),
        );
    }

    /// v1 endCheck: close the check; a queued recheck runs as a silent check.
    /// Returns whether the caller should spawn it.
    fn end_check(&mut self) -> bool {
        self.check = None;
        if self.recheck_queued {
            self.recheck_queued = false;
            return true;
        }
        false
    }

    /// v1 startCheck behind the single-flight rule. Gates are supplied by the
    /// caller; disabled and dev builds refuse without touching the feed.
    fn begin_check(&mut self, mode: CheckMode, gates: Gates) -> CheckStart {
        let manual = mode == CheckMode::Manual;
        if gates.disabled {
            if manual {
                self.send(UpdatePhase::Disabled, true, DISABLED_MESSAGE);
            }
            return CheckStart::Terminal;
        }
        if let Some(_active) = &self.check {
            if manual {
                self.send(UpdatePhase::AlreadyChecking, true, ALREADY_CHECKING_MESSAGE);
            }
            return CheckStart::Terminal;
        }
        // Quiet refusal: any emit would overwrite the download/install phase.
        // The disabled menu item is the feedback.
        if self.busy() {
            return CheckStart::Terminal;
        }
        if self.channel_reserved {
            if manual {
                self.send(UpdatePhase::Error, true, CHANNEL_WRITE_PENDING_MESSAGE);
            } else {
                self.recheck_pending = true;
            }
            return CheckStart::Terminal;
        }
        if self.channel_unsaved {
            if manual {
                self.send(UpdatePhase::Error, true, CHANNEL_NOT_SAVED);
            }
            return CheckStart::Terminal;
        }
        if !gates.packaged {
            if manual {
                self.send(UpdatePhase::Error, true, DEV_MODE_MESSAGE);
            }
            return CheckStart::Terminal;
        }
        self.flatpak = gates.flatpak;
        self.checks += 1;
        let generation = self.checks;
        self.check = Some(ActiveCheck {
            generation,
            mode,
            fallback_used: false,
            discard: false,
        });
        // v1 kept a downloaded update visible instead of re-notifying.
        if self.downloaded.is_none() {
            self.send(UpdatePhase::Checking, manual, CHECKING_MESSAGE);
        }
        CheckStart::Started(generation)
    }

    /// Decide one feed answer: report it, or run the stable fallback once.
    fn report_feed(
        &mut self,
        candidates: &mut Candidates,
        generation: u64,
        phase: FeedPhase,
        outcome: FeedOutcome,
    ) -> (FeedDecision, bool) {
        let Some(active) = self.check.as_ref() else {
            return (FeedDecision::Stale, false);
        };
        if active.generation != generation {
            return (FeedDecision::Stale, false);
        }
        if active.discard {
            // The channel moved under this check; drop the answer and recheck.
            return (FeedDecision::Stale, self.end_check());
        }
        let manual = active.mode == CheckMode::Manual;
        let allow_fallback = phase == FeedPhase::Beta && !active.fallback_used;
        match outcome {
            FeedOutcome::ChannelMoved => (FeedDecision::Stale, self.end_check()),
            FeedOutcome::Offered { version, update } => {
                if self.downloaded.as_deref() == Some(version.as_str()) {
                    self.send_downloaded(&version);
                    return (FeedDecision::Done, self.end_check());
                }
                // A newer version replaces a stale download (v1 menu-changed).
                if self.downloaded.take().is_some() {
                    candidates.downloaded = None;
                    self.sync_menu();
                }
                let message = if self.flatpak {
                    format!("Version {version} is available. {FLATPAK_NOTICE}")
                } else {
                    format!("Update available: {version}")
                };
                self.offer = Some(version);
                candidates.offer = Some(*update);
                self.send(UpdatePhase::Available, manual, message);
                (FeedDecision::Done, self.end_check())
            }
            FeedOutcome::NoneNewer => {
                if allow_fallback {
                    if let Some(active) = self.check.as_mut() {
                        active.fallback_used = true;
                    }
                    if self.downloaded.is_none() {
                        self.send(UpdatePhase::Checking, manual, CHECKING_MESSAGE);
                    }
                    return (FeedDecision::FallbackStable, false);
                }
                self.offer = None;
                candidates.offer = None;
                if let Some(version) = self.downloaded.clone() {
                    self.send_downloaded(&version);
                } else {
                    self.send(UpdatePhase::NotAvailable, manual, LATEST_MESSAGE);
                }
                (FeedDecision::Done, self.end_check())
            }
            FeedOutcome::Failed(message) => {
                // v1 reportError: a downloaded update stays the visible state.
                if let Some(version) = self.downloaded.clone() {
                    self.send_downloaded(&version);
                } else {
                    self.send(
                        UpdatePhase::Error,
                        manual,
                        format!("Update error: {message}"),
                    );
                }
                (FeedDecision::Done, self.end_check())
            }
        }
    }

    /// v1 'download': needs the offer, single-flight, epoch recorded.
    fn begin_download(&mut self) -> DownloadGate {
        if self.flatpak {
            self.send(UpdatePhase::Error, true, FLATPAK_REFUSAL);
            return DownloadGate::Terminal;
        }
        if self.channel_reserved {
            self.send(UpdatePhase::Error, true, CHANNEL_WRITE_PENDING_MESSAGE);
            return DownloadGate::Terminal;
        }
        let Some(version) = self.offer.clone() else {
            self.send(UpdatePhase::Error, true, NO_UPDATE_TO_DOWNLOAD);
            if let Some(downloaded) = self.downloaded.clone() {
                self.send_downloaded(&downloaded);
            }
            return DownloadGate::Terminal;
        };
        if let Some(active) = self.download.as_ref() {
            let message = if active.cancelled {
                DOWNLOAD_STOPPING_MESSAGE
            } else {
                DOWNLOAD_ACTIVE_MESSAGE
            };
            self.send(UpdatePhase::Error, true, message);
            return DownloadGate::Terminal;
        }
        if self.installing || self.install_pending {
            self.send(UpdatePhase::Error, true, INSTALL_ACTIVE_MESSAGE);
            return DownloadGate::Terminal;
        }
        let epoch = self.epoch;
        self.download = Some(ActiveDownload {
            version,
            channel: read_settings().0,
            epoch,
            cancelled: false,
            started_at: Instant::now(),
            last_emit: None,
        });
        self.sync_menu();
        // v1 sent the downloading phase with manual hard-set to true.
        self.send(UpdatePhase::Downloading, true, DOWNLOADING_MESSAGE);
        DownloadGate::Start { epoch }
    }

    /// Throttled progress emits with v1's speed and size message.
    fn download_progress(&mut self, transferred: u64, total: u64) {
        let Some(active) = self.download.as_mut() else {
            return;
        };
        if active.cancelled {
            return;
        }
        let now = Instant::now();
        if active
            .last_emit
            .is_some_and(|last| now.duration_since(last) < PROGRESS_EMIT_INTERVAL)
        {
            return;
        }
        active.last_emit = Some(now);
        let started_at = active.started_at;
        let percent = if total > 0 {
            (transferred as f64 / total as f64 * 100.0).min(100.0)
        } else {
            0.0
        };
        let elapsed = now.duration_since(started_at).as_secs_f64().max(0.001);
        let message = format!(
            "Download speed: {}/s - {}% ({}/{})",
            format_bytes(transferred as f64 / elapsed),
            percent.round() as u64,
            format_bytes(transferred as f64),
            format_bytes(total as f64),
        );
        let payload = UpdateStatePayload {
            phase: UpdatePhase::Downloading,
            manual: false,
            message: Some(message),
            percent: Some(percent),
        };
        self.last = payload.clone();
        app_state::emit("update-state", payload);
    }

    /// Decide a finished transfer. The epoch fence drops bytes that raced a
    /// channel switch (v1 'downloaded' with a stale downloadEpoch).
    fn finish_download(
        &mut self,
        candidates: &mut Candidates,
        result: Result<(Vec<u8>, Update), String>,
        _epoch: u64,
    ) -> FinishOutcome {
        let Some(active) = self.download.take() else {
            return FinishOutcome::Cancelled;
        };
        self.sync_menu();
        if active.cancelled {
            return FinishOutcome::Cancelled;
        }
        // channel_changed already cleared the old offer; a newer one may exist.
        if active.epoch != self.epoch {
            return FinishOutcome::Fenced;
        }
        match result {
            Err(message) => {
                if let Some(version) = self.downloaded.clone() {
                    self.send_downloaded(&version);
                } else {
                    self.send(UpdatePhase::Error, true, format!("Update error: {message}"));
                }
                FinishOutcome::Failed
            }
            Ok((bytes, update)) => {
                self.offer = None;
                candidates.offer = None;
                self.downloaded = Some(active.version.clone());
                candidates.downloaded = Some(DownloadedCandidate {
                    update,
                    bytes: Arc::new(bytes),
                    channel: active.channel,
                    epoch: active.epoch,
                });
                self.sync_menu();
                self.send_downloaded(&active.version);
                FinishOutcome::Accepted
            }
        }
    }

    /// The plugin cannot abort a transfer; the result is swallowed instead.
    fn cancel_download(&mut self) {
        let Some(active) = self.download.as_mut() else {
            return;
        };
        if active.cancelled {
            return;
        }
        active.cancelled = true;
        self.sync_menu();
        self.send(UpdatePhase::NotAvailable, true, CANCELLED_MESSAGE);
    }

    /// Conversions blocked an install: keep the current phase, add a notice.
    fn install_busy(&mut self) {
        if self.installing || self.install_pending {
            return;
        }
        if self.downloaded.is_some() {
            self.send(UpdatePhase::Downloaded, true, BUSY_INSTALL_NOTICE);
        } else {
            self.send(UpdatePhase::Error, true, NO_DOWNLOADED_UPDATE);
        }
    }

    /// v1 channel-changed: bump the epoch, drop the offer and any downloaded
    /// update, fence the in-flight check, and revalidate. Returns whether a
    /// silent recheck should start once the write reservation releases.
    fn channel_changed(
        &mut self,
        candidates: &mut Candidates,
        channel: UpdateChannel,
        previous: UpdateChannel,
        saved: Result<(), String>,
    ) -> bool {
        let was_unsaved = self.channel_unsaved;
        self.channel_unsaved = saved.is_err();
        // Persistence already ran, so the first transition compares against
        // the channel the caller read before writing.
        let changed = match self.known_channel {
            Some(known) => known != channel,
            None => previous != channel,
        };
        self.known_channel = Some(channel);
        if !changed {
            // A retry that only completes a failed save must not invalidate a
            // download fetched while the channel was unsaved.
            return was_unsaved && saved.is_ok() && self.check.is_none();
        }
        self.epoch += 1;
        self.offer = None;
        candidates.offer = None;
        if self.downloaded.take().is_some() {
            candidates.downloaded = None;
        }
        // The epoch bump fences any in-flight download, so busy may change.
        self.sync_menu();
        self.send(UpdatePhase::NotAvailable, false, CHANNEL_CHANGED_MESSAGE);
        if self.check.is_some() {
            if let Some(active) = self.check.as_mut() {
                active.discard = true;
            }
            self.recheck_queued = true;
            return false;
        }
        true
    }

    /// v1 'install': needs the downloaded update; the busy gate runs between
    /// this and confirm_install so a refusal leaves no state behind.
    fn begin_install(
        &mut self,
        candidates: &mut Candidates,
        channel: UpdateChannel,
    ) -> InstallGate {
        if self.flatpak {
            self.send(UpdatePhase::Error, true, FLATPAK_REFUSAL);
            return InstallGate::Terminal;
        }
        if self.channel_reserved {
            self.send(UpdatePhase::Error, true, CHANNEL_WRITE_PENDING_MESSAGE);
            return InstallGate::Terminal;
        }
        if self.installing || self.install_pending {
            return InstallGate::Terminal;
        }
        let Some(version) = self.downloaded.clone() else {
            self.send(UpdatePhase::Error, true, NO_DOWNLOADED_UPDATE);
            return InstallGate::Terminal;
        };
        if !self.candidate_matches(candidates, &version, channel) {
            self.discard_download(candidates);
            self.send(UpdatePhase::Error, true, NO_DOWNLOADED_UPDATE);
            return InstallGate::Terminal;
        }
        InstallGate::Proceed {
            already_installed: self.installed.as_deref() == Some(version.as_str()),
            version,
        }
    }

    /// A candidate belongs to the channel and epoch it was fetched under.
    fn candidate_matches(
        &self,
        candidates: &Candidates,
        version: &str,
        channel: UpdateChannel,
    ) -> bool {
        candidates.downloaded.as_ref().is_some_and(|candidate| {
            candidate.channel == channel
                && candidate.epoch == self.epoch
                && candidate.update.version == version
        })
    }

    /// Clear a candidate that no longer matches the current channel/epoch.
    fn discard_download(&mut self, candidates: &mut Candidates) {
        let had_downloaded = self.downloaded.take().is_some();
        let had_candidate = candidates.downloaded.take().is_some();
        self.installed = None;
        if had_downloaded || had_candidate {
            self.sync_menu();
        }
    }

    /// Lock the install in and announce it. Pure so the busy gate can sit
    /// between begin and confirm without leaving installing state behind.
    fn confirm_install(
        &mut self,
        candidates: &mut Candidates,
        version: &str,
        channel: UpdateChannel,
    ) -> bool {
        if self.channel_reserved {
            self.install_pending = false;
            self.sync_menu();
            self.send(UpdatePhase::Error, true, CHANNEL_WRITE_PENDING_MESSAGE);
            return false;
        }
        let matches = self.candidate_matches(candidates, version, channel);
        if !matches {
            self.install_pending = false;
            self.discard_download(candidates);
            self.sync_menu();
            self.send(UpdatePhase::Error, true, NO_DOWNLOADED_UPDATE);
            return false;
        }
        self.install_pending = false;
        self.installing = true;
        self.sync_menu();
        self.send(UpdatePhase::Installing, true, INSTALLING_MESSAGE);
        true
    }

    /// Record that the install step ran, so a refused restart retries as a
    /// restart only.
    fn install_written(&mut self, version: &str) -> bool {
        if self.downloaded.as_deref() != Some(version) {
            return false;
        }
        self.installed = Some(version.to_owned());
        true
    }

    /// v1 install-failed keeps the download; a completed restart clears it.
    fn finish_install(
        &mut self,
        candidates: &mut Candidates,
        version: &str,
        outcome: InstallOutcome,
    ) {
        match outcome {
            InstallOutcome::Failed(message) => {
                if self.downloaded.as_deref() == Some(version) {
                    self.send(UpdatePhase::Error, true, format!("Update error: {message}"));
                }
            }
            InstallOutcome::Restarted => {
                if self.downloaded.as_deref() == Some(version) {
                    self.downloaded = None;
                    candidates.downloaded = None;
                    self.installed = None;
                }
            }
        }
        self.installing = false;
        self.install_pending = false;
        self.sync_menu();
    }

    /// Route one command. Returns whether a silent recheck should spawn.
    fn handle(&mut self, candidates: &mut Candidates, command: Command) -> bool {
        match command {
            Command::BeginCheck { mode, reply } => {
                let _ = reply.send(self.begin_check(mode, current_gates()));
            }
            Command::ReportFeed {
                generation,
                phase,
                outcome,
                reply,
            } => {
                let (decision, spawn_recheck) =
                    self.report_feed(candidates, generation, phase, outcome);
                let _ = reply.send(decision);
                if spawn_recheck {
                    return true;
                }
            }
            Command::BeginDownload { reply } => {
                let gate = self.begin_download();
                let started = match &gate {
                    DownloadGate::Start { .. } => candidates.offer.clone(),
                    DownloadGate::Terminal => None,
                };
                let reply_value = match (gate, started) {
                    (DownloadGate::Start { epoch }, Some(update)) => {
                        DownloadStartReply::Start { epoch, update }
                    }
                    _ => DownloadStartReply::Terminal,
                };
                let _ = reply.send(reply_value);
            }
            Command::DownloadProgress { transferred, total } => {
                self.download_progress(transferred, total);
            }
            Command::FinishDownload {
                result,
                epoch,
                reply,
            } => {
                let _ = self.finish_download(candidates, result, epoch);
                let _ = reply.send(());
            }
            Command::CancelDownload => self.cancel_download(),
            Command::InstallBusy { reply } => {
                self.install_busy();
                let _ = reply.send(());
            }
            Command::ReserveChannelWrite { reply } => {
                let granted = !self.installing && !self.install_pending && !self.channel_reserved;
                if granted {
                    self.channel_reserved = true;
                }
                let _ = reply.send(granted);
            }
            Command::ReleaseChannelWrite => {
                self.channel_reserved = false;
                if self.recheck_pending {
                    self.recheck_pending = false;
                    return true;
                }
            }
            Command::ChannelChanged {
                channel,
                previous,
                saved,
                reply,
            } => {
                if self.channel_changed(candidates, channel, previous, saved) {
                    self.recheck_pending = true;
                }
                let _ = reply.send(());
            }
            Command::BeginInstall { reply } => {
                let channel = read_settings().0;
                let reply_value = match self.begin_install(candidates, channel) {
                    InstallGate::Proceed {
                        version,
                        already_installed,
                    } => {
                        // begin_install already verified the candidate.
                        match candidates.downloaded.as_ref() {
                            Some(downloaded) => {
                                self.install_pending = true;
                                self.sync_menu();
                                InstallStartReply::Proceed {
                                    version,
                                    update: downloaded.update.clone(),
                                    bytes: downloaded.bytes.clone(),
                                    already_installed,
                                }
                            }
                            None => InstallStartReply::Terminal,
                        }
                    }
                    InstallGate::Terminal => InstallStartReply::Terminal,
                };
                let _ = reply.send(reply_value);
            }
            Command::ConfirmInstall { version, reply } => {
                let channel = read_settings().0;
                let _ = reply.send(self.confirm_install(candidates, &version, channel));
            }
            Command::InstallWritten { version, reply } => {
                let _ = reply.send(self.install_written(&version));
            }
            Command::FinishInstall {
                version,
                outcome,
                reply,
            } => {
                self.finish_install(candidates, &version, outcome);
                let _ = reply.send(());
            }
            Command::CurrentState { reply } => {
                let _ = reply.send(self.last.clone());
            }
        }
        false
    }
}

/// What the download worker receives: the plugin object plus its epoch.
#[allow(clippy::large_enum_variant)]
enum DownloadStartReply {
    Start { epoch: u64, update: Update },
    Terminal,
}

/// What the install worker receives: the plugin object plus its bytes.
#[allow(clippy::large_enum_variant)]
enum InstallStartReply {
    Proceed {
        version: String,
        update: Update,
        bytes: Arc<Vec<u8>>,
        already_installed: bool,
    },
    Terminal,
}

fn current_gates() -> Gates {
    Gates {
        disabled: updates_disabled(),
        packaged: e2e_override(|config| config.is_packaged).unwrap_or_else(is_packaged),
        flatpak: e2e_override(|config| config.is_flatpak).unwrap_or_else(flatpak_build),
    }
}

/// Start the engine channel at launch so the startup watcher and its silent
/// check exist before any updater command runs.
pub fn init_engine() {
    let _ = engine();
}

fn engine() -> &'static Sender<Command> {
    static ENGINE: OnceLock<Sender<Command>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let (sender, receiver) = channel();
        std::thread::spawn(move || {
            let mut state = State::default();
            let mut candidates = Candidates::default();
            for command in receiver {
                if state.handle(&mut candidates, command) {
                    std::thread::spawn(|| run_check(CheckMode::Silent));
                }
            }
        });
        spawn_startup_watcher();
        sender
    })
}

/// Send a command and wait for its reply. Never call this from the state thread.
fn request<T>(build: impl FnOnce(Sender<T>) -> Command) -> Option<T> {
    let (reply, answer) = channel();
    engine().send(build(reply)).ok()?;
    answer.recv().ok()
}

fn submit(command: Command) {
    let _ = engine().send(command);
}

/// FinishInstall carries a reply channel but its callers are the install
/// worker, which has nobody to answer; the send result is ignored.
fn submit_finish_install(version: String, outcome: InstallOutcome) {
    let (reply, _answer) = channel();
    submit(Command::FinishInstall {
        version,
        outcome,
        reply,
    });
}

/// The engine's current payload; the answer every command returns.
fn current_payload() -> UpdateStatePayload {
    request(|reply| Command::CurrentState { reply }).unwrap_or_else(idle_payload)
}

// ── settings access ────────────────────────────────────────────────────────

/// A granted channel-write reservation. Dropping it releases the engine and
/// starts any recheck the completed transition queued.
pub struct ChannelWriteReservation {
    _private: (),
}

impl Drop for ChannelWriteReservation {
    fn drop(&mut self) {
        submit(Command::ReleaseChannelWrite);
    }
}

/// Ask the engine for exclusive channel-write ownership. Refused while an
/// install is in progress or another channel write holds it.
pub fn reserve_channel_write() -> Option<ChannelWriteReservation> {
    request(|reply| Command::ReserveChannelWrite { reply })
        .filter(|granted| *granted)
        .map(|_| ChannelWriteReservation { _private: () })
}

/// Report the persisted channel and wait for the engine's transition, then
/// release. Callers hold settings::SAVE_LOCK across this so readers never see
/// the file and the engine disagree.
pub fn complete_channel_change(
    reservation: ChannelWriteReservation,
    next: UpdateChannel,
    previous: UpdateChannel,
    saved: Result<(), String>,
) {
    let (reply, answer) = channel();
    if engine()
        .send(Command::ChannelChanged {
            channel: next,
            previous,
            saved,
            reply,
        })
        .is_ok()
    {
        let _ = answer.recv();
    }
    drop(reservation);
}

/// (updateChannel, autoCheckUpdates) from the normalized settings cache.
/// settings::init runs before the updater engine, so this never reads the file.
fn read_settings() -> (UpdateChannel, bool) {
    let settings = crate::settings::current();
    (settings.update_channel, settings.auto_check_updates)
}

// ── platform answers (platform.rs exposes distribution_channel only) ──────

/// v1's CONV2_DISABLE_UPDATES kill switch.
/// Store builds and the env switch both turn the updater off.
pub fn updates_disabled() -> bool {
    crate::platform::distribution_channel() == "msstore" || updates_disabled_by_env()
}

fn updates_disabled_by_env() -> bool {
    matches!(
        std::env::var("CONV2_DISABLE_UPDATES").as_deref(),
        Ok("1") | Ok("true")
    )
}

fn flatpak_build() -> bool {
    std::env::var_os("FLATPAK_ID").is_some_and(|id| !id.is_empty())
        || std::path::Path::new("/.flatpak-info").exists()
}

fn is_packaged() -> bool {
    let exe = match std::env::current_exe() {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(_) => return false,
    };

    #[cfg(windows)]
    {
        let lower = exe.to_lowercase();
        !(lower.contains("\\target\\debug\\") || lower.contains("\\target\\release\\"))
    }

    #[cfg(target_os = "macos")]
    {
        exe.contains(".app/Contents/MacOS/")
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        !(exe.contains("/target/debug/") || exe.contains("/target/release/"))
    }
}

/// A Rosetta-translated process requests native Apple Silicon bundles.
#[cfg(target_os = "macos")]
fn is_rosetta_translated() -> bool {
    let mut ret: libc::c_int = 0;
    let mut size: libc::size_t = std::mem::size_of_val(&ret);
    let name = c"sysctl.proc_translated";
    let res = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut ret as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    res == 0 && ret == 1
}

#[cfg(not(target_os = "macos"))]
fn is_rosetta_translated() -> bool {
    false
}

/// `{os}-beta-{arch}[-{installer}]`, as ROSI's beta targets.
fn compute_beta_target() -> String {
    use tauri::utils::config::BundleType;

    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        other => other,
    };
    let arch = if is_rosetta_translated() {
        "aarch64"
    } else {
        match std::env::consts::ARCH {
            "x86" => "i686",
            "arm64" => "aarch64",
            other => other,
        }
    };
    let installer = match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) => Some("deb"),
        Some(BundleType::Rpm) => Some("rpm"),
        Some(BundleType::AppImage) => Some("appimage"),
        Some(BundleType::Msi) => Some("msi"),
        Some(BundleType::Nsis) => Some("nsis"),
        Some(BundleType::App | BundleType::Dmg) => Some("app"),
        None => None,
    };
    match installer {
        Some(installer) => format!("{os}-beta-{arch}-{installer}"),
        None => format!("{os}-beta-{arch}"),
    }
}

/// Packaged macOS apps update from per-arch `.app.tar.zst` archives
/// (scripts/pack-macos-updater-zst.js); `None` elsewhere.
fn compute_compact_target(beta: bool) -> Option<String> {
    use tauri::utils::config::BundleType;

    if !cfg!(target_os = "macos")
        || !matches!(
            tauri::utils::platform::bundle_type(),
            Some(BundleType::App | BundleType::Dmg)
        )
    {
        return None;
    }
    let arch = if is_rosetta_translated() {
        "aarch64"
    } else {
        match std::env::consts::ARCH {
            arch @ ("aarch64" | "x86_64") => arch,
            _ => return None,
        }
    };
    let channel = if beta { "-beta" } else { "" };
    Some(format!("darwin{channel}-{arch}-app-zst"))
}

fn beta_target() -> String {
    e2e_override(|config| config.beta_target.clone()).unwrap_or_else(compute_beta_target)
}

fn compact_target(beta: bool) -> Option<String> {
    if e2e_override(|config| config.disable_compact.then_some(())).is_some() {
        return None;
    }
    e2e_override(|config| config.compact_target.clone()).or_else(|| compute_compact_target(beta))
}

/// The feed's target: compact first on macOS, else the beta target, else the
/// default `{os}-{arch}` lookup.
fn resolve_target(beta_feed: bool) -> Option<String> {
    if let Some(compact) = compact_target(beta_feed) {
        return Some(compact);
    }
    beta_feed.then(beta_target)
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

// ── feed access ────────────────────────────────────────────────────────────

fn check_timeout() -> Duration {
    e2e_override(|config| config.check_timeout_ms.map(Duration::from_millis))
        .unwrap_or(CHECK_TIMEOUT)
}

fn download_timeout() -> Duration {
    e2e_override(|config| config.download_timeout_ms.map(Duration::from_millis))
        .unwrap_or(DOWNLOAD_TIMEOUT)
}

fn build_updater(app: &AppHandle, target: Option<String>) -> Result<Updater, String> {
    let mut builder = app.updater_builder().timeout(check_timeout());
    if let Some(target) = target {
        builder = builder.target(target);
    }
    // v1 acceptance: strictly newer per updaterPolicy.ts, no downgrades.
    builder = builder.version_comparator(|current, release| {
        should_accept_update(&release.version.to_string(), &current.to_string())
    });
    if let Some((endpoint, pubkey)) =
        e2e_override(|config| Some((config.endpoint.clone(), config.pubkey.clone())))
    {
        let url: url::Url = endpoint
            .parse()
            .map_err(|error: url::ParseError| error.to_string())?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|error| error.to_string())?
            .pubkey(pubkey);
    }
    builder.build().map_err(|error| error.to_string())
}

/// One feed request. One in-place retry for an explicit target, as ROSI did.
async fn check_target(
    app: &AppHandle,
    target: Option<String>,
    retry_on_error: bool,
) -> Result<Option<Update>, String> {
    let updater = build_updater(app, target.clone())?;
    let update = match updater.check().await {
        Ok(update) => update,
        Err(error) => {
            if !retry_on_error || target.is_none() {
                return Err(error.to_string());
            }
            updater.check().await.map_err(|error| error.to_string())?
        }
    };
    Ok(update)
}

/// The target a packaged macOS app used before per-arch zst feeds existed.
fn legacy_target(compact: &str) -> Option<String> {
    compact
        .contains("-beta-")
        .then(|| compact[..compact.len() - "-zst".len()].to_string())
}

/// Compact `-app-zst` targets fall back, once, to the universal feed when the
/// release has no per-arch archive.
async fn check_feed(app: &AppHandle, target: Option<String>) -> Result<Option<Update>, String> {
    let Some(compact) = target
        .as_deref()
        .filter(|target| target.ends_with(COMPACT_TARGET_SUFFIX))
        .map(str::to_owned)
    else {
        return check_target(app, target, true).await;
    };
    match check_target(app, Some(compact.clone()), false).await {
        Ok(update) => Ok(update),
        Err(error) => {
            crate::logging::warn(&format!(
                "updater: {compact} check failed, falling back to the {} target: {error}",
                legacy_target(&compact).as_deref().unwrap_or("default")
            ));
            check_target(app, legacy_target(&compact), true).await
        }
    }
}

// ── workers ────────────────────────────────────────────────────────────────

/// One check worker: ask for the check, resolve the channel, hit the feed,
/// report, and loop only for the stable fallback. The engine decides and
/// emits; this thread never does.
fn run_check(mode: CheckMode) {
    let Some(app) = app_state::app().cloned() else {
        return;
    };
    let generation = match request(|reply| Command::BeginCheck { mode, reply }) {
        Some(CheckStart::Started(generation)) => generation,
        _ => return,
    };
    let mut force_stable = false;
    loop {
        let current = current_version(&app);
        let (channel, _) = read_settings();
        let beta_feed = !force_stable && resolved_beta_feed(channel, &current);
        let phase = if beta_feed {
            FeedPhase::Beta
        } else {
            FeedPhase::Stable
        };
        let target = resolve_target(beta_feed);
        let candidate = tauri::async_runtime::block_on(check_feed(&app, target));
        // v1 discarded feed answers that raced a channel switch; re-read to fence.
        if read_settings().0 != channel {
            let _ = request(|reply| Command::ReportFeed {
                generation,
                phase,
                outcome: FeedOutcome::ChannelMoved,
                reply,
            });
            return;
        }
        let outcome = match candidate {
            Ok(Some(update)) => FeedOutcome::Offered {
                version: update.version.clone(),
                update: Box::new(update),
            },
            Ok(None) => FeedOutcome::NoneNewer,
            Err(message) => FeedOutcome::Failed(message),
        };
        match request(|reply| Command::ReportFeed {
            generation,
            phase,
            outcome,
            reply,
        }) {
            Some(FeedDecision::FallbackStable) => force_stable = true,
            _ => return,
        }
    }
}

/// v1's formatBytes for the progress message.
fn format_bytes(bytes: f64) -> String {
    const SIZES: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes <= 0.0 {
        return "0 B".into();
    }
    let exponent = (bytes.max(1.0).log(1024.0).floor() as i64).clamp(0, 4) as usize;
    let scaled = (bytes / 1024f64.powi(exponent as i32) * 100.0).round() / 100.0;
    format!("{scaled} {}", SIZES[exponent])
}

fn download_flow() {
    let Some(_app) = app_state::app().cloned() else {
        return;
    };
    let (epoch, mut update) = match request(|reply| Command::BeginDownload { reply }) {
        Some(DownloadStartReply::Start { epoch, update }) => (epoch, update),
        _ => return,
    };
    update.timeout = Some(download_timeout());
    let mut transferred: u64 = 0;
    let mut total: u64 = 0;
    let result = tauri::async_runtime::block_on(update.download(
        |chunk, content_length| {
            transferred = transferred.saturating_add(chunk as u64);
            total = content_length.unwrap_or(0);
            submit(Command::DownloadProgress { transferred, total });
        },
        || {},
    ))
    .map(|bytes| (bytes, update))
    .map_err(|error| error.to_string());
    let _ = request(|reply| Command::FinishDownload {
        result,
        epoch,
        reply,
    });
}

enum InstallExit {
    /// Conversions still run; the engine already emitted a notice.
    Busy,
    Done(UpdateStatePayload),
}

fn install_flow() -> InstallExit {
    let Some(app) = app_state::app().cloned() else {
        return InstallExit::Done(current_payload());
    };
    // Held from BeginInstall through the restart so a queue claim cannot slip
    // between the busy check and the confirm transition.
    let Some(_reservation) = crate::conversion::reserve_install() else {
        let _ = request(|reply| Command::InstallBusy { reply });
        return InstallExit::Busy;
    };
    let start = request(|reply| Command::BeginInstall { reply });
    let Some(InstallStartReply::Proceed {
        version,
        update,
        bytes,
        already_installed,
    }) = start
    else {
        return InstallExit::Done(current_payload());
    };
    e2e_hold(|config| config.install_confirm_hold_ms);
    let confirmed = request(|reply| Command::ConfirmInstall {
        version: version.clone(),
        reply,
    });
    if !confirmed.unwrap_or(false) {
        return InstallExit::Done(current_payload());
    }
    if !already_installed {
        e2e_hold(|config| config.install_write_hold_ms);
        if let Err(message) = install_bytes(&update, bytes.as_slice()) {
            submit_finish_install(version.clone(), InstallOutcome::Failed(message));
            return InstallExit::Done(current_payload());
        }
        let written = request(|reply| Command::InstallWritten {
            version: version.clone(),
            reply,
        });
        if !written.unwrap_or(false) {
            // Always clear `installing`, even if the download vanished.
            submit_finish_install(
                version,
                InstallOutcome::Failed("The downloaded update changed during install.".into()),
            );
            return InstallExit::Done(current_payload());
        }
    }
    // Windows installers exit inside install_bytes; elsewhere this restarts,
    // and the main.rs on_before_exit hook has already flushed state.
    match restart_app(&app) {
        Ok(()) => {
            submit_finish_install(version, InstallOutcome::Restarted);
            InstallExit::Done(current_payload())
        }
        Err(message) => {
            submit_finish_install(version, InstallOutcome::Failed(message));
            InstallExit::Done(current_payload())
        }
    }
}

/// Install the downloaded bytes. The E2E probe verifies for real, runs the
/// same shutdown flush the main.rs hook would, and records without exiting.
fn install_bytes(update: &Update, bytes: &[u8]) -> Result<(), String> {
    if e2e_install_probe_active() {
        update.verify(bytes).map_err(|error| error.to_string())?;
        crate::window::shutdown()?;
        e2e_record_install();
        return Ok(());
    }
    update.install(bytes).map_err(|error| error.to_string())
}

fn restart_app(app: &AppHandle) -> Result<(), String> {
    if e2e_install_probe_active() {
        crate::window::shutdown()?;
        return e2e_restart_probe();
    }
    crate::window::restart(app)
}

/// v1 fired the silent check 3 s after ready-to-show, gated on packaged,
/// settings.autoCheckUpdates, and the github distribution. The renderer
/// reports readiness through mark_main_window_ready (window.rs, outside this
/// file set), so the flag is polled here.
fn spawn_startup_watcher() {
    std::thread::spawn(|| {
        let deadline = Instant::now() + MAIN_READY_TIMEOUT;
        while !constants::MAIN_READY.load(std::sync::atomic::Ordering::SeqCst) {
            if Instant::now() > deadline {
                return;
            }
            std::thread::sleep(MAIN_READY_POLL);
        }
        std::thread::sleep(SILENT_CHECK_DELAY);
        if !silent_check_allowed() {
            return;
        }
        run_check(CheckMode::Silent);
    });
}

fn silent_check_allowed() -> bool {
    if crate::platform::distribution_channel() != "github" {
        return false;
    }
    if updates_disabled_by_env() {
        return false;
    }
    let packaged = e2e_override(|config| config.is_packaged).unwrap_or_else(is_packaged);
    if !packaged {
        return false;
    }
    // Flatpak gets the manual-check notice only, as v1 skipped it silently.
    if e2e_override(|config| config.is_flatpak).unwrap_or_else(flatpak_build) {
        return false;
    }
    read_settings().1
}

// ── commands ───────────────────────────────────────────────────────────────

/// `check-for-updates`: runs a manual check. The answer is the engine's
/// current payload; every transition also arrives as an `update-state` event.
#[tauri::command]
pub async fn check_for_updates() -> IpcResult<UpdateStatePayload> {
    match tauri::async_runtime::spawn_blocking(|| {
        run_check(CheckMode::Manual);
        current_payload()
    })
    .await
    {
        Ok(payload) => ipc::ok(payload),
        Err(error) => ipc::err(INTERNAL_ERROR, format!("Update check stopped: {error}")),
    }
}

/// `download-update`: downloads the offered update. v1 autoDownload=false, so
/// check and download stay separate; the answer is the engine's payload.
#[tauri::command]
pub async fn download_update() -> IpcResult<UpdateStatePayload> {
    match tauri::async_runtime::spawn_blocking(|| {
        download_flow();
        current_payload()
    })
    .await
    {
        Ok(payload) => ipc::ok(payload),
        Err(error) => ipc::err(INTERNAL_ERROR, format!("Update download stopped: {error}")),
    }
}

/// `install-update`: installs the downloaded update, then restarts (v1's
/// quitAndInstall path). When conversions still run it emits a manual
/// `update-state` notice and answers INTERNAL_ERROR; nothing restarts later,
/// the user retries once they finish. Not busy: the vendored plugin's install
/// runs behind the main.rs on_before_exit hook, which flushes app state.
#[tauri::command]
pub async fn install_update() -> IpcResult<UpdateStatePayload> {
    match tauri::async_runtime::spawn_blocking(install_flow).await {
        Ok(InstallExit::Busy) => ipc::err(INTERNAL_ERROR, BUSY_CONVERSIONS_MESSAGE),
        Ok(InstallExit::Done(payload)) => ipc::ok(payload),
        Err(error) => ipc::err(INTERNAL_ERROR, format!("Update install stopped: {error}")),
    }
}

/// `cancel-update-download`: aborts the active download. The plugin cannot
/// stop an HTTP transfer, so the result is discarded when it lands.
#[tauri::command]
pub async fn cancel_update_download() -> IpcResult<UpdateStatePayload> {
    match tauri::async_runtime::spawn_blocking(|| {
        submit(Command::CancelDownload);
        current_payload()
    })
    .await
    {
        Ok(payload) => ipc::ok(payload),
        Err(error) => ipc::err(INTERNAL_ERROR, format!("Update cancel stopped: {error}")),
    }
}

/// `set-update-channel`: reserves the engine, persists under the settings
/// lock, and awaits the channel-changed transition before releasing. A
/// reservation refusal answers INTERNAL_ERROR without touching the file. The
/// answer is the engine's payload ("Update channel changed." when it switched).
#[tauri::command]
pub async fn set_update_channel(
    channel: FalliblePayload<UpdateChannel>,
) -> IpcResult<UpdateStatePayload> {
    let channel = match channel.into_typed(VALIDATION_ERROR, "Invalid update channel.") {
        Ok(channel) => channel,
        Err(error) => return ipc::from_error(error),
    };
    let saved =
        tauri::async_runtime::spawn_blocking(move || crate::settings::set_update_channel(channel))
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
    match saved {
        Ok(()) => ipc::ok(current_payload()),
        Err(error) => ipc::err(INTERNAL_ERROR, error),
    }
}

// ── E2E hooks ──────────────────────────────────────────────────────────────

/// Points the updater at a local signed manifest server and overrides the
/// platform answers that differ in an E2E binary, which is never packaged.
/// Always compiled so call sites stay unconditional; only the e2e build fills it.
#[cfg_attr(not(feature = "e2e"), allow(dead_code))]
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eUpdaterConfig {
    /// Endpoint template, e.g. `http://127.0.0.1:8080/latest-{{target}}.json`.
    pub endpoint: String,
    /// Base64 minisign public key, as in tauri.conf.json.
    pub pubkey: String,
    pub is_packaged: Option<bool>,
    pub is_flatpak: Option<bool>,
    pub beta_target: Option<String>,
    pub compact_target: Option<String>,
    #[serde(default)]
    pub disable_compact: bool,
    /// Verify downloads for real, record the install, and skip the restart.
    #[serde(default)]
    pub install_probe: bool,
    /// Restart attempts the probe refuses before it accepts one.
    #[serde(default)]
    pub restart_refusals: u32,
    /// Replaces the 30 s check timeout.
    pub check_timeout_ms: Option<u64>,
    /// Replaces the 30 min download timeout.
    pub download_timeout_ms: Option<u64>,
    /// Pauses an install before it confirms.
    pub install_confirm_hold_ms: Option<u64>,
    /// Pauses an install after it is confirmed, before the bytes are written.
    pub install_write_hold_ms: Option<u64>,
}

#[cfg(feature = "e2e")]
static E2E_CONFIG: std::sync::Mutex<Option<E2eUpdaterConfig>> = std::sync::Mutex::new(None);

/// Reads one E2E override. Production has no overrides.
#[cfg_attr(not(feature = "e2e"), allow(unused_variables))]
fn e2e_override<T>(pick: impl FnOnce(&E2eUpdaterConfig) -> Option<T>) -> Option<T> {
    #[cfg(feature = "e2e")]
    {
        E2E_CONFIG.lock().ok()?.as_ref().and_then(pick)
    }
    #[cfg(not(feature = "e2e"))]
    {
        None
    }
}

/// Pauses an install at one named point. Production never holds.
fn e2e_hold(pick: impl FnOnce(&E2eUpdaterConfig) -> Option<u64>) {
    if let Some(millis) = e2e_override(pick) {
        std::thread::sleep(Duration::from_millis(millis));
    }
}

fn e2e_install_probe_active() -> bool {
    e2e_override(|config| config.install_probe.then_some(())).is_some()
}

fn e2e_record_install() {
    #[cfg(feature = "e2e")]
    e2e_probe::record_install();
}

fn e2e_restart_probe() -> Result<(), String> {
    #[cfg(feature = "e2e")]
    {
        e2e_probe::restart()
    }
    #[cfg(not(feature = "e2e"))]
    {
        Ok(())
    }
}

#[cfg(feature = "e2e")]
mod e2e_probe {
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

    static REFUSALS: AtomicU32 = AtomicU32::new(0);
    static INSTALLS: AtomicU64 = AtomicU64::new(0);
    static RESTARTS: AtomicU64 = AtomicU64::new(0);
    static REFUSED: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ProbeState {
        pub installs: u64,
        pub restarts: u64,
        pub refused_restarts: u64,
    }

    pub fn configure(restart_refusals: u32) {
        REFUSALS.store(restart_refusals, Ordering::SeqCst);
    }

    pub fn record_install() {
        INSTALLS.fetch_add(1, Ordering::SeqCst);
    }

    /// Refuse restarts until the configured count is spent, then accept.
    pub fn restart() -> Result<(), String> {
        loop {
            let left = REFUSALS.load(Ordering::SeqCst);
            if left == 0 {
                break;
            }
            if REFUSALS
                .compare_exchange(left, left - 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                REFUSED.fetch_add(1, Ordering::SeqCst);
                return Err("The E2E restart probe refused the restart.".into());
            }
        }
        RESTARTS.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn snapshot() -> ProbeState {
        ProbeState {
            installs: INSTALLS.load(Ordering::SeqCst),
            restarts: RESTARTS.load(Ordering::SeqCst),
            refused_restarts: REFUSED.load(Ordering::SeqCst),
        }
    }
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_configure_updater(
    window: tauri::WebviewWindow,
    config: E2eUpdaterConfig,
) -> Result<(), String> {
    if window.label() != app_state::MAIN_WINDOW {
        return Err("Only the main window may configure the E2E updater.".into());
    }
    e2e_probe::configure(config.restart_refusals);
    let mut slot = E2E_CONFIG
        .lock()
        .map_err(|_| "The E2E updater configuration is poisoned.".to_string())?;
    *slot = Some(config);
    // Start the engine now so the startup watcher and state thread exist
    // before the suite drives any command.
    let _ = engine();
    Ok(())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_updater_probe(window: tauri::WebviewWindow) -> Result<e2e_probe::ProbeState, String> {
    if window.label() != app_state::MAIN_WINDOW {
        return Err("Only the main window may read the E2E updater probe.".into());
    }
    Ok(e2e_probe::snapshot())
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn gates() -> Gates {
        Gates {
            disabled: false,
            packaged: true,
            flatpak: false,
        }
    }

    fn active_check(generation: u64) -> ActiveCheck {
        ActiveCheck {
            generation,
            mode: CheckMode::Manual,
            fallback_used: false,
            discard: false,
        }
    }

    #[test]
    fn accepts_only_strictly_newer_versions() {
        assert!(should_accept_update("2.0.1", "2.0.0"));
        assert!(should_accept_update("2.1.0", "2.0.9"));
        assert!(!should_accept_update("2.0.0", "2.0.0"));
        assert!(!should_accept_update("2.0.0", "2.0.1"));
        // stable beats prerelease at the same base (updaterPolicy.ts)
        assert!(should_accept_update("2.0.0", "2.0.0-beta.1"));
        assert!(!should_accept_update("2.0.0-beta.1", "2.0.0"));
        // prerelease rank and numbers
        assert!(should_accept_update("2.0.0-beta.2", "2.0.0-beta.1"));
        assert!(!should_accept_update("2.0.0-beta.2", "2.0.0-beta.3"));
        assert!(!should_accept_update("2.0.0-alpha.3", "2.0.0-beta.1"));
        assert!(should_accept_update("2.0.0-rc.1", "2.0.0-beta.9"));
        // build metadata never counts
        assert!(!should_accept_update(
            "2.0.0-beta.1+build.2",
            "2.0.0-beta.1"
        ));
    }

    #[test]
    fn auto_channel_resolves_prereleases_to_beta() {
        assert!(is_prerelease_version("2.0.0-beta.1"));
        assert!(is_prerelease_version("2.0.0-Alpha.2"));
        assert!(is_prerelease_version("2.0.0-rc"));
        assert!(!is_prerelease_version("2.0.0"));
        assert!(!is_prerelease_version("2.0.0+build"));
        assert!(resolved_beta_feed(UpdateChannel::Auto, "2.0.0-beta.1"));
        assert!(!resolved_beta_feed(UpdateChannel::Auto, "2.0.0"));
        assert!(resolved_beta_feed(UpdateChannel::Beta, "2.0.0"));
        assert!(!resolved_beta_feed(UpdateChannel::Stable, "2.0.0-beta.1"));
    }

    #[test]
    fn channel_switch_invalidates_the_epoch_and_fences_inflight_answers() {
        let mut state = State::default();
        let mut candidates = Candidates::default();
        state.downloaded = Some("2.1.0".into());
        state.checks += 1;
        state.check = Some(active_check(1));

        // The switch emits, drops the downloaded update, fences the check.
        assert!(!state.channel_changed(
            &mut candidates,
            UpdateChannel::Beta,
            UpdateChannel::Auto,
            Ok(())
        ));
        assert_eq!(state.epoch, 1);
        assert!(state.downloaded.is_none());
        assert!(state.check.as_ref().is_some_and(|check| check.discard));
        assert!(state.recheck_queued);
        assert_eq!(state.last.phase, UpdatePhase::NotAvailable);
        assert_eq!(
            state.last.message.as_deref(),
            Some("Update channel changed.")
        );

        // The stale beta-feed answer is dropped and ends the discarded check.
        let (decision, spawn_recheck) =
            state.report_feed(&mut candidates, 1, FeedPhase::Beta, FeedOutcome::NoneNewer);
        assert!(matches!(decision, FeedDecision::Stale));
        assert!(spawn_recheck);
        assert!(state.check.is_none());
        assert!(!state.recheck_queued);

        // A late answer from the retired generation is ignored entirely.
        let (decision, _) =
            state.report_feed(&mut candidates, 1, FeedPhase::Beta, FeedOutcome::NoneNewer);
        assert!(matches!(decision, FeedDecision::Stale));
    }

    #[test]
    fn begin_check_is_single_flight_and_reports_gate_payloads() {
        let mut state = State::default();
        assert!(matches!(
            state.begin_check(CheckMode::Manual, gates()),
            CheckStart::Started(1)
        ));
        // A second manual check reports already-checking and changes nothing.
        assert!(matches!(
            state.begin_check(CheckMode::Manual, gates()),
            CheckStart::Terminal
        ));
        assert_eq!(state.last.phase, UpdatePhase::AlreadyChecking);
        assert!(state.last.manual);
        // A silent re-entry stays quiet.
        assert!(matches!(
            state.begin_check(CheckMode::Silent, gates()),
            CheckStart::Terminal
        ));
        assert!(!state.end_check());

        // Disabled builds never reach the feed.
        let mut disabled = State::default();
        let gates = Gates {
            disabled: true,
            ..gates()
        };
        assert!(matches!(
            disabled.begin_check(CheckMode::Manual, gates),
            CheckStart::Terminal
        ));
        assert_eq!(disabled.last.phase, UpdatePhase::Disabled);
        assert_eq!(disabled.last.message.as_deref(), Some(DISABLED_MESSAGE));
        // Silent checks on a disabled build emit nothing.
        let mut quiet = State::default();
        assert!(matches!(
            quiet.begin_check(CheckMode::Silent, gates),
            CheckStart::Terminal
        ));
        assert_eq!(quiet.last.phase, UpdatePhase::NotAvailable);
        assert!(quiet.last.message.is_none());
    }

    #[test]
    fn beta_feed_with_nothing_newer_falls_back_to_the_stable_feed_once() {
        let mut state = State::default();
        let mut candidates = Candidates::default();
        state.checks += 1;
        state.check = Some(active_check(1));

        // The beta feed is empty: recheck stable, do not finish.
        let (decision, spawn) =
            state.report_feed(&mut candidates, 1, FeedPhase::Beta, FeedOutcome::NoneNewer);
        assert!(matches!(decision, FeedDecision::FallbackStable));
        assert!(!spawn);
        assert_eq!(state.last.phase, UpdatePhase::Checking);

        // The stable feed is empty too: the check finishes as not-available.
        let (decision, _) = state.report_feed(
            &mut candidates,
            1,
            FeedPhase::Stable,
            FeedOutcome::NoneNewer,
        );
        assert!(matches!(decision, FeedDecision::Done));
        assert!(state.check.is_none());
        assert_eq!(state.last.phase, UpdatePhase::NotAvailable);
        assert_eq!(state.last.message.as_deref(), Some(LATEST_MESSAGE));
    }

    #[test]
    fn cancelled_downloads_swallow_their_result() {
        let mut state = State::default();
        let mut candidates = Candidates::default();
        state.download = Some(ActiveDownload {
            version: "2.1.0".into(),
            channel: UpdateChannel::Auto,
            epoch: 0,
            cancelled: false,
            started_at: Instant::now(),
            last_emit: None,
        });
        state.cancel_download();
        assert!(state
            .download
            .as_ref()
            .is_some_and(|active| active.cancelled));
        assert_eq!(state.last.phase, UpdatePhase::NotAvailable);
        assert_eq!(state.last.message.as_deref(), Some(CANCELLED_MESSAGE));

        // Whatever the transfer reports after cancelling is discarded.
        let outcome = state.finish_download(&mut candidates, Err("late network failure".into()), 0);
        assert!(matches!(outcome, FinishOutcome::Cancelled));
        assert!(state.download.is_none());
        assert!(state.downloaded.is_none());
        assert_eq!(state.last.phase, UpdatePhase::NotAvailable);
    }
}
