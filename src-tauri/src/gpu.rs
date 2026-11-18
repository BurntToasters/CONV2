//! GPU capability probing (v1 gpuCapabilities.ts + gpuEncoders.ts +
//! hwProbeStore.ts + vaapiDevices.ts + gpuRecommendation.ts): a per-codec
//! vendor availability matrix for the GPU panel plus the Auto recommendation.
//! Probes spawn the bundled `conv2-ffmpeg` through process_util, so a
//! hung probe is tree-killed, and results are cached in memory and in
//! `<app data>/gpu-probe-cache.json` (7-day TTL, fingerprinted per binary).

use crate::fs_util;
use crate::ipc::{self, FalliblePayload, IpcResult, INTERNAL_ERROR, VALIDATION_ERROR};
use crate::process_util;
use crate::types::{
    GPUCapabilitiesPayload, GPUCapabilityStatus, GPUEncoderError, GpuCodec, GpuVendor,
};
use crate::types_ffmpeg::{node_arch, node_platform, HwProbeCacheFile, HW_PROBE_CACHE_VERSION};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const HW_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const ENCODER_LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// v1's DEFAULT_TTL_MS: 7 days.
const HW_CACHE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const HW_CACHE_FILE: &str = "gpu-probe-cache.json";
const HW_CACHE_READ_LIMIT: u64 = 1024 * 1024;
const DRM_DIR: &str = "/sys/class/drm";
// PCI vendor ids as exposed in /sys/class/drm/<node>/device/vendor.
const INTEL_VENDOR_ID: &str = "0x8086";
const AMD_VENDOR_ID: &str = "0x1002";

// Failure modes:
// - an encoder listed but broken (missing driver, no GPU): the lavfi probe
//   fails and the matrix reports it unavailable.
// - a probe that hangs: the 8s timeout tree-kills it; timeouts stay
//   session-only so a transient hang is retried next launch.
// - a stale cache answering for a new binary: the fingerprint covers
//   platform, arch, app version, and the binary's size and mtime.
// - a listing that fails because the binary is not ok must not be cached as
//   "absent" (status gate before any probe).
// - a software MFT answering for Qualcomm hardware: the hardware-only cache
//   key suffix keeps the results apart.

/// GPU_ENCODERS from v1 gpuEncoders.ts: single source of truth for encoder
/// names shared by the capability probe and preset construction.
pub(crate) fn resolve_encoder(codec: GpuCodec, gpu: GpuVendor, platform: &str) -> String {
    use GpuCodec as C;
    use GpuVendor as V;
    if uses_vaapi(gpu, platform) {
        // Linux Intel and AMD encode through VAAPI instead of QSV or AMF.
        return match codec {
            C::H264 => "h264_vaapi",
            C::H265 => "hevc_vaapi",
            C::Av1 => "av1_vaapi",
        }
        .to_string();
    }
    match (codec, gpu) {
        (C::H264, V::Nvidia) => "h264_nvenc",
        (C::H264, V::Amd) => "h264_amf",
        (C::H264, V::Intel) => "h264_qsv",
        (C::H264, V::Qualcomm) => "h264_mf",
        (C::H264, V::Apple) => "h264_videotoolbox",
        (C::H264, V::Cpu) => "libx264",
        (C::H265, V::Nvidia) => "hevc_nvenc",
        (C::H265, V::Amd) => "hevc_amf",
        (C::H265, V::Intel) => "hevc_qsv",
        (C::H265, V::Qualcomm) => "hevc_mf",
        (C::H265, V::Apple) => "hevc_videotoolbox",
        (C::H265, V::Cpu) => "libx265",
        (C::Av1, V::Nvidia) => "av1_nvenc",
        (C::Av1, V::Amd) => "av1_amf",
        (C::Av1, V::Intel) => "av1_qsv",
        (C::Av1, V::Qualcomm) => "av1_mf",
        // Apple has no AV1 hardware encoder; v1 maps it to the CPU encoder.
        (C::Av1, V::Apple) => "libsvtav1",
        (C::Av1, V::Cpu) => "libsvtav1",
    }
    .to_string()
}

pub(crate) fn uses_vaapi(gpu: GpuVendor, platform: &str) -> bool {
    platform == "linux" && matches!(gpu, GpuVendor::Intel | GpuVendor::Amd)
}

/// Qualcomm's Media Foundation encoders exist only on Windows on Arm.
pub(crate) fn supports_qualcomm(platform: &str, arch: &str) -> bool {
    platform == "win32" && arch == "arm64"
}

pub(crate) fn gpu_name(gpu: GpuVendor) -> &'static str {
    match gpu {
        GpuVendor::Nvidia => "NVIDIA",
        GpuVendor::Amd => "AMD",
        GpuVendor::Intel => "Intel",
        GpuVendor::Qualcomm => "Qualcomm",
        GpuVendor::Apple => "Apple",
        GpuVendor::Cpu => "CPU",
    }
}

pub(crate) fn codec_name(codec: GpuCodec) -> &'static str {
    match codec {
        GpuCodec::H264 => "H.264",
        GpuCodec::H265 => "H.265/HEVC",
        GpuCodec::Av1 => "AV1",
    }
}

/// v1's HwProbeOptions: extra args placed before/after the lavfi input, plus
/// the cache key (defaults to the encoder name).
#[derive(Default)]
pub(crate) struct HwProbeOptions {
    input_args: Vec<String>,
    output_args: Vec<String>,
    cache_key: Option<String>,
}

/// Middle of the H.264/HEVC VAAPI CQP range; AV1 uses the 1..255 scale.
const VAAPI_PROBE_QP: u32 = 23;

fn vaapi_probe_global_quality(encoder: &str) -> u32 {
    if encoder == "av1_vaapi" {
        (VAAPI_PROBE_QP * 4).min(255)
    } else {
        VAAPI_PROBE_QP
    }
}

/// Probe options for a VAAPI encoder bound to one render node.
fn vaapi_probe_options(encoder: &str, render_node: &str) -> HwProbeOptions {
    HwProbeOptions {
        input_args: vec!["-vaapi_device".to_string(), render_node.to_string()],
        // Mirrors the conversion's -rc_mode CQP, so a pass means the driver
        // accepts it.
        output_args: vec![
            "-vf".to_string(),
            "format=nv12,hwupload".to_string(),
            "-rc_mode".to_string(),
            "CQP".to_string(),
            "-global_quality".to_string(),
            vaapi_probe_global_quality(encoder).to_string(),
        ],
        // Suffix keeps probe results from the old default-RC probe out of the
        // cache.
        cache_key: Some(format!("{encoder}@{render_node}#cqp")),
    }
}

/// Probe options for a Media Foundation encoder: NV12 hardware output, under
/// its own cache key so a software MFT result never answers for the hardware
/// encoder.
fn qualcomm_probe_options(encoder: &str) -> HwProbeOptions {
    HwProbeOptions {
        input_args: Vec::new(),
        output_args: vec![
            "-pix_fmt".to_string(),
            "nv12".to_string(),
            "-hw_encoding".to_string(),
            "1".to_string(),
            "-rate_control".to_string(),
            "quality".to_string(),
            "-quality".to_string(),
            "50".to_string(),
        ],
        cache_key: Some(format!("{encoder}@hw")),
    }
}

/// v1's buildHwProbeArgs (ffmpeg.ts): a one-frame black lavfi encode.
fn build_hw_probe_args(encoder: &str, options: &HwProbeOptions, platform: &str) -> Vec<String> {
    let sink = if platform == "win32" {
        "NUL"
    } else {
        "/dev/null"
    };
    let mut args: Vec<&str> = vec!["-hide_banner", "-loglevel", "error"];
    args.extend(options.input_args.iter().map(String::as_str));
    args.extend([
        "-f",
        "lavfi",
        "-i",
        "color=black:s=256x256:d=0.04:r=25,format=yuv420p",
        "-frames:v",
        "1",
    ]);
    args.extend(options.output_args.iter().map(String::as_str));
    args.extend(["-c:v", encoder, "-f", "null", sink]);
    args.into_iter().map(str::to_string).collect()
}

/// Lowest-numbered /dev/dri/renderD* node owned by the vendor. A node whose
/// vendor file cannot be read is skipped.
pub(crate) fn find_vaapi_render_node(gpu: GpuVendor) -> Option<String> {
    find_vaapi_render_node_in(Path::new(DRM_DIR), gpu)
}

