//! One-time import of CONV2 1.x (Electron) data into a fresh CONV2 2 profile.
//!
//! CONV2 1.x stored `settings.json`, its window state, and the GPU probe cache
//! in Electron's `userData` folder, `<config dir>/conv2`. CONV2 2 starts with
//! the new identifier `run.rosie.conv2`, so its own data folder is empty on
//! upgrade; this module copies the v1 files across once. The legacy folder is
//! only read, so going back to v1 keeps working.

use crate::fs_util::{read_json, write_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Electron used package.json's `name`, "conv2", with no productName override.
const LEGACY_FOLDER: &str = "conv2";
const SETTINGS_FILE: &str = "settings.json";
const MARKER_FILE: &str = "legacy-v1-import.json";
const MAX_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
const PRESERVED_REASON: &str =
    "Existing CONV2 2 data was preserved; the CONV2 1 copy was not imported.";
const BLOCKED_REASON: &str =
    "A non-file entry sits at the CONV2 2 path; remove it so the CONV2 1 copy can be imported.";

/// Copied before settings.json; settings go last, so an import interrupted
/// early leaves no settings file and the next launch retries.
const DATA_FILES: &[(&str, u64)] = &[
    ("windowState.json", 1024 * 1024),
    ("gpu-probe-cache.json", 4 * 1024 * 1024),
];

enum Carry {
    Fresh,
    Resume(Marker),
    Finished(Marker),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Skipped {
    file: String,
    reason: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    version: u32,
    outcome: String,
    source: String,
    imported_at: u64,
    imported: Vec<String>,
    skipped: Vec<Skipped>,
    #[serde(default)]
    retry_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// True when any entry sits at `path`, including a directory or a symlink.
fn occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Only an existing regular file is preserved; symlinks are not followed.
fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

fn candidate_dirs(app: &AppHandle) -> Vec<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(dir) = std::env::var_os("CONV2_E2E_LEGACY_V1_DIR").filter(|dir| !dir.is_empty()) {
        return vec![PathBuf::from(dir)];
    }
    let dirs: Vec<PathBuf> = app
        .path()
        .config_dir()
        .map(|dir| dir.join(LEGACY_FOLDER))
        .into_iter()
        .collect();
    #[cfg(windows)]
    let dirs = {
        let mut dirs = dirs;
        if let Ok(local) = app.path().local_data_dir() {
            dirs.extend(store_package_dirs(&local));
        }
        dirs
    };
    dirs
}

/// The Microsoft Store (MSIX) build of CONV2 1.x had its %APPDATA% writes
/// redirected into its package folder.
#[cfg(windows)]
fn store_package_dirs(local_app_data: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(local_app_data.join("Packages")) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("burnttoasters.conv2_")
        })
        .map(|entry| {
            entry
                .path()
                .join("LocalCache")
                .join("Roaming")
                .join(LEGACY_FOLDER)
        })
        .collect();
    dirs.sort();
    dirs
}

fn find_source(app: &AppHandle, data: &Path) -> Option<PathBuf> {
    candidate_dirs(app)
        .into_iter()
        .find(|dir| dir.as_path() != data && dir.join(SETTINGS_FILE).is_file())
}

pub fn import_on_first_launch(app: &AppHandle) {
    let data = crate::app_state::data_dir();
    let previous = read_json(&data.join(MARKER_FILE), MAX_SETTINGS_BYTES)
        .and_then(|raw| serde_json::from_value::<Marker>(raw).ok());
    let settings_exist = data.join(SETTINGS_FILE).exists();
    if settings_exist && previous.is_none() {
        return;
    }
    let Some(source) = find_source(app, &data) else {
        return;
    };
    let carried =
        previous.filter(|marker| marker.version == 1 && marker.source == source.to_string_lossy());
    let carry = match carried {
        Some(marker) if !marker.retry_files.is_empty() => Carry::Resume(marker),
        Some(marker) if marker.outcome == "imported" => Carry::Finished(marker),
        _ => Carry::Fresh,
    };
    if settings_exist && !matches!(carry, Carry::Resume(_)) {
        return;
    }
    let marker = import_from(&source, &data, carry, settings_exist);
    match marker.outcome.as_str() {
        "imported" => crate::logging::info(&format!(
            "Imported CONV2 1 data from {}: {}",
            source.display(),
            marker.imported.join(", ")
        )),
        _ => crate::logging::warn(&format!(
            "Did not import CONV2 1 settings from {}: {}",
            source.display(),
            marker.reason.as_deref().unwrap_or("unknown reason")
        )),
    }
    for skipped in &marker.skipped {
        crate::logging::warn(&format!(
            "Skipped CONV2 1 {}: {}",
            skipped.file, skipped.reason
        ));
    }
    if let Err(error) = write_json(&data.join(MARKER_FILE), &marker) {
        crate::logging::warn(&format!("Could not record the CONV2 1 import: {error}"));
    }
}

