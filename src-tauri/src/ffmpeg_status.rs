//! Bundled/system FFmpeg availability and integrity verdict. v1 verified the
//! bundled binaries against checksums.json before every spawn; this port
//! keeps that gate: `check_ffmpeg` reports, and `current_status` is called
//! before any ffprobe or GPU probe runs.
//!
//! Resolution (v2, simplified from v1's ffmpegPath.ts): bundled sidecars
//! (`conv2-ffmpeg` / `conv2-ffprobe`, Tauri externalBin) live next to the
//! executable; when `useSystemFFmpeg` is set in settings.json, absolute
//! binaries are pinned from PATH instead. v1's private temp copies and dev
//! overrides are dropped: the sidecar directory is the only bundled source.
//! A system lookup that resolves nothing stays missing; a bare `ffmpeg` name
//! is never spawned, so no OS PATH/CWD search can stand in. `effective_tools`
//! returns the exact absolute paths whose status `current_status` accepted.

use crate::fs_util::{self, Sha256Stream};
use crate::ipc::{self, IpcResult, INTERNAL_ERROR};
use crate::process_util;
use crate::types::{AppSettings, FFmpegStatus, FFmpegStatusReason};
use crate::types_ffmpeg::{node_arch, node_platform, ChecksumsManifest};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub const FFMPEG_SIDECAR: &str = "conv2-ffmpeg";
pub const FFPROBE_SIDECAR: &str = "conv2-ffprobe";
const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

const BINARY_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const STATUS_CACHE_TTL: Duration = Duration::from_secs(30);
/// v1 read at most this many header bytes of a PE file for Authenticode.
const PE_HEADER_READ_BYTES: u64 = 4096;
const PE_SECURITY_DIRECTORY_INDEX: usize = 4;
const PE_DIRECTORY_ENTRY_BYTES: usize = 8;
/// signtool aligns the cert table to 8 bytes with up to 7 zero bytes before it.
const PE_PAD_MAX_BYTES: u64 = 7;
const MACH_FAT_MAGIC: u32 = 0xcafe_babe;
const MACH_FAT64_MAGIC: u32 = 0xcafe_babf;
const MACH_FAT_MAX_ARCHES: usize = 16;
/// Largest settings.json this gate will trust (defensive cap).
const SETTINGS_READ_LIMIT: u64 = 1024 * 1024;
const MANIFEST_READ_LIMIT: u64 = 1024 * 1024;

// Failure modes (ported from v1 ffmpegIntegrity.ts):
// - tampered code bytes: every digest differs from the manifest.
// - a binary swapped between checks: the gate re-stats both paths and
//   re-verifies on any change (the cache key covers size and mtime).
// - a verification error: fails closed as verification-failed.
// - the -version run is the only spawn in the check, and it runs only after
//   checksums pass.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BinaryName {
    Ffmpeg,
    Ffprobe,
}

impl BinaryName {
    fn sidecar(self) -> &'static str {
        match self {
            Self::Ffmpeg => FFMPEG_SIDECAR,
            Self::Ffprobe => FFPROBE_SIDECAR,
        }
    }

    /// Manifest key in checksums.json, which records the generic names.
    fn manifest_key(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
        }
    }

    /// System lookup name (`ffmpeg.exe` on Windows).
    fn system_name(self) -> String {
        format!("{}{EXE_SUFFIX}", self.manifest_key())
    }
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// Bundled sidecar path next to the executable; the bare sidecar name when
/// the executable directory cannot be resolved.
pub fn bundled_sidecar_path(name: &str) -> PathBuf {
    exe_dir()
        .map(|dir| dir.join(format!("{name}{EXE_SUFFIX}")))
        .unwrap_or_else(|| PathBuf::from(name))
}

#[allow(dead_code)] // Bundled-only helper; probes use `effective_tools`.
pub fn bundled_ffprobe() -> PathBuf {
    bundled_sidecar_path(FFPROBE_SIDECAR)
}

/// Resolve a media tool from the inherited PATH first, then from the extra
/// locations used for GUI-launched processes. Returning a canonical path pins
/// one binary so later PATH changes cannot swap it mid-session.
fn resolve_from_path(name: &str) -> Option<PathBuf> {
    let current_path = std::env::var_os("PATH").unwrap_or_default();
    let fallback_path = process_util::enhanced_path();
    for directory in std::env::split_paths(&current_path)
        .chain(std::env::split_paths(&fallback_path))
        .filter(|directory| directory.is_absolute())
    {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return candidate.canonicalize().ok();
        }
        #[cfg(windows)]
        if candidate.extension().is_none() {
            let with_exe = candidate.with_extension("exe");
            if with_exe.is_file() {
                return with_exe.canonicalize().ok();
            }
        }
    }
    None
}

