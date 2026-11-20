//! Private FFmpeg staging: hidden per-attempt directories, stale-directory
//! sweeping, and no-replace publication as `<base>_converted[_N].<ext>`.
//! No placeholder is created before a conversion, so a crash or kill leaves
//! no junk at the final name; the name is chosen only when publishing.

use crate::ffmpeg_args;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const STAGE_PREFIX: &str = ".conv2-stage-";
const STAGE_FILE_STEM: &str = "output";
/// Attempts per candidate name for errors other than "already exists".
const INSTALL_ATTEMPTS: u32 = 3;
/// Suffixes that may fail with such errors before publishing gives up.
const MAX_FAILED_NAMES: u32 = 3;

/// Sleeps (ms) between removal attempts in `Drop`: about 1.5 s in total.
const DROP_REMOVE_BACKOFF: &[u64] = &[50, 100, 200, 400, 800];
/// Sleeps (ms) between removal attempts at batch end.
const BATCH_END_REMOVE_BACKOFF: &[u64] = &[100, 300];

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Stage directories `Drop` could not remove, retried by
/// `retry_pending_removals`.
static PENDING_REMOVALS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// A private staging area for one FFmpeg attempt. FFmpeg writes here only;
/// the result is installed under a free public name after verification.
pub struct StagedOutput {
    dir: PathBuf,
    file: PathBuf,
    keep: bool,
}

impl StagedOutput {
    pub fn create(output_dir: &Path, extension: &str) -> Result<Self, String> {
        for _ in 0..64 {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let dir = output_dir.join(format!("{STAGE_PREFIX}{}-{sequence}", std::process::id()));
            match create_private_dir(&dir) {
                Ok(()) => {
                    set_hidden(&dir, true);
                    return Ok(Self {
                        file: dir.join(format!("{STAGE_FILE_STEM}.{extension}")),
                        dir,
                        keep: false,
                    });
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
            "Could not create a staging directory in {}",
            output_dir.display()
        ))
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    /// Verify the staged result, then install it under the first free
    /// `<base>_converted[_N].<ext>`. A finished encode is never deleted on an
    /// install failure: it is moved somewhere visible and reported instead.
    pub fn publish(
        mut self,
        output_dir: &Path,
        base: &str,
        extension: &str,
    ) -> Result<PathBuf, String> {
        let metadata = std::fs::symlink_metadata(&self.file).map_err(|error| {
            format!(
                "Could not verify staged output {}: {error}",
                self.file.display()
            )
        })?;
        if !metadata.file_type().is_file() || metadata.len() == 0 {
            return Err("FFmpeg reported success but produced no output file.".to_string());
        }
        let mut last_error = None;
        let mut failed_names = 0;
        'names: for suffix in 0..=ffmpeg_args::MAX_OUTPUT_SUFFIX {
            let candidate = output_dir.join(ffmpeg_args::output_file_name(base, suffix, extension));
            for attempt in 0..INSTALL_ATTEMPTS {
                match install_no_replace(&self.file, &candidate) {
                    Ok(()) => return Ok(candidate),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        continue 'names
                    }
                    Err(error) => {
                        // A vanished source cannot be fixed by retrying.
                        if !self.file.exists() {
                            return Err(format!("Staged output disappeared: {error}"));
                        }
                        last_error = Some(error);
                        if attempt + 1 < INSTALL_ATTEMPTS {
                            std::thread::sleep(Duration::from_millis(150 * u64::from(attempt + 1)));
                        }
                    }
                }
            }
            failed_names += 1;
            if failed_names >= MAX_FAILED_NAMES {
                break;
            }
        }
        let error = last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no free output name".to_string());
        let kept = self.keep_visible();
        Err(format!(
            "Could not save the converted file: {error}. It was kept at {}",
            kept.display()
        ))
    }

    /// Move the staged result out of the sweepable stage name, if possible.
    fn keep_visible(&mut self) -> PathBuf {
        self.keep = true;
        let recovered = self.dir.with_file_name(format!(
            "conv2-recovered-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::rename(&self.dir, &recovered) {
            Ok(()) => {
                set_hidden(&recovered, false);
                recovered.join(self.file.file_name().unwrap_or_default())
            }
            Err(_) => self.file.clone(),
        }
    }
}

impl Drop for StagedOutput {
    fn drop(&mut self) {
        if !self.keep && !remove_dir_retrying(&self.dir, DROP_REMOVE_BACKOFF) {
            // Held open (antivirus, indexer): retry at batch end.
            PENDING_REMOVALS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(self.dir.clone());
        }
    }
}

/// Removes `dir`, retrying with the given sleeps between attempts. A directory
/// that is already gone counts as removed.
fn remove_dir_retrying(dir: &Path, backoff: &[u64]) -> bool {
    let mut attempt = 0;
    loop {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => match backoff.get(attempt) {
                Some(millis) => {
                    std::thread::sleep(Duration::from_millis(*millis));
                    attempt += 1;
                }
                None => return false,
            },
        }
    }
}