fn find_vaapi_render_node_in(dir: &Path, gpu: GpuVendor) -> Option<String> {
    let expected = match gpu {
        GpuVendor::Intel => INTEL_VENDOR_ID,
        GpuVendor::Amd => AMD_VENDOR_ID,
        _ => return None,
    };
    let entries = std::fs::read_dir(dir).ok()?;
    let mut nodes: Vec<(u32, String)> = entries
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().to_string_lossy().to_string();
            let number = name.strip_prefix("renderD")?.parse::<u32>().ok()?;
            Some((number, name))
        })
        .collect();
    nodes.sort_by_key(|(number, _)| *number);
    for (_, name) in nodes {
        let vendor = std::fs::read_to_string(dir.join(&name).join("device").join("vendor"));
        if let Ok(vendor) = vendor {
            if vendor.trim().to_lowercase() == expected {
                return Some(format!("/dev/dri/{name}"));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Caches: session memory plus the fingerprinted disk store (v1 hwProbeStore).
// ---------------------------------------------------------------------------

static HW_MEMORY_CACHE: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());
static HW_DISK_CACHE: Mutex<Option<HwDiskCache>> = Mutex::new(None);
static ENCODER_CACHE: Mutex<Option<(String, Arc<BTreeSet<String>>)>> = Mutex::new(None);

/// v1's binaryFingerprint: platform-arch, app version, path, size, mtime.
fn binary_fingerprint(path: &Path, app_version: &str) -> String {
    let base = format!(
        "{}-{}|{}|{}",
        node_platform(),
        node_arch(),
        app_version,
        path.display()
    );
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            format!("{base}|{}|{}", meta.len(), mtime)
        }
        Err(_) => base,
    }
}

struct HwDiskCache {
    path: PathBuf,
    fingerprint: String,
    saved_at: u64,
    /// Only positives persist (negatives are session-only in v1).
    results: BTreeMap<String, bool>,
}

impl HwDiskCache {
    /// v1's readResults: a wrong version, fingerprint, or TTL expiry starts
    /// fresh; only `true` entries are trusted from older files.
    fn load(path: PathBuf, fingerprint: String, now: u64) -> Self {
        let loaded = (|| {
            let meta = std::fs::metadata(&path).ok()?;
            if meta.len() > HW_CACHE_READ_LIMIT {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            let parsed: HwProbeCacheFile = serde_json::from_str(&text).ok()?;
            if parsed.version != HW_PROBE_CACHE_VERSION || parsed.fingerprint != fingerprint {
                return None;
            }
            if now.saturating_sub(parsed.saved_at) > HW_CACHE_TTL_MS {
                return None;
            }
            Some((parsed.saved_at, parsed.results))
        })();
        match loaded {
            Some((saved_at, results)) => Self {
                path,
                fingerprint,
                saved_at,
                results: results.into_iter().filter(|(_, value)| *value).collect(),
            },
            None => Self {
                path,
                fingerprint,
                saved_at: now,
                results: BTreeMap::new(),
            },
        }
    }

    fn get(&self, key: &str) -> Option<bool> {
        self.results.get(key).copied()
    }

    /// v1's set: unavailable drops any persisted known-good entry; available
    /// records a positive and re-anchors the TTL on an empty store.
    fn set(&mut self, key: &str, available: bool, now: u64) {
        if !available {
            if self.results.remove(key).is_some() {
                self.persist();
            }
            return;
        }
        if self.results.is_empty() {
            self.saved_at = now;
        }
        self.results.insert(key.to_string(), true);
        self.persist();
    }

    fn persist(&self) {
        let payload = HwProbeCacheFile {
            version: HW_PROBE_CACHE_VERSION,
            fingerprint: self.fingerprint.clone(),
            saved_at: self.saved_at,
            results: self.results.clone(),
        };
        match serde_json::to_vec(&payload) {
            Ok(bytes) => {
                if let Err(error) = fs_util::atomic_write(&self.path, &bytes) {
                    crate::logging::warn(&format!(
                        "Could not persist the GPU probe cache: {error}"
                    ));
                }
            }
            Err(error) => {
                crate::logging::warn(&format!("Could not encode the GPU probe cache: {error}"));
            }
        }
    }

    fn clear(&mut self, now: u64) {
        self.results.clear();
        self.saved_at = now;
        let _ = std::fs::remove_file(&self.path);
    }
}

fn with_disk_cache<R>(operation: impl FnOnce(&mut HwDiskCache) -> R) -> R {
    let mut guard = HW_DISK_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        let path = crate::app_state::data_dir().join(HW_CACHE_FILE);
        let fingerprint = binary_fingerprint(
            &crate::ffmpeg_status::bundled_ffmpeg(),
            env!("CARGO_PKG_VERSION"),
        );
        *guard = Some(HwDiskCache::load(
            path,
            fingerprint,
            crate::app_state::now_ms(),
        ));
    }
    operation(guard.as_mut().expect("the cache was just initialized"))
}

/// v1's `-encoders -hide_banner` listing line parser: flags, whitespace, name.
fn parse_encoder_line(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let mut flags_end = 0;
    for (index, character) in trimmed.char_indices() {
        if matches!(character, 'V' | 'A' | 'S' | 'F' | 'X' | 'B' | 'D' | '.') {
            flags_end = index + character.len_utf8();
        } else {
            break;
        }
    }
    if flags_end == 0 {
        return None;
    }
    let rest = trimmed[flags_end..].strip_prefix(char::is_whitespace)?;
    rest.split_whitespace().next().map(str::to_string)
}

/// Cached `ffmpeg -encoders` names (v1 getAvailableEncoders). None means the
/// listing failed and the next call retries; an empty set is cached, exactly
/// like v1's close handler.
fn list_encoders(ffmpeg: &Path) -> Option<Arc<BTreeSet<String>>> {
    let identity = match std::fs::metadata(ffmpeg) {
        Ok(meta) => format!("{}|{}|{:?}", ffmpeg.display(), meta.len(), meta.modified()),
        Err(_) => format!("{}|absent", ffmpeg.display()),
    };
    let mut cache = ENCODER_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached_identity, cached)) = cache.as_ref() {
        if *cached_identity == identity {
            return Some(Arc::clone(cached));
        }
    }
    let args = ["-encoders".to_string(), "-hide_banner".to_string()];
    let mut command = process_util::command(ffmpeg, &args, &[], true);
    match process_util::run_with_timeout(&mut command, ENCODER_LIST_TIMEOUT, 512 * 1024, 4096) {
        Ok(output) if !output.timed_out => {
            let encoders: BTreeSet<String> = output
                .stdout
                .lines()
                .filter_map(parse_encoder_line)
                .collect();
            let encoders = Arc::new(encoders);
            *cache = Some((identity, Arc::clone(&encoders)));
            Some(encoders)
        }
        Ok(_) => None,
        Err(_) => None,
    }
}

struct ProbeContext {
    ffmpeg: PathBuf,
    status_ok: bool,
    encoders: Arc<BTreeSet<String>>,
}

/// v1's probeHwEncoderAvailable: memory cache, disk store, listing check,
/// then a one-frame synthetic encode with an 8s timeout. Exit codes persist
/// (true and false); timeouts and spawn errors stay session-only.
fn probe_hw_encoder_available(ctx: &ProbeContext, encoder: &str, options: &HwProbeOptions) -> bool {
    // Failure mode: a probe that fails because the binary is not ok must not
    // be cached as "absent".
    if !ctx.status_ok {
        return false;
    }
    let key = options
        .cache_key
        .clone()
        .unwrap_or_else(|| encoder.to_string());
    if let Some(cached) = HW_MEMORY_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .copied()
    {
        return cached;
    }
    if let Some(stored) = with_disk_cache(|cache| cache.get(&key)) {
        HW_MEMORY_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key.clone(), stored);
        return stored;
    }
    if !ctx.encoders.contains(encoder) {
        HW_MEMORY_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, false);
        return false;
    }
    let args = build_hw_probe_args(encoder, options, node_platform());
    let mut command = process_util::command(&ctx.ffmpeg, &args, &[], true);
    match process_util::run_with_timeout(&mut command, HW_PROBE_TIMEOUT, 4096, 4096) {
        Ok(output) if !output.timed_out => {
            let available = output.code == Some(0);
            // Only a real exit code is worth keeping across launches;
            // timeouts may be transient.
            with_disk_cache(|cache| cache.set(&key, available, crate::app_state::now_ms()));
            HW_MEMORY_CACHE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(key, available);
            available
        }
        Ok(_) => {
            HW_MEMORY_CACHE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(key, false);
            false
        }
        Err(error) => {
            crate::logging::warn(&format!("Failed to spawn GPU probe ({encoder}): {error}"));
            HW_MEMORY_CACHE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(key, false);
            false
        }
    }
}