/// Tiny local settings reader: the settings store itself lands with the
/// settings port. Only `useSystemFFmpeg` matters here; any read or parse
/// failure means the bundled sidecars.
fn use_system_ffmpeg_setting() -> bool {
    let path = crate::app_state::data_dir().join("settings.json");
    let Ok(meta) = std::fs::metadata(&path) else {
        return false;
    };
    if meta.len() > SETTINGS_READ_LIMIT {
        return false;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
        .is_some_and(|settings| settings.use_system_ffmpeg)
}

#[derive(Clone, Debug)]
struct BinaryPlan {
    name: BinaryName,
    /// The absolute path that is executed; None when nothing absolute was
    /// resolved, so the binary is missing rather than a bare-name lookup.
    effective: Option<PathBuf>,
    /// The bundled source that is verified; None when using system binaries.
    source: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct StatusPlan {
    using_bundled: bool,
    binaries: Vec<BinaryPlan>,
}

impl StatusPlan {
    /// The accepted executables for `key`; None if either side is unresolved.
    fn effective_tools(&self, key: &str) -> Option<EffectiveTools> {
        let path = |name: BinaryName| {
            self.binaries
                .iter()
                .find(|binary| binary.name == name)
                .and_then(|binary| binary.effective.clone())
        };
        Some(EffectiveTools {
            ffmpeg: path(BinaryName::Ffmpeg)?,
            ffprobe: path(BinaryName::Ffprobe)?,
            plan_key: key.to_string(),
        })
    }
}

fn resolve_plan() -> StatusPlan {
    let using_bundled = !use_system_ffmpeg_setting();
    let binaries = [BinaryName::Ffmpeg, BinaryName::Ffprobe]
        .into_iter()
        .map(|name| {
            if using_bundled {
                // bundled_sidecar_path falls back to a bare name when the
                // exe directory is unknown; that fallback is not executable.
                let path = bundled_sidecar_path(name.sidecar());
                let effective = path.is_absolute().then_some(path);
                BinaryPlan {
                    name,
                    effective: effective.clone(),
                    source: effective,
                }
            } else {
                // Pin one absolute binary so later PATH changes cannot swap
                // it mid-session; an unresolved lookup stays missing.
                BinaryPlan {
                    name,
                    effective: resolve_from_path(&name.system_name()),
                    source: None,
                }
            }
        })
        .collect();
    StatusPlan {
        using_bundled,
        binaries,
    }
}

/// v1's fileSignature: `path:size:mtime`, or `path:absent` when unreadable.
fn file_signature(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            format!("{}:{}:{}", path.display(), meta.len(), mtime)
        }
        Err(_) => format!("{}:absent", path.display()),
    }
}

fn plan_key(plan: &StatusPlan) -> String {
    let mut parts = vec![plan.using_bundled.to_string()];
    for binary in &plan.binaries {
        parts.push(
            binary
                .effective
                .as_deref()
                .map(file_signature)
                .unwrap_or_else(|| "unresolved".to_string()),
        );
        parts.push(
            binary
                .source
                .as_ref()
                .map(|source| file_signature(source))
                .unwrap_or_else(|| "-".to_string()),
        );
    }
    parts.join("|")
}

/// Heuristic from ROSI platform.rs: cargo target directories mean a dev run.
fn is_packaged() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe = exe.to_string_lossy().to_lowercase();
    #[cfg(windows)]
    {
        !(exe.contains("\\target\\debug\\") || exe.contains("\\target\\release\\"))
    }
    #[cfg(target_os = "macos")]
    {
        exe.contains(".app/contents/macos/")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        !(exe.contains("/target/debug/") || exe.contains("/target/release/"))
    }
}

/// `resources/ffmpeg/checksums.json` as Tauri ships it inside the resource
/// directory; None in dev runs that were never bundled.
fn checksums_manifest_path() -> Option<PathBuf> {
    let app = crate::app_state::app()?;
    let resource = tauri::Manager::path(app).resource_dir().ok()?;
    let manifest = resource.join("ffmpeg").join("checksums.json");
    manifest.is_file().then_some(manifest)
}

/// v1's runtimeFfmpegTarget: `win32/x64` -> `win:x64`, `darwin/arm64` ->
/// `mac:arm64`. None for an unknown platform.
fn runtime_ffmpeg_target(platform: &str, arch: &str) -> Option<String> {
    let os = match platform {
        "win32" => "win",
        "darwin" => "mac",
        "linux" => "linux",
        _ => return None,
    };
    Some(format!("{os}:{arch}"))
}

fn expected_checksum(
    manifest: &ChecksumsManifest,
    target: &str,
    binary: BinaryName,
) -> Option<String> {
    manifest
        .0
        .get(target)?
        .binaries
        .get(binary.manifest_key())?
        .sha256
        .clone()
        .filter(|digest| !digest.is_empty())
}

// Failure modes for fat (universal) slices:
// - a flipped byte inside the arch slice: the slice digest differs.
// - a flipped byte in the other arch's slice: this arch still matches, so it
//   passes (same accepted gap as v1).
// - no slice for this arch: None, so the caller fails closed.
// - offset or size past EOF, or zero size: rejected before any slice is hashed.
// - truncated header or arch table: None, so the caller fails closed.
// - thin or non-Mach-O file: None, so only the raw hash can match.
fn mach_cpu_type(arch: &str) -> Option<u32> {
    match arch {
        "x64" => Some(0x0100_0007),
        "arm64" => Some(0x0100_000c),
        _ => None,
    }
}

fn find_mac_fat_slice(path: &Path, arch: &str) -> std::io::Result<Option<(u64, u64)>> {
    let Some(cpu_type) = mach_cpu_type(arch) else {
        return Ok(None);
    };
    let mut file = std::fs::File::open(path)?;
    let file_size = file.metadata()?.len();
    use std::io::Read;
    let mut head = [0u8; 8];
    if file.read(&mut head)? < head.len() {
        return Ok(None);
    }
    let magic = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    if magic != MACH_FAT_MAGIC && magic != MACH_FAT64_MAGIC {
        return Ok(None);
    }
    let is64 = magic == MACH_FAT64_MAGIC;
    let entry_bytes = if is64 { 32 } else { 20 };
    let count = u32::from_be_bytes([head[4], head[5], head[6], head[7]]) as usize;
    if count == 0 || count > MACH_FAT_MAX_ARCHES {
        return Ok(None);
    }
    let mut table = vec![0u8; count * entry_bytes];
    if file.read(&mut table)? < table.len() {
        return Ok(None);
    }
    for entry in table.chunks_exact(entry_bytes) {
        if u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]) != cpu_type {
            continue;
        }
        let offset = if is64 {
            u64::from_be_bytes(entry[8..16].try_into().unwrap())
        } else {
            u32::from_be_bytes(entry[8..12].try_into().unwrap()) as u64
        };
        let size = if is64 {
            u64::from_be_bytes(entry[16..24].try_into().unwrap())
        } else {
            u32::from_be_bytes(entry[12..16].try_into().unwrap()) as u64
        };
        return Ok((size > 0 && offset + size <= file_size).then_some((offset, size)));
    }
    Ok(None)
}

