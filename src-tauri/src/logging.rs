//! Rolling local diagnostics log (`<app data>/logs/conv2.log`), replacing
//! electron-log. Lines are single-line, timestamped, and size-trimmed.

use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Mutex;

const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_RENDERER_MESSAGE_CHARS: usize = 2000;

static LOG_LOCK: Mutex<()> = Mutex::new(());

fn log_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("logs").join("conv2.log")
}

/// UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` without pulling in a date crate.
pub fn iso_timestamp(millis: u64) -> String {
    let seconds = millis / 1000;
    let days = (seconds / 86_400) as i64;
    let secs_of_day = seconds % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
        millis % 1000
    )
}

fn trim_if_needed(path: &std::path::Path) {
    // Bounded: only the newest half is read, never the whole file.
    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    let len = metadata.len();
    if len <= MAX_LOG_FILE_BYTES {
        return;
    }
    let keep = MAX_LOG_FILE_BYTES / 2;
    if file.seek(SeekFrom::Start(len - keep)).is_err() {
        return;
    }
    let mut tail = Vec::with_capacity(keep as usize);
    if (&mut file).take(keep).read_to_end(&mut tail).is_err() {
        return;
    }
    let start = tail
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    drop(file);
    let _ = std::fs::write(path, &tail[start..]);
}

fn write_line(level: &str, message: &str) {
    let line = message.replace(['\r', '\n'], " ");
    if cfg!(debug_assertions) {
        eprintln!("[{level}] {line}");
    }
    let Ok(_guard) = LOG_LOCK.lock() else {
        return;
    };
    append_line(level, &line);
}

fn append_line(level: &str, line: &str) {
    // Never write through data_dir()'s predictable temp fallback.
    if !crate::app_state::data_dir_ready() {
        return;
    }
    let path = log_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    // A planted non-directory must not redirect the log.
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            eprintln!(
                "[warn] Log directory {} is not a directory; skipping",
                parent.display()
            );
            return;
        }
        Err(error) => {
            eprintln!(
                "[warn] Could not inspect log directory {}: {error}; skipping",
                parent.display()
            );
            return;
        }
    }
    // Unlink a symlinked leaf so the open creates a fresh file.
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            if let Err(error) = std::fs::remove_file(&path) {
                eprintln!(
                    "[warn] Could not remove symlinked log file {}: {error}; skipping",
                    path.display()
                );
                return;
            }
        }
    }
    trim_if_needed(&path);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(&path) {
        let _ = writeln!(
            file,
            "{} [{level}] {line}",
            iso_timestamp(crate::app_state::now_ms())
        );
    }
}

thread_local! {
    static IN_PANIC_HOOK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Record panics in the conv2 log before the previous hook runs. The log lock
/// may be held by the panicking thread, so the hook only try-locks and
/// otherwise appends unlocked. Re-entrant panics are ignored.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let reentered = IN_PANIC_HOOK.with(|flag| flag.replace(true));
        if !reentered {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .map(|text| text.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic payload>".to_string());
            let location = info
                .location()
                .map(|at| format!("{}:{}", at.file(), at.line()))
                .unwrap_or_else(|| "<unknown location>".to_string());
            let thread = std::thread::current();
            let name = thread.name().unwrap_or("<unnamed>");
            let message = format!("PANIC in thread '{name}' at {location}: {payload}")
                .replace(['\r', '\n'], " ");
            if crate::app_state::data_dir_ready() {
                let _guard = LOG_LOCK.try_lock();
                append_line("panic", &message);
            } else {
                // DATA_DIR is unset before app init; never touch the temp fallback.
                eprintln!("[panic] {message}");
            }
            IN_PANIC_HOOK.with(|flag| flag.set(false));
        }
        previous(info);
    }));
}

pub fn info(message: &str) {
    write_line("info", message);
}

pub fn warn(message: &str) {
    write_line("warn", message);
}

pub fn error(message: &str) {
    write_line("error", message);
}

#[tauri::command(async)]
pub fn log_error(message: crate::ipc::FalliblePayload<String>) {
    // A non-string message is dropped, as the untyped version did.
    let crate::ipc::FalliblePayload::Typed(text) = message else {
        return;
    };
    let truncated: String = if text.chars().count() > MAX_RENDERER_MESSAGE_CHARS {
        let head: String = text.chars().take(MAX_RENDERER_MESSAGE_CHARS).collect();
        format!("{head}...(truncated)")
    } else {
        text.to_string()
    };
    error(&format!("[renderer] {truncated}"));
}