/// v1's clearHwProbeResults: forget probe results in memory and on disk.
fn clear_hw_probe_results() {
    HW_MEMORY_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    with_disk_cache(|cache| cache.clear(crate::app_state::now_ms()));
}

// ---------------------------------------------------------------------------
// Matrix assembly (v1 gpuCapabilities.ts).
// ---------------------------------------------------------------------------

type ProbeFn = Arc<dyn Fn(GpuCodec, GpuVendor, &str, &HwProbeOptions) -> bool + Send + Sync>;
type RenderNodeFn = Arc<dyn Fn(GpuVendor) -> Option<String> + Send + Sync>;

/// Vendor rows decided without a probe, in v1's check order. The encoder
/// field always names the vendor's encoder, even for the unavailable rows.
fn cheap_vendor_status(
    codec: GpuCodec,
    vendor: GpuVendor,
    platform: &str,
    arch: &str,
) -> Option<GPUCapabilityStatus> {
    Some(match vendor {
        GpuVendor::Cpu => GPUCapabilityStatus {
            available: true,
            reason: "Software encoding fallback.".to_string(),
            encoder: resolve_encoder(codec, GpuVendor::Cpu, platform),
        },
        GpuVendor::Apple if platform != "darwin" => GPUCapabilityStatus {
            available: false,
            reason: "Apple VideoToolbox available only on macOS.".to_string(),
            encoder: resolve_encoder(codec, GpuVendor::Apple, platform),
        },
        GpuVendor::Qualcomm if !supports_qualcomm(platform, arch) => GPUCapabilityStatus {
            available: false,
            reason: "Qualcomm Media Foundation available only on Windows on Arm.".to_string(),
            encoder: resolve_encoder(codec, GpuVendor::Qualcomm, platform),
        },
        GpuVendor::Apple if codec == GpuCodec::Av1 => GPUCapabilityStatus {
            available: false,
            reason: "Apple AV1 hardware encode unavailable. Use CPU for AV1.".to_string(),
            encoder: resolve_encoder(codec, GpuVendor::Apple, platform),
        },
        _ => return None,
    })
}

/// The probe-backed vendor row (v1 checkGPUEncoderSupport, minus the
/// qualcomm platform gate the matrix builder already applied).
fn probe_vendor_status(
    codec: GpuCodec,
    vendor: GpuVendor,
    platform: &str,
    probe: &ProbeFn,
    render_node: &RenderNodeFn,
) -> GPUCapabilityStatus {
    let encoder = resolve_encoder(codec, vendor, platform);
    let mut options = HwProbeOptions::default();
    if uses_vaapi(vendor, platform) {
        // Without a render node the conversion falls back to CPU, the same
        // as an unsupported GPU.
        let Some(node) = render_node(vendor) else {
            return GPUCapabilityStatus {
                available: false,
                reason: format!("No {} render node found", gpu_name(vendor)),
                encoder,
            };
        };
        options = vaapi_probe_options(&encoder, &node);
    } else if vendor == GpuVendor::Qualcomm {
        options = qualcomm_probe_options(&encoder);
    }
    let available = probe(codec, vendor, &encoder, &options);
    GPUCapabilityStatus {
        available,
        reason: if available {
            "Available".to_string()
        } else {
            format!(
                "{} {} encoder not available",
                gpu_name(vendor),
                codec_name(codec)
            )
        },
        encoder,
    }
}

/// v1's recommendGpuVendorFromAvailability priority lists.
const DARWIN_VENDOR_PRIORITY: [GpuVendor; 5] = [
    GpuVendor::Apple,
    GpuVendor::Intel,
    GpuVendor::Amd,
    GpuVendor::Nvidia,
    GpuVendor::Cpu,
];
const DEFAULT_VENDOR_PRIORITY: [GpuVendor; 6] = [
    GpuVendor::Nvidia,
    GpuVendor::Intel,
    GpuVendor::Amd,
    GpuVendor::Qualcomm,
    GpuVendor::Apple,
    GpuVendor::Cpu,
];

fn recommend_gpu_vendor_from_availability(
    platform: &str,
    available: impl Fn(GpuVendor) -> bool,
) -> (GpuVendor, String) {
    let priority = if platform == "darwin" {
        &DARWIN_VENDOR_PRIORITY[..]
    } else {
        &DEFAULT_VENDOR_PRIORITY[..]
    };
    for vendor in priority {
        if available(*vendor) {
            if *vendor == GpuVendor::Cpu {
                return (
                    GpuVendor::Cpu,
                    "No compatible GPU encoder found. Using CPU.".to_string(),
                );
            }
            return (
                *vendor,
                format!("Best available path: {}.", vendor.as_str()),
            );
        }
    }
    (
        GpuVendor::Cpu,
        "No compatible GPU encoder found. Using CPU.".to_string(),
    )
}

fn get_recommended_vendor(
    platform: &str,
    requested_codec: Option<GpuCodec>,
    matrix: &BTreeMap<String, BTreeMap<String, GPUCapabilityStatus>>,
) -> (GpuVendor, String) {
    let Some(codec) = requested_codec else {
        return (
            GpuVendor::Cpu,
            "Preset does not use GPU-accelerated video encoding.".to_string(),
        );
    };
    let Some(row) = matrix.get(codec.as_str()) else {
        return (
            GpuVendor::Cpu,
            "Capability data unavailable. Falling back to CPU.".to_string(),
        );
    };
    recommend_gpu_vendor_from_availability(platform, |vendor| {
        row.get(vendor.as_str())
            .is_some_and(|status| status.available)
    })
}

/// buildGpuCapabilitiesPayload with injectable probes (tests fake them).
fn build_payload_with(
    requested_codec: Option<GpuCodec>,
    platform: &str,
    arch: &str,
    probe: &ProbeFn,
    render_node: &RenderNodeFn,
) -> GPUCapabilitiesPayload {
    let codecs_to_check: Vec<GpuCodec> =
        requested_codec.map(|codec| vec![codec]).unwrap_or_else(|| {
            GpuCodec::NAMES
                .iter()
                .copied()
                .filter_map(GpuCodec::parse)
                .collect()
        });
    let vendors: Vec<GpuVendor> = GpuVendor::NAMES
        .iter()
        .copied()
        .filter_map(GpuVendor::parse)
        .collect();
    let mut matrix: BTreeMap<String, BTreeMap<String, GPUCapabilityStatus>> = BTreeMap::new();
    for codec in &codecs_to_check {
        let codec = *codec;
        let mut row: BTreeMap<String, GPUCapabilityStatus> = BTreeMap::new();
        // v1 ran every vendor check concurrently; only the probe-backed
        // vendors need a thread here.
        let mut probes: Vec<(GpuVendor, std::thread::JoinHandle<GPUCapabilityStatus>)> = Vec::new();
        for vendor in &vendors {
            let vendor = *vendor;
            if let Some(status) = cheap_vendor_status(codec, vendor, platform, arch) {
                row.insert(vendor.as_str().to_string(), status);
                continue;
            }
            let probe = Arc::clone(probe);
            let render_node = Arc::clone(render_node);
            let platform = platform.to_string();
            probes.push((
                vendor,
                std::thread::spawn(move || {
                    probe_vendor_status(codec, vendor, &platform, &probe, &render_node)
                }),
            ));
        }
        for (vendor, probe) in probes {
            let status = probe.join().unwrap_or_else(|_| GPUCapabilityStatus {
                available: false,
                reason: "Probe thread panicked.".to_string(),
                encoder: resolve_encoder(codec, vendor, platform),
            });
            row.insert(vendor.as_str().to_string(), status);
        }
        matrix.insert(codec.as_str().to_string(), row);
    }
    let (recommended_vendor, recommendation_reason) =
        get_recommended_vendor(platform, requested_codec, &matrix);
    GPUCapabilitiesPayload {
        platform: platform.to_string(),
        requested_codec,
        checked_codecs: codecs_to_check,
        matrix,
        recommended_vendor,
        recommendation_reason,
    }
}