// Failure modes for Authenticode-stripped hashing (signed Windows binaries only):
// - code bytes tampered after signing: the stripped hash differs from the manifest.
// - data appended after the cert table: the table no longer ends at EOF, so no candidates.
// - malformed or truncated PE header: every header read is bounds-checked, so no candidates.
// - cert offset outside the file or inside the headers: no candidates.
// - non-PE file: no MZ or PE signature, so no candidates.
// - huge file: only the header and a tail of at most 7 bytes are read; the body is streamed.
// - unsigned file: no Security directory, so the raw hash alone decides.
// - non-zero byte before the cert table: that padding length gives no candidate.
// - tampered padding byte: the zero-pad check rejects that length.

#[derive(Clone, Copy)]
struct AuthenticodeLayout {
    cert_offset: u64,
    checksum_at: usize,
    security_entry_at: usize,
    patch_end: usize,
}

fn read_u16_le(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(at..at + 2)?.try_into().unwrap(),
    ))
}

fn read_u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(at..at + 4)?.try_into().unwrap(),
    ))
}

fn pe_data_directories_offset(magic: u16) -> Option<usize> {
    match magic {
        0x10b => Some(96),
        0x20b => Some(112),
        _ => None,
    }
}

fn read_authenticode_layout(head: &[u8], file_size: u64) -> Option<AuthenticodeLayout> {
    if head.len() < 0x40 || read_u16_le(head, 0)? != 0x5a4d {
        return None;
    }
    let pe_at = read_u32_le(head, 0x3c)? as usize;
    if pe_at + 24 > head.len() || read_u32_le(head, pe_at)? != 0x0000_4550 {
        return None;
    }
    let optional_at = pe_at + 24;
    let data_dirs_at = optional_at + pe_data_directories_offset(read_u16_le(head, optional_at)?)?;
    let security_entry_at = data_dirs_at + PE_SECURITY_DIRECTORY_INDEX * PE_DIRECTORY_ENTRY_BYTES;
    let checksum_at = optional_at + 64;
    if security_entry_at + PE_DIRECTORY_ENTRY_BYTES > head.len() || checksum_at + 4 > head.len() {
        return None;
    }
    if read_u32_le(head, data_dirs_at - 4)? <= PE_SECURITY_DIRECTORY_INDEX as u32 {
        return None;
    }
    let cert_offset = read_u32_le(head, security_entry_at)? as u64;
    let cert_size = read_u32_le(head, security_entry_at + 4)? as u64;
    let header_end = read_u32_le(head, optional_at + 60)? as u64;
    let patch_end = (checksum_at + 4).max(security_entry_at + PE_DIRECTORY_ENTRY_BYTES);
    if cert_offset == 0 || cert_size == 0 {
        return None;
    }
    if cert_offset <= header_end || cert_offset < patch_end as u64 {
        return None;
    }
    if cert_offset + cert_size != file_size {
        return None;
    }
    Some(AuthenticodeLayout {
        cert_offset,
        checksum_at,
        security_entry_at,
        patch_end,
    })
}

/// Header bytes up to `patch_end`, with the Security entry zeroed and CheckSum
/// set to `checksum`.
fn patched_header(head: &[u8], layout: &AuthenticodeLayout, checksum: u32) -> Vec<u8> {
    let mut patched = head[..layout.patch_end].to_vec();
    patched[layout.security_entry_at..layout.security_entry_at + PE_DIRECTORY_ENTRY_BYTES].fill(0);
    patched[layout.checksum_at..layout.checksum_at + 4].copy_from_slice(&checksum.to_le_bytes());
    patched
}

#[derive(Default)]
struct PeWordSum {
    sum: u32,
    pending_low: Option<u8>,
}

fn fold_pe_sum(value: u32) -> u32 {
    (value & 0xffff) + (value >> 16)
}

impl PeWordSum {
    /// Sums 16-bit little-endian words; a trailing odd byte counts as its
    /// low byte, exactly like v1's peWordSum.
    fn add(&mut self, chunk: &[u8]) {
        let mut index = 0;
        if let Some(low) = self.pending_low.take() {
            if !chunk.is_empty() {
                self.sum = fold_pe_sum(
                    self.sum
                        .wrapping_add(u32::from(low) | (u32::from(chunk[0]) << 8)),
                );
                index = 1;
            }
        }
        while index + 1 < chunk.len() {
            let word = u32::from(chunk[index]) | (u32::from(chunk[index + 1]) << 8);
            self.sum = fold_pe_sum(self.sum.wrapping_add(word));
            index += 2;
        }
        if index < chunk.len() {
            self.pending_low = Some(chunk[index]);
        }
    }

    fn folded(&self) -> u32 {
        match self.pending_low {
            Some(low) => fold_pe_sum(fold_pe_sum(self.sum.wrapping_add(u32::from(low)))),
            None => fold_pe_sum(self.sum),
        }
    }
}

struct RangeReader {
    file: std::fs::File,
    size: u64,
}

impl RangeReader {
    fn open(path: &Path) -> std::io::Result<Self> {
        let file = std::fs::File::open(path)?;
        let size = file.metadata()?.len();
        Ok(Self { file, size })
    }

    fn read_at(&mut self, offset: u64, length: u64) -> std::io::Result<Vec<u8>> {
        use std::io::{Read, Seek};
        if length == 0 {
            return Ok(Vec::new());
        }
        self.file.seek(std::io::SeekFrom::Start(offset))?;
        let mut buffer = vec![0u8; length as usize];
        self.file.read_exact(&mut buffer)?;
        Ok(buffer)
    }

