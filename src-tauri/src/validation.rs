//! Security boundary: path validation for IPC inputs (file picks, output
//! directories, reveal targets) and the URL handoff allow-list.

use crate::ipc::{IpcError, INVALID_PATH};
use std::path::{Component, Path, PathBuf};
use url::Url;

const MAX_URL_LENGTH: usize = 2048;

/// v1's path.resolve over an absolute path: collapse `.` and `..` lexically.
/// Windows device namespaces are refused before any filesystem access; drive
/// and standard UNC paths are allowed (v1 accepted network shares).
pub fn resolve_absolute(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() || is_device_namespace(path) {
        return None;
    }
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    Some(resolved)
}

/// Only drive (`C:\...`, `\\?\C:\...`) and UNC (`\\host\share\...`,
/// `\\?\UNC\host\share\...`) prefixes may reach a filesystem call; device
/// namespaces (`\\.\...`, `\\?\GLOBALROOT\...`) are refused. Windows parses
/// `/` and `\` alike, so test the parsed prefix rather than the raw string.
fn is_device_namespace(path: &Path) -> bool {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    !matches!(
        prefix.kind(),
        std::path::Prefix::Disk(_)
            | std::path::Prefix::VerbatimDisk(_)
            | std::path::Prefix::UNC(..)
            | std::path::Prefix::VerbatimUNC(..)
    )
}

/// An absolute path to an existing regular file. Symlinks are followed, as in
/// v1's fs.statSync; a missing or non-file target is invalid.
pub fn validate_file_path(value: &str) -> Result<String, IpcError> {
    let resolved = resolve_absolute(value)
        .ok_or_else(|| IpcError::new(INVALID_PATH, "File path must be absolute."))?;
    if !resolved.is_file() {
        return Err(IpcError::new(
            INVALID_PATH,
            "File does not exist or is not a regular file.",
        ));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

/// An absolute path to an existing directory.
pub fn validate_output_directory(value: &str) -> Result<String, IpcError> {
    let resolved = resolve_absolute(value)
        .ok_or_else(|| IpcError::new(INVALID_PATH, "Output directory must be absolute."))?;
    if !resolved.is_dir() {
        return Err(IpcError::new(
            INVALID_PATH,
            "Output directory does not exist.",
        ));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

/// Also used for an untrusted output directory in a queue request, where a
/// bad path falls back to the input's folder instead of rejecting the batch.
pub fn existing_directory(value: &str) -> Option<String> {
    validate_output_directory(value).ok()
}

pub fn existing_file(value: &str) -> Option<String> {
    validate_file_path(value).ok()
}

fn is_local_or_private(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".local")
        || lower.ends_with(".localhost")
        || lower.ends_with(".internal")
    {
        return true;
    }
    if let Ok(address) = lower.parse::<std::net::IpAddr>() {
        return match address {
            std::net::IpAddr::V4(address) => {
                address.is_loopback()
                    || address.is_private()
                    || address.is_link_local()
                    || address.is_unspecified()
                    || address.is_broadcast()
            }
            std::net::IpAddr::V6(address) => {
                address.is_loopback()
                    || address.is_unspecified()
                    || (address.segments()[0] & 0xffc0) == 0xfe80
                    || (address.segments()[0] & 0xfe00) == 0xfc00
            }
        };
    }
    false
}

/// The normalised https URL an external handoff may use, or None. Mirrors v1's
/// toSafeExternalUrl: https only, no credentials, no local/private host.
pub fn safe_external_url(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > MAX_URL_LENGTH {
        return None;
    }
    let parsed = Url::parse(value).ok()?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?;
    if is_local_or_private(host) {
        return None;
    }
    Some(parsed.to_string())
}

/// Whether an external URL may be handed to the OS browser.
pub fn is_safe_external_url(url: &str) -> bool {
    safe_external_url(url).is_some()
}

/// v1's redactPaths: replace the home directory, and every user-home shaped
/// prefix (`/Users/name`, `/home/name`, `C:\\Users\\name`), with `~`.
pub fn redact_paths(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|home| !home.is_empty());
    let mut redacted = match home {
        Some(home) => text.replace(&home, "~"),
        None => text.to_string(),
    };
    for prefix in ["/Users/", "/home/"] {
        redacted = redact_user_prefix(&redacted, prefix, false);
    }
    redacted = redact_user_prefix(&redacted, "\\Users\\", true);
    redacted
}

/// Replace `<prefix><user>` with `<prefix>~`. Windows paths keep their
/// backslashes; Unix prefixes stop at a path separator, quote, colon, or space.
fn redact_user_prefix(text: &str, prefix: &str, windows: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(prefix) {
        out.push_str(&rest[..index + prefix.len()]);
        let after = &rest[index + prefix.len()..];
        let end = after
            .char_indices()
            .find(|(_, character)| {
                if windows {
                    matches!(character, '\\' | '/' | ' ' | '"' | '\'' | ':')
                } else {
                    matches!(character, '/' | '\\' | ' ' | '"' | '\'' | ':')
                }
            })
            .map(|(index, _)| index)
            .unwrap_or(after.len());
        if end > 0 {
            out.push('~');
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}