/// The real payload: status-gated, listing-aware probes over the bundled
/// sidecar, with both caches.
fn build_gpu_capabilities_payload(requested_codec: Option<GpuCodec>) -> GPUCapabilitiesPayload {
    let ffmpeg = crate::ffmpeg_status::bundled_ffmpeg();
    let status_ok = crate::ffmpeg_status::current_status().ok;
    let encoders = if status_ok {
        list_encoders(&ffmpeg).unwrap_or_default()
    } else {
        // A listing that fails because the binary is not ok must not be
        // cached as "absent"; the status gate answers first.
        Arc::new(BTreeSet::new())
    };
    let ctx = Arc::new(ProbeContext {
        ffmpeg,
        status_ok,
        encoders,
    });
    let probe: ProbeFn = Arc::new(move |_codec, _vendor, encoder, options| {
        probe_hw_encoder_available(&ctx, encoder, options)
    });
    let render_node: RenderNodeFn = Arc::new(find_vaapi_render_node);
    build_payload_with(
        requested_codec,
        node_platform(),
        node_arch(),
        &probe,
        &render_node,
    )
}

/// v1's get-gpu-capabilities: `requestedCodec` is `h264` | `h265` | `av1`,
/// and any other value means "probe every codec".
#[tauri::command]
pub async fn get_gpu_capabilities(
    requested_codec: Option<FalliblePayload<String>>,
) -> IpcResult<GPUCapabilitiesPayload> {
    let codec = match requested_codec {
        Some(payload) => match payload.into_typed(VALIDATION_ERROR, "Invalid GPU codec request.") {
            Ok(text) => GpuCodec::parse(&text),
            Err(error) => return ipc::from_error(error),
        },
        None => None,
    };
    match tauri::async_runtime::spawn_blocking(move || build_gpu_capabilities_payload(codec)).await
    {
        Ok(payload) => ipc::ok(payload),
        Err(error) => ipc::err(INTERNAL_ERROR, error.to_string()),
    }
}

/// v1's refresh-gpu-capabilities: clears the cached probe results only.
#[tauri::command(async)]
pub fn refresh_gpu_capabilities() -> IpcResult<()> {
    clear_hw_probe_results();
    ipc::ok(())
}

// ---------------------------------------------------------------------------
// Conversion-facing checks: encoder gate, hardware decode, tone-map support,
// and GPU error classification (v1 ffmpeg.ts).
// ---------------------------------------------------------------------------

pub(crate) struct EncoderSupport {
    pub available: bool,
    pub encoder: String,
    pub error: Option<GPUEncoderError>,
}

fn encoder_unavailable(
    message: String,
    details: String,
    suggestion: String,
    codec: GpuCodec,
    gpu: GpuVendor,
) -> EncoderSupport {
    let encoder = resolve_encoder(codec, gpu, node_platform());
    EncoderSupport {
        available: false,
        error: Some(GPUEncoderError {
            kind: "encoder_unavailable".to_string(),
            message,
            details,
            suggestion,
            can_retry_with_cpu: true,
            codec: Some(codec.as_str().to_string()),
            gpu: Some(gpu),
        }),
        encoder,
    }
}

fn probe_context() -> ProbeContext {
    let status_ok = crate::ffmpeg_status::current_status().ok;
    let ffmpeg = crate::ffmpeg_status::bundled_ffmpeg();
    let encoders = if status_ok {
        list_encoders(&ffmpeg).unwrap_or_default()
    } else {
        Arc::new(BTreeSet::new())
    };
    ProbeContext {
        ffmpeg,
        status_ok,
        encoders,
    }
}

/// v1 checkGPUEncoderSupport: platform gates, VAAPI render node, then a probe.
/// Cancellation is only observed between probes; an in-flight probe is bounded
/// by its own 8s timeout.
pub(crate) fn check_encoder_support(
    gpu: GpuVendor,
    codec: GpuCodec,
    cancelled: &AtomicBool,
) -> EncoderSupport {
    let platform = node_platform();
    if gpu == GpuVendor::Cpu {
        return EncoderSupport {
            available: true,
            encoder: resolve_encoder(codec, gpu, platform),
            error: None,
        };
    }
    if gpu == GpuVendor::Qualcomm && !supports_qualcomm(platform, node_arch()) {
        return encoder_unavailable(
            format!(
                "Qualcomm {} encoder requires Windows on Arm",
                codec_name(codec)
            ),
            "Qualcomm Media Foundation encoders run only on Windows on Arm (Snapdragon) devices."
                .to_string(),
            "Choose another GPU vendor, or use CPU encoding.".to_string(),
            codec,
            gpu,
        );
    }
    let mut options = HwProbeOptions::default();
    if uses_vaapi(gpu, platform) {
        let Some(node) = find_vaapi_render_node(gpu) else {
            return encoder_unavailable(
                format!("No {} render node found", gpu_name(gpu)),
                format!(
                    "{} GPUs encode through VAAPI, which needs a /dev/dri/renderD* node. None was found under /sys/class/drm.",
                    gpu_name(gpu)
                ),
                "Install the VA-API driver for your GPU, or use CPU encoding.".to_string(),
                codec,
                gpu,
            );
        };
        options = vaapi_probe_options(&resolve_encoder(codec, gpu, platform), &node);
    } else if gpu == GpuVendor::Qualcomm {
        options = qualcomm_probe_options(&resolve_encoder(codec, gpu, platform));
    }
    let encoder = resolve_encoder(codec, gpu, platform);
    if encoder.is_empty() {
        return encoder_unavailable(
            format!("No {} encoder for {}", codec_name(codec), gpu_name(gpu)),
            format!(
                "The selected GPU vendor does not have a {} encoder configured.",
                codec.as_str()
            ),
            "Try using CPU encoding instead.".to_string(),
            codec,
            gpu,
        );
    }
    if !cancelled.load(Ordering::SeqCst)
        && probe_hw_encoder_available(&probe_context(), &encoder, &options)
    {
        return EncoderSupport {
            available: true,
            encoder,
            error: None,
        };
    }
    let suggestion = if gpu == GpuVendor::Nvidia && codec == GpuCodec::Av1 {
        "AV1 encoding requires an RTX 40-series GPU or newer. Try H.264 or H.265 instead, or use CPU encoding.".to_string()
    } else {
        format!(
            "Try using CPU encoding, or ensure your {} drivers are up to date.",
            gpu_name(gpu)
        )
    };
    let mut support = encoder_unavailable(
        format!("{} {} encoder not available", gpu_name(gpu), codec_name(codec)),
        format!(
            "The encoder \"{encoder}\" could not initialise on this system. This could mean:\n• No compatible {} hardware was detected\n• Your GPU drivers don't support this codec\n• FFmpeg wasn't compiled with {} support\n• The required libraries are missing",
            gpu_name(gpu),
            gpu_name(gpu)
        ),
        suggestion,
        codec,
        gpu,
    );
    support.encoder = encoder;
    support
}

// ---------------------------------------------------------------------------
// Hardware decoders (v1 getHardwareDecodeArgs).
// ---------------------------------------------------------------------------

static DECODER_CACHE: Mutex<Option<(String, Arc<BTreeSet<String>>)>> = Mutex::new(None);

fn list_decoders(ffmpeg: &Path) -> Option<Arc<BTreeSet<String>>> {
    let identity = match std::fs::metadata(ffmpeg) {
        Ok(meta) => format!("{}|{}|{:?}", ffmpeg.display(), meta.len(), meta.modified()),
        Err(_) => format!("{}|absent", ffmpeg.display()),
    };
    let mut cache = DECODER_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached_identity, cached)) = cache.as_ref() {
        if *cached_identity == identity {
            return Some(Arc::clone(cached));
        }
    }
    let args = ["-decoders".to_string(), "-hide_banner".to_string()];
    let mut command = process_util::command(ffmpeg, &args, &[], true);
    match process_util::run_with_timeout(&mut command, ENCODER_LIST_TIMEOUT, 512 * 1024, 4096) {
        Ok(output) if !output.timed_out => {
            let decoders: BTreeSet<String> = output
                .stdout
                .lines()
                .filter_map(parse_encoder_line)
                .collect();
            let decoders = Arc::new(decoders);
            *cache = Some((identity, Arc::clone(&decoders)));
            Some(decoders)
        }
        _ => None,
    }
}