    fn stream_range(
        &mut self,
        start: u64,
        end: u64,
        mut on_chunk: impl FnMut(&[u8]),
    ) -> std::io::Result<()> {
        use std::io::{Read, Seek};
        if end <= start {
            return Ok(());
        }
        self.file.seek(std::io::SeekFrom::Start(start))?;
        let mut buffer = vec![0u8; 8192];
        let mut position = start;
        while position < end {
            let want = buffer.len().min((end - position) as usize);
            let read = self.file.read(&mut buffer[..want])?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "short read while streaming PE body",
                ));
            }
            on_chunk(&buffer[..read]);
            position += read as u64;
        }
        Ok(())
    }
}

/// SHA-256 candidates for a signed PE with its Authenticode blob removed;
/// empty for an unsigned or malformed file. Ported from v1
/// ffmpegIntegrity.ts:166-353.
fn authenticode_stripped_sha256_candidates(path: &Path) -> std::io::Result<Vec<String>> {
    let mut reader = RangeReader::open(path)?;
    let head_len = reader.size.min(PE_HEADER_READ_BYTES);
    let head = reader.read_at(0, head_len)?;
    let Some(layout) = read_authenticode_layout(&head, reader.size) else {
        return Ok(Vec::new());
    };
    let tail_start = (layout.patch_end as u64).max(layout.cert_offset - PE_PAD_MAX_BYTES);
    let tail = reader.read_at(tail_start, layout.cert_offset - tail_start)?;

    // Pass 1: PE checksum over the whole stripped content, zero-padded to
    // cert_offset.
    let mut word_sum = PeWordSum::default();
    word_sum.add(&patched_header(&head, &layout, 0));
    reader.stream_range(layout.patch_end as u64, tail_start, |chunk| {
        word_sum.add(chunk);
    })?;
    word_sum.add(&tail);
    let folded = word_sum.folded();

    // A padding length is a candidate only when its bytes before cert_offset
    // are zero. Zero bytes add nothing to the word sum, so the checksum for
    // that length is folded + length.
    let mut contents: Vec<(u64, u32)> = Vec::new();
    for pad in 0..=tail.len() {
        if tail[tail.len() - pad..].iter().all(|&byte| byte == 0) {
            let length = layout.cert_offset - pad as u64;
            contents.push((length, 0));
            contents.push((length, folded.wrapping_add(length as u32)));
        }
    }

    // Pass 2: one header-plus-body hash per distinct CheckSum value, extended
    // by the tail per length.
    let mut bases: Vec<(u32, Sha256Stream)> = Vec::new();
    for &(_, checksum) in &contents {
        if !bases.iter().any(|(key, _)| *key == checksum) {
            let mut hash = Sha256Stream::new();
            hash.update(&patched_header(&head, &layout, checksum));
            bases.push((checksum, hash));
        }
    }
    reader.stream_range(layout.patch_end as u64, tail_start, |chunk| {
        for (_, hash) in bases.iter_mut() {
            hash.update(chunk);
        }
    })?;
    let mut seen = std::collections::BTreeSet::new();
    for &(length, checksum) in &contents {
        if let Some((_, base)) = bases.iter().find(|(key, _)| *key == checksum) {
            let mut hash = base.clone();
            let end = (length - tail_start) as usize;
            hash.update(&tail[..end]);
            seen.insert(hash.finish());
        }
    }
    Ok(seen.into_iter().collect())
}

// Failure modes: tampered bytes, missing manifest target or digest, and
// unreadable files must return false. A dev layout without a manifest in
// reach returns true, so unpacked dev runs keep working; a packaged layout
// without one fails closed.
fn verify_bundled_binary_checksum(
    binary_path: &Path,
    binary: BinaryName,
    platform: &str,
    arch: &str,
    manifest: Option<&Path>,
    packaged: bool,
) -> bool {
    // A bare name is an OS PATH/CWD lookup, never a verified bundled binary.
    if !binary_path.is_absolute() {
        return false;
    }
    if !binary_path.exists() {
        return false;
    }
    let Some(manifest_path) = manifest else {
        return !packaged;
    };
    let parsed = (|| {
        let meta = std::fs::metadata(manifest_path).ok()?;
        if meta.len() > MANIFEST_READ_LIMIT {
            return None;
        }
        let text = std::fs::read_to_string(manifest_path).ok()?;
        serde_json::from_str::<ChecksumsManifest>(&text).ok()
    })();
    let Some(parsed) = parsed else {
        return false;
    };
    let Some(target) = runtime_ffmpeg_target(platform, arch) else {
        return !packaged;
    };
    let Some(expected) = expected_checksum(&parsed, &target, binary) else {
        return !packaged;
    };
    let digest = match fs_util::sha256_file(binary_path) {
        Ok(digest) => digest,
        Err(_) => return false,
    };
    if digest == expected {
        return true;
    }
    if platform == "darwin" {
        // v2 mac sidecars are per-arch thin except the universal build; a
        // universal file matches its per-arch digest only via this slice.
        return match find_mac_fat_slice(binary_path, arch) {
            Ok(Some((offset, size))) => {
                matches!(fs_util::sha256_range(binary_path, offset, size), Ok(digest)
                    if digest == expected)
            }
            _ => false,
        };
    }
    if platform == "win32" {
        return match authenticode_stripped_sha256_candidates(binary_path) {
            Ok(candidates) => candidates.contains(&expected),
            Err(_) => false,
        };
    }
    false
}