/// Retries stage directories whose removal failed in `Drop`; call at batch
/// end. Still-present ones stay queued for the next batch and are logged.
pub fn retry_pending_removals() {
    let pending = std::mem::take(
        &mut *PENDING_REMOVALS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    );
    let mut remaining = Vec::new();
    for dir in pending {
        if !remove_dir_retrying(&dir, BATCH_END_REMOVE_BACKOFF) {
            crate::logging::warn(&format!(
                "Could not remove staging directory {}; it is cleaned up on next launch.",
                dir.display()
            ));
            remaining.push(dir);
        }
    }
    if !remaining.is_empty() {
        PENDING_REMOVALS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend(remaining);
    }
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

/// Sets or clears the hidden attribute on Windows, where dot-prefixed names
/// are not hidden. Failure is ignored: the entry works either way.
fn set_hidden(path: &Path, hidden: bool) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, INVALID_FILE_ATTRIBUTES,
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated buffer that lives for both calls.
        unsafe {
            let current = GetFileAttributesW(wide.as_ptr());
            if current != INVALID_FILE_ATTRIBUTES {
                let next = if hidden {
                    current | FILE_ATTRIBUTE_HIDDEN
                } else {
                    current & !FILE_ATTRIBUTE_HIDDEN
                };
                SetFileAttributesW(wide.as_ptr(), next);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (path, hidden);
}

/// Atomically move `staged` to `destination`, failing with `AlreadyExists`
/// instead of replacing anything.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn install_no_replace(staged: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(staged.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let to = std::ffi::CString::new(destination.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    #[cfg(target_os = "linux")]
    // SAFETY: both pointers are NUL-terminated and outlive the call.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    // SAFETY: both pointers are NUL-terminated and outlive the call.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        // The filesystem lacks the no-replace flag: hard-link (atomic, fails
        // if the name exists), or reserve the name and rename over it.
        Some(code)
            if code == libc::ENOTSUP
                || code == libc::EOPNOTSUPP
                || code == libc::ENOSYS
                || code == libc::EINVAL =>
        {
            install_without_flag(staged, destination)
        }
        _ => Err(error),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn install_without_flag(staged: &Path, destination: &Path) -> std::io::Result<()> {
    match std::fs::hard_link(staged, destination) {
        Ok(()) => {
            let _ = std::fs::remove_file(staged);
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Err(error),
        Err(_) => {}
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = std::fs::rename(staged, destination);
    if result.is_err() && std::fs::metadata(destination).is_ok_and(|meta| meta.len() == 0) {
        let _ = std::fs::remove_file(destination);
    }
    result
}

#[cfg(windows)]
fn install_no_replace(staged: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let from: Vec<u16> = staged.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Without MOVEFILE_REPLACE_EXISTING an occupied name fails atomically.
    // SAFETY: both buffers are NUL-terminated and outlive the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn install_no_replace(staged: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::hard_link(staged, destination)?;
    let _ = std::fs::remove_file(staged);
    Ok(())
}

/// `.conv2-stage-<pid>-<seq>` -> pid; any other name is not ours.
fn stage_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix(STAGE_PREFIX)?;
    let (pid, sequence) = rest.split_once('-')?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(pid) || !digits(sequence) {
        return None;
    }
    pid.parse().ok()
}

/// Conservative liveness: anything uncertain counts as alive.
fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return true;
        };
        if pid <= 0 {
            return true;
        }
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: plain handle queries; the handle is closed on every path.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code = 0u32;
            let known = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            !known || code == STILL_ACTIVE
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true
    }
}

/// Removes `.conv2-stage-*` directories left by a CONV2 process that is no
/// longer running. Only the exact stage name, real directories holding plain
/// files only, and dead (not current, not alive) PIDs are touched.
pub fn sweep_stale(output_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(output_dir) else {
        return;
    };
    let own = std::process::id();
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(stage_pid) else {
            continue;
        };
        if pid == own || pid_alive(pid) {
            continue;
        }
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        let plain = std::fs::read_dir(&path).is_ok_and(|children| {
            children
                .flatten()
                .all(|child| child.file_type().is_ok_and(|kind| kind.is_file()))
        });
        if plain && std::fs::remove_dir_all(&path).is_ok() {
            crate::logging::warn(&format!(
                "Removed stale staging directory {}",
                path.display()
            ));
        }
    }
}