fn decoder_for(gpu: GpuVendor, codec: &str) -> Option<&'static str> {
    let table: &[(&str, &str)] = match gpu {
        GpuVendor::Nvidia => &[
            ("h264", "h264_cuvid"),
            ("hevc", "hevc_cuvid"),
            ("h265", "hevc_cuvid"),
            ("av1", "av1_cuvid"),
            ("vp9", "vp9_cuvid"),
            ("mpeg2video", "mpeg2_cuvid"),
            ("mpeg4", "mpeg4_cuvid"),
        ],
        GpuVendor::Intel => &[
            ("h264", "h264_qsv"),
            ("hevc", "hevc_qsv"),
            ("h265", "hevc_qsv"),
            ("av1", "av1_qsv"),
            ("vp9", "vp9_qsv"),
        ],
        GpuVendor::Amd => &[
            ("h264", "h264_d3d11va"),
            ("hevc", "hevc_d3d11va"),
            ("h265", "hevc_d3d11va"),
            ("av1", "av1_d3d11va"),
            ("vp9", "vp9_d3d11va"),
        ],
        GpuVendor::Apple => &[
            ("h264", "h264_videotoolbox"),
            ("hevc", "hevc_videotoolbox"),
            ("h265", "hevc_videotoolbox"),
        ],
        _ => &[],
    };
    table
        .iter()
        .find(|(name, _)| *name == codec)
        .map(|(_, decoder)| *decoder)
}

fn decoder_listed(decoder: &str) -> bool {
    crate::ffmpeg_status::current_status().ok
        && list_decoders(&crate::ffmpeg_status::bundled_ffmpeg())
            .is_some_and(|decoders| decoders.contains(decoder))
}

/// v1 getHardwareDecodeArgs: the decode prefix for a conversion, or empty.
pub(crate) fn hardware_decode_args(gpu: GpuVendor, codec: Option<&str>) -> Vec<String> {
    let platform = node_platform();
    if gpu == GpuVendor::Cpu || gpu == GpuVendor::Qualcomm {
        return Vec::new();
    }
    let Some(codec) = codec.map(str::to_lowercase) else {
        return Vec::new();
    };
    let codec = if codec == "h265" {
        "hevc".to_string()
    } else {
        codec
    };
    let Some(decoder) = decoder_for(gpu, &codec) else {
        return Vec::new();
    };
    let args: &[&str] = if platform == "darwin" {
        if gpu != GpuVendor::Apple {
            return Vec::new();
        }
        &["-hwaccel", "videotoolbox", "-c:v", decoder]
    } else if platform == "win32" {
        match gpu {
            GpuVendor::Nvidia => &[
                "-hwaccel",
                "cuda",
                "-hwaccel_output_format",
                "cuda",
                "-c:v",
                decoder,
            ],
            GpuVendor::Intel => &[
                "-hwaccel",
                "qsv",
                "-hwaccel_output_format",
                "qsv",
                "-c:v",
                decoder,
            ],
            GpuVendor::Amd => &[
                "-hwaccel",
                "d3d11va",
                "-hwaccel_output_format",
                "d3d11",
                "-c:v",
                decoder,
            ],
            _ => return Vec::new(),
        }
    } else if platform == "linux" && gpu == GpuVendor::Nvidia {
        &[
            "-hwaccel",
            "cuda",
            "-hwaccel_output_format",
            "cuda",
            "-c:v",
            decoder,
        ]
    } else {
        return Vec::new();
    };
    if !decoder_listed(decoder) {
        return Vec::new();
    }
    args.iter().map(|arg| arg.to_string()).collect()
}

// ---------------------------------------------------------------------------
// Tone-map support (v1 canTonemapHdr).
// ---------------------------------------------------------------------------

static FILTER_CACHE: Mutex<Option<Arc<BTreeSet<String>>>> = Mutex::new(None);

fn list_filters(ffmpeg: &Path) -> Arc<BTreeSet<String>> {
    if let Some(cached) = FILTER_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
    {
        return Arc::clone(cached);
    }
    let args = ["-hide_banner".to_string(), "-filters".to_string()];
    let mut command = process_util::command(ffmpeg, &args, &[], true);
    let filters =
        match process_util::run_with_timeout(&mut command, ENCODER_LIST_TIMEOUT, 1024 * 1024, 4096)
        {
            Ok(output) if !output.timed_out => {
                let regex =
                    Regex::new(r"^\s*[TSC.|]{2,3}\s+(\S+)\s+\S+->\S+").expect("valid regex");
                let names: BTreeSet<String> = output
                    .stdout
                    .lines()
                    .filter_map(|line| regex.captures(line))
                    .filter_map(|captures| captures.get(1))
                    .map(|value| value.as_str().to_string())
                    .collect();
                Arc::new(names)
            }
            _ => Arc::new(BTreeSet::new()),
        };
    if !filters.is_empty() {
        *FILTER_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&filters));
    }
    filters
}

pub(crate) fn can_tonemap_hdr() -> bool {
    if !crate::ffmpeg_status::current_status().ok {
        return false;
    }
    let filters = list_filters(&crate::ffmpeg_status::bundled_ffmpeg());
    filters.contains("zscale") && filters.contains("tonemap")
}

// ---------------------------------------------------------------------------
// GPU error classification (v1 parseGPUError).
// ---------------------------------------------------------------------------

fn mf_failure_pattern() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"could not find any MFT|could not (?:set|get) (?:input|output) type|format negotiation failed|hardware MFT is not async|could not start stream|Failed to set D3D manager|mfplat\.dll")
            .expect("valid regex")
    })
}

fn vaapi_failure_pattern() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"Failed to initialise VAAPI connection|vaInitialize failed|No VA display found|Failed to create a VAAPI device|libva[^\n]*cannot open shared object")
            .expect("valid regex")
    })
}

fn vaapi_runtime_failure_pattern() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)No usable encoding profile found|Driver does not support[^\n]*(?:RC|rate control) mode|Failed to (?:upload|create) (?:[a-z0-9_.]+ ){0,2}(?:surface|context|buffer|image|frame)|va(?:Create\w*|BeginPicture|RenderPicture|EndPicture)[^\n]*fail")
            .expect("valid regex")
    })
}

fn gpu_error(
    kind: &str,
    message: String,
    details: String,
    suggestion: String,
    codec: Option<GpuCodec>,
    gpu: GpuVendor,
) -> GPUEncoderError {
    GPUEncoderError {
        kind: kind.to_string(),
        message,
        details,
        suggestion,
        can_retry_with_cpu: true,
        codec: codec.map(|codec| codec.as_str().to_string()),
        gpu: Some(gpu),
    }
}