fn verify_bundled_binary(binary: &BinaryPlan, manifest: Option<&Path>, packaged: bool) -> bool {
    // compute_status already failed Missing when no absolute bundled path
    // resolved; verification never falls back to the -version spawn.
    let Some(source) = &binary.source else {
        return false;
    };
    let verified = verify_bundled_binary_checksum(
        source,
        binary.name,
        node_platform(),
        node_arch(),
        manifest,
        packaged,
    );
    if !verified {
        crate::logging::warn(&format!(
            "Bundled {} failed its checksum verification at {}.",
            binary.name.manifest_key(),
            source.display()
        ));
    }
    verified
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BinaryRunState {
    Ok,
    Missing,
    NotRunnable,
}

/// v1's runVersionCheck: `-version`, ten seconds, exit code 0 means ok. A
/// spawn failure for a missing binary is `missing`; anything else (including
/// a timeout) is `not-runnable`.
fn run_version_check(binary: &Path) -> BinaryRunState {
    let args = ["-version".to_string()];
    let mut command = process_util::command(binary, &args, &[], true);
    match process_util::run_with_timeout(
        &mut command,
        BINARY_CHECK_TIMEOUT,
        512,
        crate::constants::MAX_ERROR_BUFFER,
    ) {
        Ok(output) => {
            if output.timed_out {
                BinaryRunState::NotRunnable
            } else if output.code == Some(0) {
                BinaryRunState::Ok
            } else {
                BinaryRunState::NotRunnable
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BinaryRunState::Missing,
        Err(_) => BinaryRunState::NotRunnable,
    }
}

/// Only an absolute, existing executable counts as present. A bare name would
/// be an OS PATH/CWD lookup (Windows searches the CWD first), so it is missing.
fn is_missing_binary(binary: &BinaryPlan) -> bool {
    match &binary.effective {
        Some(path) if path.is_absolute() => !path.exists(),
        _ => true,
    }
}

fn fail(plan: &StatusPlan, reason: FFmpegStatusReason) -> FFmpegStatus {
    FFmpegStatus {
        ok: false,
        reason,
        using_bundled: plan.using_bundled,
    }
}

fn compute_status(plan: &StatusPlan) -> FFmpegStatus {
    if plan.binaries.iter().any(is_missing_binary) {
        return fail(plan, FFmpegStatusReason::Missing);
    }
    if plan.using_bundled {
        let manifest = checksums_manifest_path();
        let packaged = is_packaged();
        let probes: Vec<_> = plan
            .binaries
            .iter()
            .map(|binary| {
                let binary = binary.clone();
                let manifest = manifest.clone();
                std::thread::spawn(move || {
                    verify_bundled_binary(&binary, manifest.as_deref(), packaged)
                })
            })
            .collect();
        let verified = probes
            .into_iter()
            .all(|probe| probe.join().unwrap_or(false));
        if !verified {
            return fail(plan, FFmpegStatusReason::VerificationFailed);
        }
    }
    let probes: Vec<_> = plan
        .binaries
        .iter()
        .map(|binary| {
            let effective = binary.effective.clone();
            std::thread::spawn(move || match effective {
                Some(path) => run_version_check(&path),
                None => BinaryRunState::Missing,
            })
        })
        .collect();
    // A panicked probe fails closed as not-runnable rather than being ignored.
    let states: Vec<_> = probes
        .into_iter()
        .map(|probe| probe.join().unwrap_or(BinaryRunState::NotRunnable))
        .collect();
    if states.contains(&BinaryRunState::Missing) {
        return fail(plan, FFmpegStatusReason::Missing);
    }
    if states.contains(&BinaryRunState::NotRunnable) {
        return fail(plan, FFmpegStatusReason::NotRunnable);
    }
    FFmpegStatus {
        ok: true,
        reason: FFmpegStatusReason::Ok,
        using_bundled: plan.using_bundled,
    }
}

/// The absolute executables a successful check accepted. Spawns and caches
/// must use these paths, never `bundled_ffmpeg` or a bare name.
#[derive(Clone, Debug)]
pub(crate) struct EffectiveTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// Signature of the plan these paths were verified from; caches key on it.
    pub plan_key: String,
}

struct StatusCacheEntry {
    key: String,
    status: FFmpegStatus,
    /// Present exactly when `status.ok`: the paths that verdict accepted.
    tools: Option<EffectiveTools>,
    expires_at: Instant,
}

enum GateState {
    Idle(Option<StatusCacheEntry>),
    Busy,
}

static STATUS_GATE: Mutex<GateState> = Mutex::new(GateState::Idle(None));
static STATUS_GATE_CHANGED: Condvar = Condvar::new();

/// Gate for every spawn of ffmpeg or ffprobe (v1's getFFmpegStatus). Cached
/// per binary signature for the TTL; concurrent callers share one
/// verification. The gate is global rather than per-key: a waiter re-checks
/// the cache after the in-flight computation stores its result.
fn evaluate_status() -> (FFmpegStatus, Option<EffectiveTools>) {
    let plan = resolve_plan();
    let key = plan_key(&plan);
    let mut guard = STATUS_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    loop {
        match &mut *guard {
            GateState::Busy => {
                guard = STATUS_GATE_CHANGED
                    .wait(guard)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            GateState::Idle(cache) => {
                if let Some(entry) = cache.as_ref() {
                    if entry.key == key && Instant::now() < entry.expires_at {
                        return (entry.status.clone(), entry.tools.clone());
                    }
                }
                break;
            }
        }
    }
    *guard = GateState::Busy;
    drop(guard);

    // A panic while hashing or spawning must not leave the gate Busy forever.
    let (status, tools) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let status = compute_status(&plan);
        let tools = status.ok.then(|| plan.effective_tools(&key)).flatten();
        (status, tools)
    }))
    .unwrap_or((
        FFmpegStatus {
            ok: false,
            reason: FFmpegStatusReason::NotRunnable,
            using_bundled: plan.using_bundled,
        },
        None,
    ));

    let mut guard = STATUS_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = GateState::Idle(Some(StatusCacheEntry {
        key,
        status: status.clone(),
        tools: tools.clone(),
        expires_at: Instant::now() + STATUS_CACHE_TTL,
    }));
    STATUS_GATE_CHANGED.notify_all();
    (status, tools)
}

/// The renderer-facing verdict on the effective FFmpeg.
pub fn current_status() -> FFmpegStatus {
    evaluate_status().0
}

/// The executables whose status `current_status` accepted, from the same plan
/// resolution. None whenever the status is not ok, including a missing system
/// tool: callers must fail closed rather than spawn a bare name.
pub(crate) fn effective_tools() -> Option<EffectiveTools> {
    evaluate_status().1
}

