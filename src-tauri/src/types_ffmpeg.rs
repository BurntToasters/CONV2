//! Internal FFmpeg domain types: the on-disk shapes the FFmpeg modules read
//! and write. Plain serde only; nothing here is part of the IPC contract, so
//! no ts-rs bindings are generated (types.rs owns the frontend shapes).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// `resources/ffmpeg/checksums.json`: per-target digests of the bundled
/// FFmpeg tools, keyed `"<os>:<arch>"` (v1 ffmpegIntegrity.ts). Binary names
/// inside the manifest are the generic `ffmpeg` / `ffprobe`; the shipped
/// sidecars are `conv2-ffmpeg` / `conv2-ffprobe`.
#[derive(Debug, Deserialize)]
pub struct ChecksumsManifest(pub BTreeMap<String, ChecksumTarget>);

#[derive(Debug, Deserialize)]
pub struct ChecksumTarget {
    #[serde(default)]
    pub binaries: BTreeMap<String, ChecksumBinary>,
}

#[derive(Debug, Deserialize)]
pub struct ChecksumBinary {
    #[serde(default)]
    pub sha256: Option<String>,
}

/// `<app data>/gpu-probe-cache.json` (v1 hwProbeStore.ts). Field names match
/// the v1 file exactly so a migrated cache stays readable.
#[derive(Debug, Serialize, Deserialize)]
pub struct HwProbeCacheFile {
    pub version: u64,
    pub fingerprint: String,
    #[serde(rename = "savedAt")]
    pub saved_at: u64,
    pub results: BTreeMap<String, bool>,
}

/// STORE_VERSION from v1's hwProbeStore.ts.
pub const HW_PROBE_CACHE_VERSION: u64 = 1;

/// Node-style platform name (`win32` / `darwin` / `linux`), matching the
/// values v1 sent the renderer and embedded in cache fingerprints.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        other => other,
    }
}

/// Node-style architecture name (`x64` / `arm64`), as v1's `process.arch`.
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// Locates a prepared sidecar in `src-tauri/binaries` for integration tests.
/// Returns the path plus the manifest's `stub` flag; `None` when the file or
/// its `.sidecar-manifest.json` entry is missing. Tests that need a working
/// FFmpeg must skip when `stub` is true (build.rs enforces the same rule).
#[cfg(test)]
pub(crate) mod test_support {
    use serde_json::Value;
    use std::path::PathBuf;

    /// Host target triple as scripts/prepare-sidecars.js names sidecars.
    pub fn host_triple() -> Option<String> {
        let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "aarch64-apple-darwin",
            ("macos", "x86_64") => "x86_64-apple-darwin",
            ("macos", _) => "universal-apple-darwin",
            ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
            ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
            ("windows", "x86_64") => "x86_64-pc-windows-msvc",
            ("windows", "aarch64") => "aarch64-pc-windows-msvc",
            _ => return None,
        };
        Some(triple.to_string())
    }

    fn manifest_entry(file_name: &str) -> Option<(PathBuf, bool)> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let path = root.join(file_name);
        if !path.is_file() {
            return None;
        }
        let manifest =
            std::fs::read_to_string(root.join(".sidecar-manifest.json")).unwrap_or_default();
        let parsed: Value = serde_json::from_str(&manifest).ok()?;
        let entry = parsed.get(file_name)?;
        let stub = entry.get("stub").and_then(Value::as_bool).unwrap_or(false);
        Some((path, stub))
    }

    /// Prepared sidecar `(path, is_stub)` for the host target, if present.
    pub fn sidecar(base_name: &str) -> Option<(PathBuf, bool)> {
        let triple = host_triple()?;
        let extension = if cfg!(windows) { ".exe" } else { "" };
        manifest_entry(&format!("{base_name}-{triple}{extension}"))
    }

    /// Prepared universal macOS sidecar `(path, is_stub)`, when shipped.
    pub fn universal_sidecar(base_name: &str) -> Option<(PathBuf, bool)> {
        let extension = if cfg!(windows) { ".exe" } else { "" };
        manifest_entry(&format!("{base_name}-universal-apple-darwin{extension}"))
    }
}

#[cfg(test)]
mod tests {
    // Failure modes:
    // - a manifest with an unknown extra field must still parse (forward compat).
    // - a missing `sha256` or `binaries` block must degrade to a lookup miss,
    //   never a parse error.
    // - cache files with wrong version or non-boolean results are rejected by
    //   the loader, not silently trusted.
    use super::*;

    #[test]
    fn checksum_manifest_parses_and_tolerates_unknown_fields() {
        let manifest: ChecksumsManifest = serde_json::from_str(
            r#"{"win:x64":{"binaries":{"ffmpeg":{"sha256":"abc","path":"ignored"}}},
                "mac:arm64":{"binaries":{"ffprobe":{"sha256":"def","extra":1}}}}"#,
        )
        .unwrap();
        assert_eq!(
            manifest.0["win:x64"].binaries["ffmpeg"].sha256.as_deref(),
            Some("abc")
        );
        assert_eq!(
            manifest.0["mac:arm64"].binaries["ffprobe"]
                .sha256
                .as_deref(),
            Some("def")
        );
        // Unknown keys elsewhere are ignored.
        let missing: ChecksumsManifest =
            serde_json::from_str(r#"{"linux:x64":{"unknown":true}}"#).unwrap();
        assert!(missing.0["linux:x64"].binaries.is_empty());
    }

    #[test]
    fn hw_cache_file_round_trips_with_v1_field_names() {
        let file = HwProbeCacheFile {
            version: HW_PROBE_CACHE_VERSION,
            fingerprint: "darwin-arm64|2.0.0|/x|1|2".to_string(),
            saved_at: 123,
            results: [("h264_nvenc".to_string(), true)].into_iter().collect(),
        };
        let text = serde_json::to_string(&file).unwrap();
        assert!(text.contains("\"savedAt\":123"));
        let parsed: HwProbeCacheFile = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.fingerprint, file.fingerprint);
        assert_eq!(parsed.results.get("h264_nvenc"), Some(&true));
    }
}