/// v1 parseGPUError: classifies a failed conversion's stderr tail.
pub(crate) fn parse_gpu_error(
    error_output: &str,
    gpu: GpuVendor,
    codec: Option<GpuCodec>,
) -> Option<GPUEncoderError> {
    let platform = node_platform();
    let gpu_label = gpu_name(gpu);
    let codec_label = codec.map(codec_name).unwrap_or("video");
    let vaapi_platform = uses_vaapi(gpu, platform);
    if gpu == GpuVendor::Nvidia {
        if error_output.contains("No capable devices found")
            || error_output.contains("Cannot load nvEncodeAPI")
            || error_output.contains("nvEncodeAPICreateInstance failed")
        {
            return Some(gpu_error(
                "gpu_capability",
                format!("{gpu_label} encoder initialization failed"),
                "FFmpeg could not initialize the NVIDIA encoder. This usually means:\n• Your GPU doesn't support hardware encoding\n• NVIDIA drivers are not installed or outdated\n• Another application is using the encoder".to_string(),
                "Update your NVIDIA drivers or try CPU encoding.".to_string(),
                codec,
                gpu,
            ));
        }
        if error_output.contains("not capable") || error_output.contains("unsupported") {
            return Some(gpu_error(
                "gpu_capability",
                format!("Your {gpu_label} GPU doesn't support {codec_label} encoding"),
                if codec == Some(GpuCodec::Av1) {
                    "AV1 hardware encoding requires an RTX 40-series (Ada Lovelace) GPU or newer."
                        .to_string()
                } else {
                    format!("Your GPU model doesn't support hardware {codec_label} encoding.")
                },
                if codec == Some(GpuCodec::Av1) {
                    "Use H.264 or H.265 for hardware encoding, or switch to CPU for AV1."
                        .to_string()
                } else {
                    "Try using CPU encoding instead.".to_string()
                },
                codec,
                gpu,
            ));
        }
    }
    if matches!(gpu, GpuVendor::Intel | GpuVendor::Amd)
        && vaapi_failure_pattern().is_match(error_output)
    {
        let driver = if gpu == GpuVendor::Intel {
            "intel-media-va-driver (or intel-media-driver)"
        } else {
            "mesa-va-drivers"
        };
        return Some(gpu_error(
            "gpu_capability",
            format!("{gpu_label} VAAPI encoder initialization failed"),
            format!(
                "FFmpeg could not open the VA-API driver for the {gpu_label} GPU. Install {driver} and libva2, then restart CONV2."
            ),
            format!("Install {driver} and libva2, or use CPU encoding."),
            codec,
            gpu,
        ));
    }
    if matches!(gpu, GpuVendor::Intel | GpuVendor::Amd)
        && vaapi_runtime_failure_pattern().is_match(error_output)
    {
        return Some(gpu_error(
            "gpu_capability",
            format!("{gpu_label} VAAPI encoder could not start"),
            format!(
                "The VA-API driver rejected the {codec_label} encode settings. This usually means:\n• The driver does not support this codec, profile or rate-control mode\n• The VA-API driver is outdated or incomplete"
            ),
            format!("Update the {gpu_label} VA driver and libva, or use CPU encoding."),
            codec,
            gpu,
        ));
    }
    if !vaapi_platform && gpu == GpuVendor::Amd {
        if error_output.contains("AMF")
            && (error_output.contains("failed") || error_output.contains("error"))
        {
            return Some(gpu_error(
                "gpu_capability",
                format!("{gpu_label} encoder initialization failed"),
                "FFmpeg could not initialize the AMD AMF encoder. This usually means:\n• Your GPU doesn't support AMF encoding\n• AMD drivers are not installed or outdated".to_string(),
                "Update your AMD drivers or try CPU encoding.".to_string(),
                codec,
                gpu,
            ));
        }
        if error_output.contains("not supported") || error_output.contains("unsupported") {
            return Some(gpu_error(
                "gpu_capability",
                format!("Your {gpu_label} GPU doesn't support {codec_label} encoding"),
                if codec == Some(GpuCodec::Av1) {
                    "AV1 hardware encoding requires an RX 7000 series (RDNA 3) GPU or newer."
                        .to_string()
                } else {
                    format!("Your GPU model doesn't support hardware {codec_label} encoding.")
                },
                if codec == Some(GpuCodec::Av1) {
                    "Use H.264 or H.265 for hardware encoding, or switch to CPU for AV1."
                        .to_string()
                } else {
                    "Try using CPU encoding instead.".to_string()
                },
                codec,
                gpu,
            ));
        }
    }
    if !vaapi_platform
        && gpu == GpuVendor::Intel
        && error_output.contains("QSV")
        && (error_output.contains("failed")
            || error_output.contains("error")
            || error_output.contains("not found"))
    {
        return Some(gpu_error(
            "gpu_capability",
            format!("{gpu_label} Quick Sync encoder not available"),
            "FFmpeg could not initialize Intel Quick Sync Video. This usually means:\n• Your CPU/GPU doesn't support Quick Sync\n• Intel graphics drivers are not installed\n• Quick Sync is disabled in BIOS".to_string(),
            "Ensure Intel graphics drivers are installed and Quick Sync is enabled in BIOS, or try CPU encoding.".to_string(),
            codec,
            gpu,
        ));
    }
    if gpu == GpuVendor::Apple
        && error_output.contains("videotoolbox")
        && (error_output.contains("failed") || error_output.contains("error"))
    {
        return Some(gpu_error(
            "gpu_capability",
            "VideoToolbox encoder not available".to_string(),
            "FFmpeg could not initialize Apple VideoToolbox. This usually means:\n• Your Mac doesn't support hardware encoding for this codec\n• macOS version doesn't support this encoder".to_string(),
            "Try using CPU encoding instead.".to_string(),
            codec,
            gpu,
        ));
    }
    if gpu == GpuVendor::Qualcomm && mf_failure_pattern().is_match(error_output) {
        return Some(gpu_error(
            "gpu_capability",
            "Qualcomm Media Foundation encoder initialization failed".to_string(),
            "FFmpeg could not start the Media Foundation hardware encoder. This usually means:\n• The Qualcomm GPU driver is missing or outdated\n• The device has no hardware encoder for this codec".to_string(),
            "Update your Windows or Qualcomm GPU driver, or use CPU encoding.".to_string(),
            codec,
            gpu,
        ));
    }
    if error_output.contains("Encoder") && error_output.contains("not found") {
        return Some(gpu_error(
            "encoder_unavailable",
            format!("{codec_label} encoder not found"),
            "The selected encoder is not available in your FFmpeg installation.".to_string(),
            "Try using CPU encoding instead.".to_string(),
            codec,
            gpu,
        ));
    }
    if error_output.contains("DLL") || error_output.contains("LoadLibrary") {
        return Some(gpu_error(
            "driver_error",
            "GPU driver or library error".to_string(),
            "A required library failed to load. This usually indicates a driver issue.".to_string(),
            "Update your GPU drivers and restart your computer.".to_string(),
            codec,
            gpu,
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    // Failure modes:
    // - wrong encoder name per vendor/platform: the table must match v1's
    //   GPU_ENCODERS exactly.
    // - Linux Intel/AMD probe without a render node: the row says why.
    // - stale disk cache from another binary or version: discarded.
    // - negative result persisted as positive: unavailable entries are
    //   session-only; a software MFT never answers for Qualcomm hardware.
    // - a hung probe or absent binary: status-gated to false, caches intact.
    // - a recommendation of a rejected vendor: only available rows, CPU last.
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("conv2-gpu-test").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn encoder_table_matches_v1() {
        for platform in ["win32", "darwin", "linux"] {
            assert_eq!(
                resolve_encoder(GpuCodec::H264, GpuVendor::Cpu, platform),
                "libx264"
            );
            assert_eq!(
                resolve_encoder(GpuCodec::H265, GpuVendor::Cpu, platform),
                "libx265"
            );
            assert_eq!(
                resolve_encoder(GpuCodec::Av1, GpuVendor::Cpu, platform),
                "libsvtav1"
            );
        }
        assert_eq!(
            resolve_encoder(GpuCodec::H264, GpuVendor::Nvidia, "win32"),
            "h264_nvenc"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H265, GpuVendor::Nvidia, "win32"),
            "hevc_nvenc"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::Av1, GpuVendor::Nvidia, "win32"),
            "av1_nvenc"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H264, GpuVendor::Amd, "win32"),
            "h264_amf"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H265, GpuVendor::Amd, "win32"),
            "hevc_amf"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::Av1, GpuVendor::Amd, "win32"),
            "av1_amf"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H264, GpuVendor::Intel, "win32"),
            "h264_qsv"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H265, GpuVendor::Intel, "win32"),
            "hevc_qsv"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::Av1, GpuVendor::Intel, "win32"),
            "av1_qsv"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H264, GpuVendor::Qualcomm, "win32"),
            "h264_mf"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H265, GpuVendor::Qualcomm, "win32"),
            "hevc_mf"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::Av1, GpuVendor::Qualcomm, "win32"),
            "av1_mf"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H264, GpuVendor::Apple, "darwin"),
            "h264_videotoolbox"
        );
        assert_eq!(
            resolve_encoder(GpuCodec::H265, GpuVendor::Apple, "darwin"),
            "hevc_videotoolbox"
        );
        // AV1-on-Apple falls back to the CPU encoder, like v1.
        assert_eq!(
            resolve_encoder(GpuCodec::Av1, GpuVendor::Apple, "darwin"),
            "libsvtav1"
        );
        // Linux Intel and AMD use VAAPI names on every codec.
        for vendor in [GpuVendor::Intel, GpuVendor::Amd] {
            assert_eq!(
                resolve_encoder(GpuCodec::H264, vendor, "linux"),
                "h264_vaapi"
            );
            assert_eq!(
                resolve_encoder(GpuCodec::H265, vendor, "linux"),
                "hevc_vaapi"
            );
            assert_eq!(resolve_encoder(GpuCodec::Av1, vendor, "linux"), "av1_vaapi");
        }
    }

    #[test]
    fn platform_gating() {
        assert!(uses_vaapi(GpuVendor::Intel, "linux"));
        assert!(uses_vaapi(GpuVendor::Amd, "linux"));
        assert!(!uses_vaapi(GpuVendor::Nvidia, "linux"));
        assert!(!uses_vaapi(GpuVendor::Intel, "win32"));
        assert!(!uses_vaapi(GpuVendor::Intel, "darwin"));
        assert!(supports_qualcomm("win32", "arm64"));
        assert!(!supports_qualcomm("win32", "x64"));
        assert!(!supports_qualcomm("darwin", "arm64"));
        assert!(!supports_qualcomm("linux", "arm64"));
    }

    #[test]
    fn hw_probe_args_match_v1() {
        let plain = build_hw_probe_args("h264_nvenc", &HwProbeOptions::default(), "win32");
        assert_eq!(
            plain,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=black:s=256x256:d=0.04:r=25,format=yuv420p",
                "-frames:v",
                "1",
                "-c:v",
                "h264_nvenc",
                "-f",
                "null",
                "NUL"
            ]
        );
        assert_eq!(
            build_hw_probe_args("h264_nvenc", &HwProbeOptions::default(), "darwin").last(),
            Some(&"/dev/null".to_string())
        );

        let vaapi = vaapi_probe_options("hevc_vaapi", "/dev/dri/renderD129");
        assert_eq!(
            vaapi.cache_key.as_deref(),
            Some("hevc_vaapi@/dev/dri/renderD129#cqp")
        );
        let args = build_hw_probe_args("hevc_vaapi", &vaapi, "linux");
        let joined = args.join(" ");
        assert!(joined.contains("-vaapi_device /dev/dri/renderD129 -f lavfi"));
        assert!(joined.contains("-vf format=nv12,hwupload -rc_mode CQP -global_quality 23"));
        // AV1 uses the 1..255 scale.
        assert_eq!(vaapi_probe_global_quality("av1_vaapi"), 92);
        assert_eq!(vaapi_probe_global_quality("hevc_vaapi"), 23);

        let qualcomm = qualcomm_probe_options("h264_mf");
        assert_eq!(qualcomm.cache_key.as_deref(), Some("h264_mf@hw"));
        let args = build_hw_probe_args("h264_mf", &qualcomm, "win32");
        let joined = args.join(" ");
        assert!(joined.contains("-pix_fmt nv12 -hw_encoding 1 -rate_control quality -quality 50"));
    }

    #[test]
    fn vaapi_render_node_discovery_from_fixture() {
        let dir = temp_dir("drm");
        // renderD128 has no readable vendor file; D129 is Intel; D130 is AMD.
        std::fs::create_dir_all(dir.join("renderD128").join("device")).unwrap();
        std::fs::create_dir_all(dir.join("renderD129").join("device")).unwrap();
        std::fs::write(
            dir.join("renderD129").join("device").join("vendor"),
            "0X8086\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("card0")).unwrap();
        std::fs::create_dir_all(dir.join("renderD130").join("device")).unwrap();
        std::fs::write(
            dir.join("renderD130").join("device").join("vendor"),
            "0x1002\n",
        )
        .unwrap();

        assert_eq!(
            find_vaapi_render_node_in(&dir, GpuVendor::Intel).as_deref(),
            Some("/dev/dri/renderD129")
        );
        assert_eq!(
            find_vaapi_render_node_in(&dir, GpuVendor::Amd).as_deref(),
            Some("/dev/dri/renderD130")
        );
        assert_eq!(find_vaapi_render_node_in(&dir, GpuVendor::Nvidia), None);
        assert_eq!(
            find_vaapi_render_node_in(&temp_dir("drm-empty"), GpuVendor::Intel),
            None
        );
    }

    #[test]
    fn disk_cache_round_trips_and_expires() {
        let dir = temp_dir("store");
        let path = dir.join("gpu-probe-cache.json");
        let now = 1_000_000u64;
        let mut cache = HwDiskCache::load(path.clone(), "fp".to_string(), now);
        assert_eq!(cache.get("h264_nvenc"), None);
        cache.set("h264_nvenc", true, now);
        assert!(path.is_file());
        // Reload with the same fingerprint: the positive survives.
        let mut reloaded = HwDiskCache::load(path.clone(), "fp".to_string(), now + 1000);
        assert_eq!(reloaded.get("h264_nvenc"), Some(true));
        // A different fingerprint discards everything.
        assert_eq!(
            HwDiskCache::load(path.clone(), "other".to_string(), now + 1000).get("h264_nvenc"),
            None
        );
        // A TTL expiry discards everything.
        assert_eq!(
            HwDiskCache::load(path.clone(), "fp".to_string(), now + HW_CACHE_TTL_MS + 1)
                .get("h264_nvenc"),
            None
        );
        // Unavailable drops any persisted known-good entry.
        reloaded.set("h264_nvenc", false, now + 2000);
        assert_eq!(reloaded.get("h264_nvenc"), None);
        let after_negative: HwProbeCacheFile =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(after_negative.results.is_empty());
        // Clear removes the file entirely.
        reloaded.clear(now + 3000);
        assert!(!path.exists());
    }

    #[test]
    fn fingerprint_covers_identity() {
        let dir = temp_dir("fingerprint");
        let binary = dir.join("ffmpeg");
        std::fs::write(&binary, b"12345678").unwrap();
        let fingerprint = binary_fingerprint(&binary, "9.9.9");
        assert!(fingerprint.starts_with(&format!(
            "{}-{}|9.9.9|{}|8|",
            node_platform(),
            node_arch(),
            binary.display()
        )));
        std::fs::write(&binary, b"1234567890").unwrap();
        assert_ne!(fingerprint, binary_fingerprint(&binary, "9.9.9"));
        let missing = binary_fingerprint(&dir.join("absent"), "9.9.9");
        assert_eq!(
            missing,
            format!(
                "{}-{}|9.9.9|{}",
                node_platform(),
                node_arch(),
                dir.join("absent").display()
            )
        );
    }

    #[test]
    fn encoder_listing_parser_matches_v1_regex() {
        assert_eq!(
            parse_encoder_line(" V..... libx264  libx264 encoder"),
            Some("libx264".to_string())
        );
        assert_eq!(
            parse_encoder_line(" A..... aac    AAC (Advanced Audio Coding)"),
            Some("aac".to_string())
        );
        assert_eq!(parse_encoder_line(" ------"), None);
        assert_eq!(parse_encoder_line("Encoders:"), None);
        assert_eq!(parse_encoder_line(""), None);
    }

    fn no_probe(
        _codec: GpuCodec,
        _vendor: GpuVendor,
        _encoder: &str,
        _options: &HwProbeOptions,
    ) -> bool {
        false
    }

    fn no_render_node(_vendor: GpuVendor) -> Option<String> {
        None
    }

    #[test]
    fn cheap_vendor_rows_match_v1_reasons() {
        let cpu = cheap_vendor_status(GpuCodec::H264, GpuVendor::Cpu, "linux", "x64").unwrap();
        assert!(cpu.available);
        assert_eq!(cpu.reason, "Software encoding fallback.");
        assert_eq!(cpu.encoder, "libx264");

        let apple = cheap_vendor_status(GpuCodec::H264, GpuVendor::Apple, "win32", "x64").unwrap();
        assert!(!apple.available);
        assert_eq!(apple.reason, "Apple VideoToolbox available only on macOS.");
        assert_eq!(apple.encoder, "h264_videotoolbox");

        let qualcomm =
            cheap_vendor_status(GpuCodec::H265, GpuVendor::Qualcomm, "darwin", "arm64").unwrap();
        assert!(!qualcomm.available);
        assert_eq!(
            qualcomm.reason,
            "Qualcomm Media Foundation available only on Windows on Arm."
        );

        let apple_av1 =
            cheap_vendor_status(GpuCodec::Av1, GpuVendor::Apple, "darwin", "arm64").unwrap();
        assert!(!apple_av1.available);
        assert_eq!(
            apple_av1.reason,
            "Apple AV1 hardware encode unavailable. Use CPU for AV1."
        );
        assert_eq!(apple_av1.encoder, "libsvtav1");
        // Real vendors on their home platform need the probe path.
        assert!(cheap_vendor_status(GpuCodec::H264, GpuVendor::Nvidia, "win32", "x64").is_none());
    }

    #[test]
    fn probe_row_reports_missing_render_node() {
        let probe: ProbeFn = Arc::new(no_probe);
        let render_node: RenderNodeFn = Arc::new(no_render_node);
        let status = probe_vendor_status(
            GpuCodec::H264,
            GpuVendor::Intel,
            "linux",
            &probe,
            &render_node,
        );
        assert!(!status.available);
        assert_eq!(status.reason, "No Intel render node found");
        assert_eq!(status.encoder, "h264_vaapi");

        let status = probe_vendor_status(
            GpuCodec::H264,
            GpuVendor::Nvidia,
            "win32",
            &probe,
            &render_node,
        );
        assert!(!status.available);
        assert_eq!(status.reason, "NVIDIA H.264 encoder not available");
        assert_eq!(status.encoder, "h264_nvenc");

        let available_probe: ProbeFn = Arc::new(|_, _, _, _| true);
        let status = probe_vendor_status(
            GpuCodec::Av1,
            GpuVendor::Amd,
            "win32",
            &available_probe,
            &render_node,
        );
        assert!(status.available);
        assert_eq!(status.reason, "Available");
        assert_eq!(status.encoder, "av1_amf");
    }

    #[test]
    fn recommendation_uses_platform_priority() {
        let darwin = |vendor: GpuVendor| vendor == GpuVendor::Apple;
        assert_eq!(
            recommend_gpu_vendor_from_availability("darwin", darwin).0,
            GpuVendor::Apple
        );
        assert_eq!(
            recommend_gpu_vendor_from_availability("darwin", |vendor| vendor == GpuVendor::Nvidia)
                .0,
            GpuVendor::Nvidia
        );
        // NVIDIA outranks Intel on Windows even when both are available.
        assert_eq!(
            recommend_gpu_vendor_from_availability("win32", |vendor| {
                matches!(vendor, GpuVendor::Intel | GpuVendor::Nvidia)
            })
            .0,
            GpuVendor::Nvidia
        );
        // Only CPU available: the reason says no compatible GPU encoder.
        let (vendor, reason) =
            recommend_gpu_vendor_from_availability("win32", |vendor| vendor == GpuVendor::Cpu);
        assert_eq!(vendor, GpuVendor::Cpu);
        assert_eq!(reason, "No compatible GPU encoder found. Using CPU.");
    }

    fn payload_with(
        requested: Option<GpuCodec>,
        platform: &str,
        arch: &str,
        probe: ProbeFn,
    ) -> GPUCapabilitiesPayload {
        let render_node: RenderNodeFn = Arc::new(no_render_node);
        build_payload_with(requested, platform, arch, &probe, &render_node)
    }

    #[test]
    fn payload_covers_all_codecs_when_unrequested() {
        let probe: ProbeFn = Arc::new(no_probe);
        let payload = payload_with(None, "win32", "x64", probe);
        assert_eq!(payload.platform, "win32");
        assert_eq!(payload.requested_codec, None);
        assert_eq!(payload.checked_codecs.len(), 3);
        for codec in GpuCodec::NAMES {
            let row = payload.matrix.get(*codec).expect("every codec is checked");
            let cpu = row.get("cpu").unwrap();
            assert!(cpu.available);
            assert_eq!(cpu.reason, "Software encoding fallback.");
            let nvidia = row.get("nvidia").unwrap();
            assert!(!nvidia.available);
            assert_eq!(
                nvidia.reason,
                format!(
                    "NVIDIA {} encoder not available",
                    codec_name(GpuCodec::parse(codec).unwrap())
                )
            );
        }
        assert_eq!(payload.recommended_vendor, GpuVendor::Cpu);
        assert_eq!(
            payload.recommendation_reason,
            "Preset does not use GPU-accelerated video encoding."
        );
    }

    #[test]
    fn payload_probes_only_the_requested_codec() {
        let probe: ProbeFn =
            Arc::new(|codec, vendor, _, _| codec == GpuCodec::H264 && vendor == GpuVendor::Nvidia);
        let payload = payload_with(Some(GpuCodec::H264), "win32", "x64", probe);
        assert_eq!(payload.checked_codecs, vec![GpuCodec::H264]);
        assert_eq!(payload.matrix.len(), 1);
        assert_eq!(payload.recommended_vendor, GpuVendor::Nvidia);
        assert_eq!(
            payload.recommendation_reason,
            "Best available path: nvidia."
        );
    }

    #[test]
    fn payload_prefers_apple_on_darwin() {
        let probe: ProbeFn = Arc::new(|_, vendor, _, _| vendor == GpuVendor::Apple);
        let payload = payload_with(Some(GpuCodec::H264), "darwin", "arm64", Arc::clone(&probe));
        assert_eq!(payload.recommended_vendor, GpuVendor::Apple);
        let apple = payload.matrix["h264"]["apple"].clone();
        assert!(apple.available);
        assert_eq!(apple.encoder, "h264_videotoolbox");
        // The AV1 row on Apple is hardware-unavailable regardless of probe.
        let payload = payload_with(Some(GpuCodec::Av1), "darwin", "arm64", Arc::clone(&probe));
        let apple_av1 = payload.matrix["av1"]["apple"].clone();
        assert!(!apple_av1.available);
        assert_eq!(
            apple_av1.reason,
            "Apple AV1 hardware encode unavailable. Use CPU for AV1."
        );
        assert_eq!(payload.recommended_vendor, GpuVendor::Cpu);
    }

    #[test]
    fn payload_gates_qualcomm_to_windows_on_arm() {
        // Off Windows on Arm the row is cheap-unavailable.
        let probe: ProbeFn = Arc::new(|_, _, _, _| true);
        let payload = payload_with(Some(GpuCodec::H264), "win32", "x64", Arc::clone(&probe));
        let qualcomm = payload.matrix["h264"]["qualcomm"].clone();
        assert!(!qualcomm.available);
        assert_eq!(
            qualcomm.reason,
            "Qualcomm Media Foundation available only on Windows on Arm."
        );
        // On Windows on Arm the probe runs with the hardware-only options.
        let payload = payload_with(Some(GpuCodec::H264), "win32", "arm64", probe);
        let qualcomm = payload.matrix["h264"]["qualcomm"].clone();
        assert!(qualcomm.available);
        assert_eq!(qualcomm.encoder, "h264_mf");
    }

    #[test]
    fn payload_linux_uses_vaapi_rows() {
        let probe: ProbeFn = Arc::new(|_, vendor, _, _| vendor == GpuVendor::Amd);
        let render_node: RenderNodeFn = Arc::new(|vendor| {
            (vendor == GpuVendor::Amd).then(|| "/dev/dri/renderD128".to_string())
        });
        let payload =
            build_payload_with(Some(GpuCodec::H265), "linux", "x64", &probe, &render_node);
        let intel = payload.matrix["h265"]["intel"].clone();
        assert!(!intel.available);
        assert_eq!(intel.reason, "No Intel render node found");
        assert_eq!(intel.encoder, "hevc_vaapi");
        assert_eq!(payload.recommended_vendor, GpuVendor::Amd);
    }

    #[test]
    fn recommendation_without_codec_or_row() {
        let probe: ProbeFn = Arc::new(no_probe);
        let payload = payload_with(None, "win32", "x64", Arc::clone(&probe));
        let (vendor, reason) = get_recommended_vendor("win32", None, &payload.matrix);
        assert_eq!(vendor, GpuVendor::Cpu);
        assert_eq!(
            reason,
            "Preset does not use GPU-accelerated video encoding."
        );
        let (vendor, reason) =
            get_recommended_vendor("win32", Some(GpuCodec::H264), &BTreeMap::new());
        assert_eq!(vendor, GpuVendor::Cpu);
        assert_eq!(reason, "Capability data unavailable. Falling back to CPU.");
    }

    #[test]
    fn status_gate_short_circuits_probes_without_caching() {
        // Binary not ok: the probe answers false and never touches the caches.
        let ctx = ProbeContext {
            ffmpeg: PathBuf::from("conv2-ffmpeg"),
            status_ok: false,
            encoders: Arc::new(BTreeSet::new()),
        };
        assert!(!probe_hw_encoder_available(
            &ctx,
            "h264_nvenc",
            &HwProbeOptions::default()
        ));
        assert!(HW_MEMORY_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty());
    }
}