/// v1's check-ffmpeg: the renderer-facing verdict on the effective FFmpeg.
#[tauri::command]
pub async fn check_ffmpeg() -> IpcResult<FFmpegStatus> {
    match tauri::async_runtime::spawn_blocking(current_status).await {
        Ok(status) => ipc::ok(status),
        Err(error) => ipc::err(INTERNAL_ERROR, error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    // Failure modes:
    // - manifest with a missing target, entry, or digest: lookup miss, never
    //   a parse error; packaged builds fail closed, dev passes open.
    // - malformed or truncated manifest JSON: fail closed (false).
    // - fat slice bounds past EOF or a foreign arch: fail closed.
    // - Authenticode table not ending at EOF (appended data): no candidates.
    // - a binary swapped between checks: the cache key changes on size or
    //   mtime drift, so the next call re-verifies.
    // - spawn failures: NotFound maps to missing; everything else, including
    //   a timeout, maps to not-runnable.
    use super::*;
    use crate::types_ffmpeg::test_support;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("conv2-ffmpeg-status-test")
            .join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_manifest(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("checksums.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn runtime_target_maps_platform_names() {
        assert_eq!(
            runtime_ffmpeg_target("win32", "x64").as_deref(),
            Some("win:x64")
        );
        assert_eq!(
            runtime_ffmpeg_target("darwin", "arm64").as_deref(),
            Some("mac:arm64")
        );
        assert_eq!(
            runtime_ffmpeg_target("linux", "x64").as_deref(),
            Some("linux:x64")
        );
        assert_eq!(runtime_ffmpeg_target("android", "x64"), None);
    }

    #[test]
    fn expected_checksum_reads_manifest_keys() {
        let dir = temp_dir("manifest");
        let manifest = write_manifest(
            &dir,
            r#"{"win:x64":{"binaries":{"ffmpeg":{"sha256":"abc123"},
                "ffprobe":{"sha256":"def456"}}}}"#,
        );
        let parsed: ChecksumsManifest =
            serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        assert_eq!(
            expected_checksum(&parsed, "win:x64", BinaryName::Ffmpeg).as_deref(),
            Some("abc123")
        );
        assert_eq!(
            expected_checksum(&parsed, "win:x64", BinaryName::Ffprobe).as_deref(),
            Some("def456")
        );
        assert_eq!(
            expected_checksum(&parsed, "mac:x64", BinaryName::Ffmpeg),
            None
        );
    }

    #[test]
    fn file_signature_tracks_size_and_absence() {
        let dir = temp_dir("signature");
        let path = dir.join("file.bin");
        std::fs::write(&path, b"12345").unwrap();
        let signature = file_signature(&path);
        assert!(signature.starts_with(&format!("{}:5:", path.display())));
        assert_eq!(
            file_signature(&dir.join("missing.bin")),
            format!("{}:absent", dir.join("missing.bin").display())
        );
        std::fs::write(&path, b"1234567").unwrap();
        assert_ne!(signature, file_signature(&path));
    }

    #[test]
    fn plan_key_changes_with_binary_state() {
        let dir = temp_dir("plan-key");
        let binary = dir.join("ffmpeg");
        std::fs::write(&binary, b"one").unwrap();
        let first = StatusPlan {
            using_bundled: true,
            binaries: vec![BinaryPlan {
                name: BinaryName::Ffmpeg,
                effective: Some(binary.clone()),
                source: Some(binary.clone()),
            }],
        };
        let first_key = plan_key(&first);
        assert_eq!(first_key, plan_key(&first));
        std::fs::write(&binary, b"three").unwrap();
        let second = StatusPlan {
            using_bundled: true,
            binaries: vec![BinaryPlan {
                name: BinaryName::Ffmpeg,
                effective: Some(binary.clone()),
                source: Some(binary),
            }],
        };
        assert_ne!(first_key, plan_key(&second));
    }

    #[test]
    #[cfg(unix)]
    fn version_check_classifies_spawn_results() {
        assert_eq!(
            run_version_check(Path::new("/usr/bin/true")),
            BinaryRunState::Ok
        );
        assert_eq!(
            run_version_check(Path::new("/usr/bin/false")),
            BinaryRunState::NotRunnable
        );
        assert_eq!(
            run_version_check(Path::new("/nonexistent/conv2-missing")),
            BinaryRunState::Missing
        );
    }

    #[test]
    fn verify_thin_binary_against_manifest() {
        let dir = temp_dir("verify-thin");
        let binary = dir.join("conv2-ffmpeg");
        std::fs::write(&binary, b"thin-binary-payload").unwrap();
        let digest = fs_util::sha256_file(&binary).unwrap();
        let manifest = write_manifest(
            &dir,
            &format!(r#"{{"linux:x64":{{"binaries":{{"ffmpeg":{{"sha256":"{digest}"}}}}}}}}"#),
        );
        assert!(verify_bundled_binary_checksum(
            &binary,
            BinaryName::Ffmpeg,
            "linux",
            "x64",
            Some(&manifest),
            true
        ));
        // Wrong digest fails closed even in dev.
        let bad_dir = dir.join("bad");
        std::fs::create_dir_all(&bad_dir).unwrap();
        let bad = write_manifest(
            &bad_dir,
            r#"{"linux:x64":{"binaries":{"ffmpeg":{"sha256":"0000"}}}}"#,
        );
        assert!(!verify_bundled_binary_checksum(
            &binary,
            BinaryName::Ffmpeg,
            "linux",
            "x64",
            Some(&bad),
            false
        ));
    }

    #[test]
    fn verify_open_dev_closed_packaged_without_manifest() {
        let dir = temp_dir("verify-open");
        let binary = dir.join("conv2-ffmpeg");
        std::fs::write(&binary, b"payload").unwrap();
        // No manifest in reach: dev keeps working, packaged fails closed.
        assert!(verify_bundled_binary_checksum(
            &binary,
            BinaryName::Ffmpeg,
            "linux",
            "x64",
            None,
            false
        ));
        assert!(!verify_bundled_binary_checksum(
            &binary,
            BinaryName::Ffmpeg,
            "linux",
            "x64",
            None,
            true
        ));
        // Missing target behaves the same way.
        let manifest = write_manifest(&dir, r#"{"win:x64":{"binaries":{}}}"#);
        assert!(verify_bundled_binary_checksum(
            &binary,
            BinaryName::Ffmpeg,
            "linux",
            "x64",
            Some(&manifest),
            false
        ));
        assert!(!verify_bundled_binary_checksum(
            &binary,
            BinaryName::Ffmpeg,
            "linux",
            "x64",
            Some(&manifest),
            true
        ));
    }

    fn fat_file(dir: &Path, x64: &[u8], arm64: &[u8]) -> PathBuf {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&MACH_FAT_MAGIC.to_be_bytes());
        bytes.extend_from_slice(&2u32.to_be_bytes());
        let x64_offset = 8 + 2 * 20;
        let arm64_offset = x64_offset + x64.len();
        for (cpu, offset, size) in [
            (0x0100_0007u32, x64_offset as u32, x64.len() as u32),
            (0x0100_000cu32, arm64_offset as u32, arm64.len() as u32),
        ] {
            let mut entry = Vec::new();
            entry.extend_from_slice(&cpu.to_be_bytes());
            entry.extend_from_slice(&3u32.to_be_bytes());
            entry.extend_from_slice(&offset.to_be_bytes());
            entry.extend_from_slice(&size.to_be_bytes());
            entry.extend_from_slice(&12u32.to_be_bytes());
            bytes.extend_from_slice(&entry);
        }
        bytes.extend_from_slice(x64);
        bytes.extend_from_slice(arm64);
        let path = dir.join("universal");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn mac_fat_slice_finds_the_current_arch() {
        let dir = temp_dir("fat-slice");
        let path = fat_file(&dir, b"x64-slice-bytes!!", b"arm64-slice-bytes");
        assert_eq!(
            find_mac_fat_slice(&path, "x64").unwrap(),
            Some((8 + 40, 17))
        );
        assert_eq!(
            find_mac_fat_slice(&path, "arm64").unwrap(),
            Some((8 + 40 + 17, 17))
        );
        assert_eq!(find_mac_fat_slice(&path, "ia32").unwrap(), None);
        // A thin file is not a fat container.
        let thin = dir.join("thin");
        std::fs::write(&thin, b"macho-thin").unwrap();
        assert_eq!(find_mac_fat_slice(&thin, "x64").unwrap(), None);
    }

    #[test]
    fn verify_universal_binary_via_slice() {
        let dir = temp_dir("fat-verify");
        let path = fat_file(&dir, b"x64-slice-bytes!!", b"arm64-slice-bytes");
        // sha256_file of a standalone copy equals the in-file slice digest.
        let standalone = dir.join("arm64-only");
        std::fs::write(&standalone, b"arm64-slice-bytes").unwrap();
        let arm64_digest = fs_util::sha256_file(&standalone).unwrap();
        let manifest = write_manifest(
            &dir,
            &format!(
                r#"{{"mac:arm64":{{"binaries":{{"ffmpeg":{{"sha256":"{arm64_digest}"}}}}}}}}"#
            ),
        );
        assert!(verify_bundled_binary_checksum(
            &path,
            BinaryName::Ffmpeg,
            "darwin",
            "arm64",
            Some(&manifest),
            true
        ));
        // The raw file hash differs, so verification must use the slice.
        assert_ne!(fs_util::sha256_file(&path).unwrap(), arm64_digest);
        // A foreign arch has no slice to check: fail closed.
        assert!(!verify_bundled_binary_checksum(
            &path,
            BinaryName::Ffmpeg,
            "darwin",
            "x64",
            Some(&manifest),
            true
        ));
    }

    fn synthetic_signed_pe(dir: &Path, pad_bytes: usize) -> PathBuf {
        // 512-byte header region; fields per readAuthenticode_layout.
        let mut head = vec![0u8; 512];
        head[0..2].copy_from_slice(&0x5a4d_u16.to_le_bytes());
        let pe_at = 0x40usize;
        head[0x3c..0x40].copy_from_slice(&(pe_at as u32).to_le_bytes());
        head[pe_at..pe_at + 4].copy_from_slice(&0x0000_4550u32.to_le_bytes());
        let optional_at = pe_at + 24;
        head[optional_at..optional_at + 2].copy_from_slice(&0x10b_u16.to_le_bytes());
        head[optional_at + 92..optional_at + 96].copy_from_slice(&5u32.to_le_bytes()); // NumberOfRvaAndSizes > 4
        head[optional_at + 60..optional_at + 64].copy_from_slice(&0x80u32.to_le_bytes()); // SizeOfHeaders
        let data_dirs_at = optional_at + 96;
        let security_at = data_dirs_at + PE_SECURITY_DIRECTORY_INDEX * PE_DIRECTORY_ENTRY_BYTES;
        let cert_offset = 512 + 64 + pad_bytes;
        let cert_size = 48u32;
        head[security_at..security_at + 4].copy_from_slice(&(cert_offset as u32).to_le_bytes());
        head[security_at + 4..security_at + 8].copy_from_slice(&cert_size.to_le_bytes());

        let mut file = head;
        file.extend(std::iter::repeat_n(0x41u8, 64)); // body after patch_end
        file.extend(std::iter::repeat_n(0u8, pad_bytes)); // signtool zero pad
        file.extend(std::iter::repeat_n(0xCCu8, cert_size as usize)); // cert blob
        let path = dir.join("signed.exe");
        std::fs::write(&path, file).unwrap();
        path
    }

    #[test]
    fn authenticode_layout_requires_cert_at_eof() {
        let dir = temp_dir("authenticode");
        let path = synthetic_signed_pe(&dir, 4);
        let mut reader = RangeReader::open(&path).unwrap();
        let head = reader
            .read_at(0, reader.size.min(PE_HEADER_READ_BYTES))
            .unwrap();
        let layout = read_authenticode_layout(&head, reader.size).unwrap();
        assert_eq!(layout.cert_offset, 512 + 64 + 4);
        assert_eq!(layout.cert_offset + 48, reader.size);

        // Appending data after the cert table kills all candidates.
        let appended = dir.join("appended.exe");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.push(0);
        std::fs::write(&appended, bytes).unwrap();
        let mut reader = RangeReader::open(&appended).unwrap();
        let head = reader
            .read_at(0, reader.size.min(PE_HEADER_READ_BYTES))
            .unwrap();
        assert!(read_authenticode_layout(&head, reader.size).is_none());
    }

    #[test]
    fn authenticode_candidates_cover_zero_paddings() {
        let dir = temp_dir("authenticode-candidates");
        let padded = synthetic_signed_pe(&dir, 4);
        let candidates = authenticode_stripped_sha256_candidates(&padded).unwrap();
        // pad=0..=4 are all zero tails, each with checksum 0 and folded+len.
        assert!(!candidates.is_empty());
        assert!(candidates.len() >= 5);

        // A tampered pad byte removes the padded lengths from the candidate set.
        let tampered = dir.join("tampered.exe");
        let mut bytes = std::fs::read(&padded).unwrap();
        let tamper_at = bytes.len() - 48 - 4; // first byte of the 4-byte pad
        bytes[tamper_at] = 1;
        std::fs::write(&tampered, bytes).unwrap();
        let tampered_candidates = authenticode_stripped_sha256_candidates(&tampered).unwrap();
        assert!(tampered_candidates.len() < candidates.len());
    }

    #[test]
    fn authenticode_returns_empty_for_unsigned_files() {
        let dir = temp_dir("authenticode-unsigned");
        let plain = dir.join("plain.exe");
        std::fs::write(&plain, b"not a PE file at all").unwrap();
        assert!(authenticode_stripped_sha256_candidates(&plain)
            .unwrap()
            .is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn compute_status_classifies_plans() {
        // Bundled but absent: missing.
        let plan = StatusPlan {
            using_bundled: true,
            binaries: vec![BinaryPlan {
                name: BinaryName::Ffmpeg,
                effective: Some(temp_dir("compute").join("absent-ffmpeg")),
                source: None,
            }],
        };
        assert_eq!(compute_status(&plan).reason, FFmpegStatusReason::Missing);

        // System binaries that run: ok without verification.
        let plan = StatusPlan {
            using_bundled: false,
            binaries: vec![BinaryPlan {
                name: BinaryName::Ffmpeg,
                effective: Some(PathBuf::from("/usr/bin/true")),
                source: None,
            }],
        };
        let status = compute_status(&plan);
        assert!(status.ok);
        assert_eq!(status.reason, FFmpegStatusReason::Ok);

        // A system binary that exits nonzero: not-runnable.
        let plan = StatusPlan {
            using_bundled: false,
            binaries: vec![BinaryPlan {
                name: BinaryName::Ffmpeg,
                effective: Some(PathBuf::from("/usr/bin/false")),
                source: None,
            }],
        };
        assert_eq!(
            compute_status(&plan).reason,
            FFmpegStatusReason::NotRunnable
        );
    }

    #[test]
    fn bundled_plan_points_at_sidecars_next_to_the_exe() {
        let plan = resolve_plan();
        // The test environment has no settings.json, so the plan is bundled.
        assert!(plan.using_bundled);
        assert_eq!(plan.binaries.len(), 2);
        for binary in &plan.binaries {
            assert_eq!(
                binary
                    .effective
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy(),
                format!("{}{}", binary.name.sidecar(), EXE_SUFFIX)
            );
            assert!(binary.source.is_some());
        }
    }

    #[test]
    fn current_status_is_stable_across_calls() {
        let first = current_status();
        let second = current_status();
        assert_eq!(first, second);
    }

    // Integration: real prepared sidecars verified against the shipped
    // manifest. Skipped when the sidecars are development stubs.
    #[test]
    fn real_sidecars_match_shipped_checksums() {
        let Some((path, stub)) = test_support::sidecar(FFMPEG_SIDECAR) else {
            return; // sidecars not prepared on this target
        };
        if stub {
            // TODO: sidecars are stubs; checksum parity is exercised on
            // machines that prepared real binaries.
            return;
        }
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("ffmpeg")
            .join("checksums.json");
        assert!(verify_bundled_binary_checksum(
            &path,
            BinaryName::Ffmpeg,
            node_platform(),
            node_arch(),
            Some(&manifest),
            true
        ));
    }

    // Integration: the universal macOS sidecar must verify through its
    // current-arch slice, not its raw digest.
    #[test]
    fn universal_sidecar_matches_arch_slice_digest() {
        if cfg!(not(target_os = "macos")) {
            return;
        }
        let Some((path, stub)) = test_support::universal_sidecar(FFMPEG_SIDECAR) else {
            return;
        };
        if stub {
            return;
        }
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("ffmpeg")
            .join("checksums.json");
        let parsed: ChecksumsManifest =
            serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        let target = runtime_ffmpeg_target("darwin", node_arch()).unwrap();
        let expected = expected_checksum(&parsed, &target, BinaryName::Ffmpeg).unwrap();
        // The raw digest of a universal file never matches a thin manifest
        // entry, so this only passes via the fat-slice path.
        assert_ne!(fs_util::sha256_file(&path).unwrap(), expected);
        assert!(verify_bundled_binary_checksum(
            &path,
            BinaryName::Ffmpeg,
            "darwin",
            node_arch(),
            Some(&manifest),
            true
        ));
    }
}