fn import_from(source: &Path, data: &Path, carry: Carry, settings_exist: bool) -> Marker {
    let (mut marker, retry, finished) = match carry {
        Carry::Fresh => (
            Marker {
                version: 1,
                outcome: "skipped".into(),
                source: source.to_string_lossy().into_owned(),
                imported_at: crate::app_state::now_ms(),
                imported: Vec::new(),
                skipped: Vec::new(),
                retry_files: Vec::new(),
                reason: None,
            },
            None,
            false,
        ),
        Carry::Resume(mut marker) => {
            let files = marker.retry_files.clone();
            marker
                .skipped
                .retain(|skipped| !files.contains(&skipped.file));
            (marker, Some(files), false)
        }
        Carry::Finished(mut marker) => {
            marker.outcome = "skipped".into();
            (marker, None, true)
        }
    };
    let raw_settings = if settings_exist {
        Value::Null
    } else {
        match read_json(&source.join(SETTINGS_FILE), MAX_SETTINGS_BYTES) {
            Some(value @ Value::Object(_)) => value,
            Some(_) => {
                marker.reason = Some("settings.json is not a JSON object".into());
                return marker;
            }
            None => {
                marker.reason = Some("settings.json could not be read".into());
                return marker;
            }
        }
    };
    if !finished {
        marker.retry_files = DATA_FILES
            .iter()
            .filter(|(name, _)| {
                retry
                    .as_ref()
                    .is_none_or(|files| files.iter().any(|file| file == name))
                    && source.join(name).exists()
                    && !regular_file(&data.join(name))
            })
            .map(|(name, _)| (*name).to_string())
            .collect();
        marker.outcome = "partial".into();
        if let Err(error) = write_json(&data.join(MARKER_FILE), &marker) {
            marker.outcome = "failed".into();
            marker.reason = Some(format!("Could not preserve migration intent: {error}"));
            return marker;
        }
        marker.retry_files.clear();
        for (name, max_bytes) in DATA_FILES {
            if retry
                .as_ref()
                .is_some_and(|files| !files.iter().any(|file| file == name))
            {
                continue;
            }
            let path = source.join(name);
            if !path.exists() {
                continue;
            }
            let destination = data.join(name);
            if regular_file(&destination) {
                marker.skipped.push(Skipped {
                    file: (*name).to_string(),
                    reason: PRESERVED_REASON.into(),
                });
                continue;
            }
            let outcome = if occupied(&destination) {
                marker.retry_files.push((*name).to_string());
                Err(BLOCKED_REASON.into())
            } else {
                match read_json(&path, *max_bytes) {
                    Some(value @ Value::Object(_)) => write_json(&destination, &value),
                    Some(_) => Err("not a JSON object".to_string()),
                    None => Err("could not be read".to_string()),
                }
                .inspect_err(|_| marker.retry_files.push((*name).to_string()))
            };
            match outcome {
                Ok(()) => marker.imported.push((*name).to_string()),
                Err(reason) => marker.skipped.push(Skipped {
                    file: (*name).to_string(),
                    reason,
                }),
            }
        }
    }
    let settings_result = if settings_exist {
        Ok(())
    } else {
        crate::settings::import_legacy(raw_settings)
    };
    match settings_result {
        Ok(()) => {
            if !marker.imported.iter().any(|file| file == SETTINGS_FILE) {
                marker.imported.push(SETTINGS_FILE.to_string());
            }
            marker.outcome = if marker.retry_files.is_empty() {
                "imported"
            } else {
                "partial"
            }
            .into();
            marker.reason = (!marker.retry_files.is_empty()).then(|| {
                "Some CONV2 1 files could not be written. Repair their destinations and restart CONV2 to retry; existing CONV2 2 files will be preserved.".into()
            });
        }
        Err(error) => {
            marker.outcome = "failed".into();
            marker.reason = Some(format!("could not write settings.json: {error}"));
        }
    }
    marker
}
