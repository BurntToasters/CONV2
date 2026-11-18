//! Settings model: defaults, lenient normalization, and crash-safe
//! persistence in `<app data>/settings.json` at schema version 7 (v1's
//! settingsStore.ts / settingsSchema.ts / advancedFormats.ts).

use crate::ipc::{self, FalliblePayload, IpcResult, JsonObject, INTERNAL_ERROR};
use crate::types::{
    AdvancedFormatSettings, AppSettings, Av1AdvancedSettings, Av1TierSettings, AviAdvancedSettings,
    AviCodec, AviTierSettings, CustomThemeId, GifAdvancedSettings, GifDither, GifLoopMode,
    GifTierSettings, GpuMode, GpuVendor, H264AdvancedSettings, H264TierSettings, H265AdvancedSettings,
    H265TierSettings, InterfaceStyle, ThemePreference, UIPanelSettings, UpdateChannel, VideoPreset,
    WebpAdvancedSettings, WebpTierSettings,
};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

pub const CURRENT_SETTINGS_VERSION: u32 = 7;
pub const MAX_RECENT_PRESET_IDS: usize = 8;
/// Older files get their untouched shipped tier defaults replaced (v1's
/// TIER_DEFAULTS_MIGRATION_VERSION).
const TIER_DEFAULTS_MIGRATION_VERSION: u32 = 7;
const MAX_SETTINGS_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// v1's ALLOWED_SETTINGS_KEYS; settingsSchemaVersion is written, never patched.
const ALLOWED_SETTINGS_KEYS: &[&str] = &[
    "outputDirectory",
    "gpu",
    "gpuMode",
    "gpuManualVendor",
    "theme",
    "customTheme",
    "interfaceStyle",
    "showDebugOutput",
    "autoCheckUpdates",
    "useSystemFFmpeg",
    "useCpuDecodingWhenGpu",
    "moveOriginalToTrashOnSuccess",
    "updateChannel",
    "showAdvancedPresets",
    "removeSpacesFromFilenames",
    "showAllGpuVendors",
    "notifyOnConversionComplete",
    "preventSleepWhileConverting",
    "setupWizardCompleted",
    "recentPresetIds",
    "uiPanels",
    "advancedFormatSettings",
];

/// The in-memory copy v1 kept in main.ts; the file is authoritative on load.
static SETTINGS: Mutex<Option<AppSettings>> = Mutex::new(None);
/// Serializes read-modify-write saves so two patches cannot lose one another.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

fn settings_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("settings.json")
}

// ── defaults ───────────────────────────────────────────────────────────────

fn default_gif_tier(fps: u32, max_dimension: u32, max_colors: u32, dither: GifDither) -> GifTierSettings {
    GifTierSettings {
        fps,
        max_dimension,
        max_colors,
        dither,
    }
}

fn default_gif() -> GifAdvancedSettings {
    GifAdvancedSettings {
        loop_mode: GifLoopMode::Forever,
        tiers: crate::types::GifTierCollection {
            best_quality: default_gif_tier(15, 720, 256, GifDither::Bayer),
            quality: default_gif_tier(12, 600, 192, GifDither::Bayer),
            balanced: default_gif_tier(12, 480, 128, GifDither::Bayer),
            best_compression: default_gif_tier(10, 360, 64, GifDither::None),
        },
    }
}

fn default_webp() -> WebpAdvancedSettings {
    WebpAdvancedSettings {
        loop_mode: GifLoopMode::Forever,
        tiers: crate::types::WebpTierCollection {
            best_quality: WebpTierSettings {
                fps: 30,
                max_dimension: 720,
                quality: 90,
            },
            quality: WebpTierSettings {
                fps: 24,
                max_dimension: 600,
                quality: 80,
            },
            balanced: WebpTierSettings {
                fps: 20,
                max_dimension: 480,
                quality: 70,
            },
            best_compression: WebpTierSettings {
                fps: 15,
                max_dimension: 360,
                quality: 50,
            },
        },
    }
}

fn av1_tier(quality: u32, cpu_preset: u32, audio_bitrate_kbps: u32) -> Av1TierSettings {
    Av1TierSettings {
        quality,
        cpu_preset,
        audio_bitrate_kbps,
    }
}

fn default_av1() -> Av1AdvancedSettings {
    Av1AdvancedSettings {
        tiers: crate::types::Av1TierCollection {
            best_quality: av1_tier(18, 4, 192),
            quality: av1_tier(24, 5, 160),
            balanced: av1_tier(30, 6, 128),
            best_compression: av1_tier(38, 4, 96),
            compression: av1_tier(44, 8, 96),
        },
    }
}

fn h264_tier(quality: u32, preset: VideoPreset, audio_bitrate_kbps: u32) -> H264TierSettings {
    H264TierSettings {
        quality,
        preset,
        audio_bitrate_kbps,
    }
}

fn default_h264() -> H264AdvancedSettings {
    H264AdvancedSettings {
        tiers: crate::types::H264TierCollection {
            fast: h264_tier(23, VideoPreset::Fast, 128),
            quality: h264_tier(18, VideoPreset::Slow, 192),
        },
    }
}

fn h265_tier(
    quality: u32,
    preset: VideoPreset,
    audio_bitrate_kbps: u32,
    use_advanced_params: bool,
) -> H265TierSettings {
    H265TierSettings {
        quality,
        preset,
        audio_bitrate_kbps,
        use_advanced_params,
    }
}

fn default_h265() -> H265AdvancedSettings {
    H265AdvancedSettings {
        tiers: crate::types::H265TierCollection {
            best_quality: h265_tier(16, VideoPreset::Slow, 256, true),
            quality: h265_tier(22, VideoPreset::Slow, 192, false),
            balanced: h265_tier(28, VideoPreset::Medium, 128, false),
            best_compression: h265_tier(32, VideoPreset::Slow, 96, true),
        },
    }
}

fn avi_tier(
    codec: AviCodec,
    quality: u32,
    preset: VideoPreset,
    audio_bitrate_kbps: u32,
    use_advanced_params: bool,
) -> AviTierSettings {
    AviTierSettings {
        codec,
        quality,
        preset,
        audio_bitrate_kbps,
        use_advanced_params,
    }
}

fn default_avi() -> AviAdvancedSettings {
    AviAdvancedSettings {
        tiers: crate::types::AviTierCollection {
            best_quality: avi_tier(AviCodec::H264, 16, VideoPreset::Slow, 256, false),
            best_compression: avi_tier(AviCodec::H264, 26, VideoPreset::Slow, 128, false),
            balanced: avi_tier(AviCodec::H264, 20, VideoPreset::Medium, 192, false),
        },
    }
}

pub fn default_advanced_format_settings() -> AdvancedFormatSettings {
    AdvancedFormatSettings {
        gif: default_gif(),
        webp: default_webp(),
        av1: default_av1(),
        h264: default_h264(),
        h265: default_h265(),
        avi: default_avi(),
    }
}

pub fn default_settings() -> AppSettings {
    AppSettings {
        settings_schema_version: CURRENT_SETTINGS_VERSION,
        output_directory: String::new(),
        gpu: GpuVendor::Cpu,
        gpu_mode: GpuMode::Auto,
        gpu_manual_vendor: GpuVendor::Cpu,
        theme: ThemePreference::System,
        custom_theme: CustomThemeId::MidnightBlue,
        interface_style: InterfaceStyle::Glass,
        show_debug_output: false,
        auto_check_updates: true,
        use_system_ffmpeg: false,
        use_cpu_decoding_when_gpu: false,
        move_original_to_trash_on_success: false,
        update_channel: UpdateChannel::Auto,
        show_advanced_presets: false,
        remove_spaces_from_filenames: false,
        show_all_gpu_vendors: false,
        notify_on_conversion_complete: true,
        prevent_sleep_while_converting: false,
        setup_wizard_completed: false,
        recent_preset_ids: Vec::new(),
        ui_panels: UIPanelSettings::default(),
        advanced_format_settings: default_advanced_format_settings(),
    }
}

// ── input normalization ────────────────────────────────────────────────────

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn bool_or(incoming: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    incoming.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

/// v1's clampInteger: numeric strings count, finite values round and clamp,
/// everything else falls back. NaN is not representable in JSON.
fn clamp_integer(value: Option<&Value>, min: u32, max: u32, fallback: u32) -> u32 {
    let Some(value) = value else {
        return fallback;
    };
    let numeric = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if !text.trim().is_empty() => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(numeric) = numeric.filter(|number| number.is_finite()) else {
        return fallback;
    };
    (numeric.round() as i64).clamp(min as i64, max as i64) as u32
}

fn enum_or<T: Copy>(value: Option<&Value>, parse: fn(&str) -> Option<T>, fallback: T) -> T {
    value
        .and_then(Value::as_str)
        .and_then(parse)
        .unwrap_or(fallback)
}

fn normalize_gif_tier(value: &Value, fallback: GifTierSettings) -> GifTierSettings {
    let incoming = object(value);
    GifTierSettings {
        // GIF delays are whole centiseconds; above 50 fps browsers misplay.
        fps: clamp_integer(incoming.get("fps"), 1, 50, fallback.fps),
        max_dimension: clamp_integer(incoming.get("maxDimension"), 160, 2160, fallback.max_dimension),
        // Floor 3: palettegen reserves a transparent slot and rejects 2.
        max_colors: clamp_integer(incoming.get("maxColors"), 3, 256, fallback.max_colors),
        dither: enum_or(incoming.get("dither"), GifDither::parse, fallback.dither),
    }
}

fn normalize_webp_tier(value: &Value, fallback: WebpTierSettings) -> WebpTierSettings {
    let incoming = object(value);
    WebpTierSettings {
        fps: clamp_integer(incoming.get("fps"), 1, 60, fallback.fps),
        max_dimension: clamp_integer(incoming.get("maxDimension"), 160, 2160, fallback.max_dimension),
        quality: clamp_integer(incoming.get("quality"), 1, 100, fallback.quality),
    }
}

fn normalize_av1_tier(value: &Value, fallback: Av1TierSettings) -> Av1TierSettings {
    let incoming = object(value);
    Av1TierSettings {
        quality: clamp_integer(incoming.get("quality"), 1, 63, fallback.quality),
        cpu_preset: clamp_integer(incoming.get("cpuPreset"), 0, 13, fallback.cpu_preset),
        audio_bitrate_kbps: clamp_integer(incoming.get("audioBitrateKbps"), 32, 512, fallback.audio_bitrate_kbps),
    }
}

fn normalize_h264_tier(value: &Value, fallback: H264TierSettings) -> H264TierSettings {
    let incoming = object(value);
    H264TierSettings {
        quality: clamp_integer(incoming.get("quality"), 1, 51, fallback.quality),
        preset: enum_or(incoming.get("preset"), VideoPreset::parse, fallback.preset),
        audio_bitrate_kbps: clamp_integer(incoming.get("audioBitrateKbps"), 32, 512, fallback.audio_bitrate_kbps),
    }
}

fn normalize_h265_tier(value: &Value, fallback: H265TierSettings) -> H265TierSettings {
    let incoming = object(value);
    H265TierSettings {
        quality: clamp_integer(incoming.get("quality"), 1, 51, fallback.quality),
        preset: enum_or(incoming.get("preset"), VideoPreset::parse, fallback.preset),
        audio_bitrate_kbps: clamp_integer(incoming.get("audioBitrateKbps"), 32, 512, fallback.audio_bitrate_kbps),
        use_advanced_params: bool_or(&incoming, "useAdvancedParams", fallback.use_advanced_params),
    }
}

fn normalize_avi_tier(value: &Value, fallback: AviTierSettings) -> AviTierSettings {
    let incoming = object(value);
    AviTierSettings {
        codec: enum_or(incoming.get("codec"), AviCodec::parse, fallback.codec),
        quality: clamp_integer(incoming.get("quality"), 1, 51, fallback.quality),
        preset: enum_or(incoming.get("preset"), VideoPreset::parse, fallback.preset),
        audio_bitrate_kbps: clamp_integer(incoming.get("audioBitrateKbps"), 32, 512, fallback.audio_bitrate_kbps),
        use_advanced_params: bool_or(&incoming, "useAdvancedParams", fallback.use_advanced_params),
    }
}

fn tiers(value: &Value) -> Map<String, Value> {
    object(value.get("tiers").unwrap_or(&Value::Null))
}

fn normalize_gif(value: &Value, fallback: GifAdvancedSettings) -> GifAdvancedSettings {
    let incoming = object(value);
    let incoming_tiers = tiers(value);
    GifAdvancedSettings {
        loop_mode: enum_or(incoming.get("loopMode"), GifLoopMode::parse, fallback.loop_mode),
        tiers: crate::types::GifTierCollection {
            best_quality: normalize_gif_tier(incoming_tiers.get("bestQuality").unwrap_or(&Value::Null), fallback.tiers.best_quality),
            quality: normalize_gif_tier(incoming_tiers.get("quality").unwrap_or(&Value::Null), fallback.tiers.quality),
            balanced: normalize_gif_tier(incoming_tiers.get("balanced").unwrap_or(&Value::Null), fallback.tiers.balanced),
            best_compression: normalize_gif_tier(incoming_tiers.get("bestCompression").unwrap_or(&Value::Null), fallback.tiers.best_compression),
        },
    }
}

fn normalize_webp(value: &Value, fallback: WebpAdvancedSettings) -> WebpAdvancedSettings {
    let incoming = object(value);
    let incoming_tiers = tiers(value);
    WebpAdvancedSettings {
        loop_mode: enum_or(incoming.get("loopMode"), GifLoopMode::parse, fallback.loop_mode),
        tiers: crate::types::WebpTierCollection {
            best_quality: normalize_webp_tier(incoming_tiers.get("bestQuality").unwrap_or(&Value::Null), fallback.tiers.best_quality),
            quality: normalize_webp_tier(incoming_tiers.get("quality").unwrap_or(&Value::Null), fallback.tiers.quality),
            balanced: normalize_webp_tier(incoming_tiers.get("balanced").unwrap_or(&Value::Null), fallback.tiers.balanced),
            best_compression: normalize_webp_tier(incoming_tiers.get("bestCompression").unwrap_or(&Value::Null), fallback.tiers.best_compression),
        },
    }
}

fn normalize_av1(value: &Value, fallback: Av1AdvancedSettings) -> Av1AdvancedSettings {
    let incoming_tiers = tiers(value);
    Av1AdvancedSettings {
        tiers: crate::types::Av1TierCollection {
            best_quality: normalize_av1_tier(incoming_tiers.get("bestQuality").unwrap_or(&Value::Null), fallback.tiers.best_quality),
            quality: normalize_av1_tier(incoming_tiers.get("quality").unwrap_or(&Value::Null), fallback.tiers.quality),
            balanced: normalize_av1_tier(incoming_tiers.get("balanced").unwrap_or(&Value::Null), fallback.tiers.balanced),
            best_compression: normalize_av1_tier(incoming_tiers.get("bestCompression").unwrap_or(&Value::Null), fallback.tiers.best_compression),
            compression: normalize_av1_tier(incoming_tiers.get("compression").unwrap_or(&Value::Null), fallback.tiers.compression),
        },
    }
}

fn normalize_h264(value: &Value, fallback: H264AdvancedSettings) -> H264AdvancedSettings {
    let incoming_tiers = tiers(value);
    H264AdvancedSettings {
        tiers: crate::types::H264TierCollection {
            fast: normalize_h264_tier(incoming_tiers.get("fast").unwrap_or(&Value::Null), fallback.tiers.fast),
            quality: normalize_h264_tier(incoming_tiers.get("quality").unwrap_or(&Value::Null), fallback.tiers.quality),
        },
    }
}

fn normalize_h265(value: &Value, fallback: H265AdvancedSettings) -> H265AdvancedSettings {
    let incoming_tiers = tiers(value);
    H265AdvancedSettings {
        tiers: crate::types::H265TierCollection {
            best_quality: normalize_h265_tier(incoming_tiers.get("bestQuality").unwrap_or(&Value::Null), fallback.tiers.best_quality),
            quality: normalize_h265_tier(incoming_tiers.get("quality").unwrap_or(&Value::Null), fallback.tiers.quality),
            balanced: normalize_h265_tier(incoming_tiers.get("balanced").unwrap_or(&Value::Null), fallback.tiers.balanced),
            best_compression: normalize_h265_tier(incoming_tiers.get("bestCompression").unwrap_or(&Value::Null), fallback.tiers.best_compression),
        },
    }
}

fn normalize_avi(value: &Value, fallback: AviAdvancedSettings) -> AviAdvancedSettings {
    let incoming_tiers = tiers(value);
    AviAdvancedSettings {
        tiers: crate::types::AviTierCollection {
            best_quality: normalize_avi_tier(incoming_tiers.get("bestQuality").unwrap_or(&Value::Null), fallback.tiers.best_quality),
            best_compression: normalize_avi_tier(incoming_tiers.get("bestCompression").unwrap_or(&Value::Null), fallback.tiers.best_compression),
            balanced: normalize_avi_tier(incoming_tiers.get("balanced").unwrap_or(&Value::Null), fallback.tiers.balanced),
        },
    }
}

/// v1's normalizeAdvancedFormatSettings when `fallback` is the defaults, and
/// the per-field deep merge when it is the stored settings.
fn normalize_advanced(value: &Value, fallback: &AdvancedFormatSettings) -> AdvancedFormatSettings {
    let incoming = object(value);
    let part = |key: &str| incoming.get(key).cloned().unwrap_or(Value::Null);
    AdvancedFormatSettings {
        gif: normalize_gif(&part("gif"), fallback.gif),
        webp: normalize_webp(&part("webp"), fallback.webp),
        av1: normalize_av1(&part("av1"), fallback.av1),
        h264: normalize_h264(&part("h264"), fallback.h264),
        h265: normalize_h265(&part("h265"), fallback.h265),
        avi: normalize_avi(&part("avi"), fallback.avi),
    }
}

/// v1's deep merge: an absent format/tier keeps the stored value, while a
/// present one overlays only its own valid fields.
fn merge_advanced(current: &AdvancedFormatSettings, incoming: &Value) -> AdvancedFormatSettings {
    let incoming = object(incoming);
    if incoming.is_empty() {
        return current.clone();
    }
    normalize_advanced(&Value::Object(incoming), current)
}

fn normalize_ui_panels(value: &Value, fallback: UIPanelSettings) -> UIPanelSettings {
    let incoming = object(value);
    UIPanelSettings {
        preset_expanded: bool_or(&incoming, "presetExpanded", fallback.preset_expanded),
        gpu_expanded: bool_or(&incoming, "gpuExpanded", fallback.gpu_expanded),
    }
}

fn normalize_recent_preset_ids(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .filter(|item| seen.insert(item.to_string()))
        .take(MAX_RECENT_PRESET_IDS)
        .map(str::to_string)
        .collect()
}

/// `path.isAbsolute` equivalent plus the lexical resolution `path.resolve`
/// performs, so `..` in a stored path cannot point outside what v1 stored.
fn normalize_output_directory(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let trimmed = text.trim();
    if trimmed.is_empty() || !std::path::Path::new(trimmed).is_absolute() {
        return String::new();
    }
    let mut normalized = std::path::PathBuf::new();
    for component in std::path::Path::new(trimmed).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

fn normalize_gpu(value: Option<&Value>) -> GpuVendor {
    enum_or(value, GpuVendor::parse, GpuVendor::Cpu)
}

fn normalize_gpu_mode(value: Option<&Value>) -> GpuMode {
    enum_or(value, GpuMode::parse, GpuMode::Auto)
}

fn normalize_update_channel(value: Option<&Value>) -> UpdateChannel {
    enum_or(value, UpdateChannel::parse, UpdateChannel::Auto)
}

/// v1's normalizeSettings: every key falls back independently.
pub fn normalize_settings(value: &Value) -> AppSettings {
    let defaults = default_settings();
    let incoming = object(value);

    let manual_vendor = normalize_gpu(
        incoming
            .get("gpuManualVendor")
            .or_else(|| incoming.get("gpu"))
            .or_else(|| Some(&Value::Null)),
    );
    let setup_wizard_completed = match incoming.get("setupWizardCompleted").and_then(Value::as_bool) {
        Some(value) => value,
        // Missing key on an existing file means a legacy user who finished.
        None => !incoming.contains_key("setupWizardCompleted"),
    };

    AppSettings {
        settings_schema_version: CURRENT_SETTINGS_VERSION,
        output_directory: normalize_output_directory(incoming.get("outputDirectory")),
        gpu: manual_vendor,
        gpu_mode: normalize_gpu_mode(incoming.get("gpuMode")),
        gpu_manual_vendor: manual_vendor,
        theme: enum_or(incoming.get("theme"), ThemePreference::parse, ThemePreference::System),
        custom_theme: enum_or(
            incoming.get("customTheme"),
            CustomThemeId::parse,
            CustomThemeId::MidnightBlue,
        ),
        interface_style: match incoming.get("interfaceStyle").and_then(Value::as_str) {
            Some("flat") => InterfaceStyle::Flat,
            _ => InterfaceStyle::Glass,
        },
        show_debug_output: bool_or(&incoming, "showDebugOutput", false),
        auto_check_updates: bool_or(&incoming, "autoCheckUpdates", true),
        use_system_ffmpeg: bool_or(&incoming, "useSystemFFmpeg", false),
        use_cpu_decoding_when_gpu: bool_or(&incoming, "useCpuDecodingWhenGpu", false),
        move_original_to_trash_on_success: bool_or(&incoming, "moveOriginalToTrashOnSuccess", false),
        update_channel: normalize_update_channel(incoming.get("updateChannel")),
        show_advanced_presets: bool_or(&incoming, "showAdvancedPresets", false),
        remove_spaces_from_filenames: bool_or(&incoming, "removeSpacesFromFilenames", false),
        show_all_gpu_vendors: bool_or(&incoming, "showAllGpuVendors", false),
        notify_on_conversion_complete: bool_or(&incoming, "notifyOnConversionComplete", true),
        prevent_sleep_while_converting: bool_or(&incoming, "preventSleepWhileConverting", false),
        setup_wizard_completed,
        recent_preset_ids: normalize_recent_preset_ids(incoming.get("recentPresetIds")),
        ui_panels: normalize_ui_panels(
            incoming.get("uiPanels").unwrap_or(&Value::Null),
            defaults.ui_panels,
        ),
        advanced_format_settings: normalize_advanced(
            incoming.get("advancedFormatSettings").unwrap_or(&Value::Null),
            &defaults.advanced_format_settings,
        ),
    }
}

// ── schema 7 tier-default migration (v1 advancedFormatMigration.ts) ─────────

#[derive(Clone, Copy)]
enum Expected {
    Num(i64),
    Text(&'static str),
    Bool(bool),
}

impl Expected {
    fn matches(self, value: &Value) -> bool {
        match self {
            Self::Num(expected) => value.as_i64() == Some(expected),
            Self::Text(expected) => value.as_str() == Some(expected),
            Self::Bool(expected) => value.as_bool() == Some(expected),
        }
    }
}

const LEGACY_AV1: &[(&str, &[&[(&str, Expected)]])] = &[
    (
        "bestQuality",
        &[
            &[("quality", Expected::Num(15)), ("cpuPreset", Expected::Num(2)), ("audioBitrateKbps", Expected::Num(256))],
            &[("quality", Expected::Num(18)), ("cpuPreset", Expected::Num(2)), ("audioBitrateKbps", Expected::Num(256))],
        ],
    ),
    (
        "quality",
        &[
            &[("quality", Expected::Num(20)), ("cpuPreset", Expected::Num(4)), ("audioBitrateKbps", Expected::Num(192))],
            &[("quality", Expected::Num(24)), ("cpuPreset", Expected::Num(4)), ("audioBitrateKbps", Expected::Num(192))],
        ],
    ),
    ("balanced", &[&[("quality", Expected::Num(30)), ("cpuPreset", Expected::Num(6)), ("audioBitrateKbps", Expected::Num(128))]]),
    (
        "bestCompression",
        &[&[("quality", Expected::Num(38)), ("cpuPreset", Expected::Num(2)), ("audioBitrateKbps", Expected::Num(96))]],
    ),
    (
        "compression",
        &[
            &[("quality", Expected::Num(40)), ("cpuPreset", Expected::Num(6)), ("audioBitrateKbps", Expected::Num(96))],
            &[("quality", Expected::Num(44)), ("cpuPreset", Expected::Num(6)), ("audioBitrateKbps", Expected::Num(96))],
        ],
    ),
];

const LEGACY_H265: &[(&str, &[&[(&str, Expected)]])] = &[
    (
        "bestQuality",
        &[&[
            ("quality", Expected::Num(16)),
            ("preset", Expected::Text("veryslow")),
            ("audioBitrateKbps", Expected::Num(256)),
            ("useAdvancedParams", Expected::Bool(true)),
        ]],
    ),
    (
        "bestCompression",
        &[&[
            ("quality", Expected::Num(32)),
            ("preset", Expected::Text("veryslow")),
            ("audioBitrateKbps", Expected::Num(96)),
            ("useAdvancedParams", Expected::Bool(true)),
        ]],
    ),
];

const LEGACY_AVI: &[(&str, &[&[(&str, Expected)]])] = &[
    (
        "bestQuality",
        &[
            &[
                ("codec", Expected::Text("h265")),
                ("quality", Expected::Num(16)),
                ("preset", Expected::Text("veryslow")),
                ("audioBitrateKbps", Expected::Num(256)),
                ("useAdvancedParams", Expected::Bool(true)),
            ],
            &[
                ("codec", Expected::Text("h264")),
                ("quality", Expected::Num(16)),
                ("preset", Expected::Text("veryslow")),
                ("audioBitrateKbps", Expected::Num(256)),
                ("useAdvancedParams", Expected::Bool(false)),
            ],
        ],
    ),
    (
        "bestCompression",
        &[
            &[
                ("codec", Expected::Text("h265")),
                ("quality", Expected::Num(26)),
                ("preset", Expected::Text("veryslow")),
                ("audioBitrateKbps", Expected::Num(128)),
                ("useAdvancedParams", Expected::Bool(true)),
            ],
            &[
                ("codec", Expected::Text("h264")),
                ("quality", Expected::Num(26)),
                ("preset", Expected::Text("veryslow")),
                ("audioBitrateKbps", Expected::Num(128)),
                ("useAdvancedParams", Expected::Bool(false)),
            ],
        ],
    ),
    (
        "balanced",
        &[&[
            ("codec", Expected::Text("h264")),
            ("quality", Expected::Num(20)),
            ("preset", Expected::Text("slow")),
            ("audioBitrateKbps", Expected::Num(192)),
            ("useAdvancedParams", Expected::Bool(false)),
        ]],
    ),
];

fn tier_matches(stored: Option<&Value>, legacy: &[(&str, Expected)]) -> bool {
    let Some(stored) = stored.and_then(Value::as_object) else {
        return false;
    };
    legacy.iter().all(|(field, expected)| {
        stored
            .get(*field)
            .is_some_and(|value| expected.matches(value))
    })
}

fn replace_legacy_tiers(
    raw: &mut Map<String, Value>,
    format: &str,
    legacy: &[(&str, &[&[(&str, Expected)]])],
) {
    let Some(advanced) = raw.get_mut("advancedFormatSettings").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(tiers) = advanced
        .get_mut(format)
        .and_then(Value::as_object_mut)
        .and_then(|format| format.get_mut("tiers"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let defaults = default_advanced_format_settings();
    for (tier, legacy_list) in legacy {
        if legacy_list.iter().any(|entry| tier_matches(tiers.get(*tier), entry)) {
            let replacement = serde_json::to_value(match (format, *tier) {
                ("av1", "bestQuality") => json!(defaults.av1.tiers.best_quality),
                ("av1", "quality") => json!(defaults.av1.tiers.quality),
                ("av1", "balanced") => json!(defaults.av1.tiers.balanced),
                ("av1", "bestCompression") => json!(defaults.av1.tiers.best_compression),
                ("av1", "compression") => json!(defaults.av1.tiers.compression),
                ("h265", "bestQuality") => json!(defaults.h265.tiers.best_quality),
                ("h265", "bestCompression") => json!(defaults.h265.tiers.best_compression),
                ("avi", "bestQuality") => json!(defaults.avi.tiers.best_quality),
                ("avi", "bestCompression") => json!(defaults.avi.tiers.best_compression),
                ("avi", "balanced") => json!(defaults.avi.tiers.balanced),
                _ => continue,
            })
            .unwrap_or(Value::Null);
            tiers.insert((*tier).to_string(), replacement);
        }
    }
}

fn migrate_legacy_tier_defaults(mut raw: Map<String, Value>) -> Map<String, Value> {
    replace_legacy_tiers(&mut raw, "av1", LEGACY_AV1);
    replace_legacy_tiers(&mut raw, "h265", LEGACY_H265);
    replace_legacy_tiers(&mut raw, "avi", LEGACY_AVI);
    raw
}

// ── persistence ────────────────────────────────────────────────────────────

fn back_up_corrupt(settings_path: &std::path::Path) {
    let backup = settings_path.with_extension(format!("json.corrupt-{}", crate::app_state::now_ms()));
    if let Err(error) = std::fs::copy(settings_path, &backup) {
        crate::logging::warn(&format!(
            "Could not back up the corrupt settings file {}: {error}",
            settings_path.display()
        ));
    }
}

/// Read + normalize the file. Corrupt files are backed up; an outdated schema
/// is normalized and re-persisted.
fn read_settings_file() -> (AppSettings, bool) {
    let path = settings_path();
    let _ = std::fs::remove_file(path.with_extension("json.tmp"));
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) if raw.len() as u64 <= MAX_SETTINGS_FILE_BYTES => raw,
        Ok(_) => {
            crate::logging::warn("settings.json is larger than 2 MB; using defaults");
            back_up_corrupt(&path);
            return (default_settings(), true);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (default_settings(), false)
        }
        Err(error) => {
            crate::logging::warn(&format!("Could not read settings.json: {error}"));
            return (default_settings(), false);
        }
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            crate::logging::warn(&format!("Could not parse settings.json: {error}"));
            back_up_corrupt(&path);
            return (default_settings(), true);
        }
    };
    let Some(mut incoming) = parsed.as_object().cloned() else {
        back_up_corrupt(&path);
        return (default_settings(), true);
    };
    let stored_version = incoming
        .get("settingsSchemaVersion")
        .and_then(Value::as_f64)
        .filter(|version| version.fract() == 0.0 && *version >= 0.0);
    let predates_tier_migration = stored_version
        .is_none_or(|version| version < f64::from(TIER_DEFAULTS_MIGRATION_VERSION));
    if predates_tier_migration {
        incoming = migrate_legacy_tier_defaults(incoming);
    }
    let outdated = stored_version != Some(f64::from(CURRENT_SETTINGS_VERSION));
    (normalize_settings(&Value::Object(incoming)), outdated)
}

fn write_settings_atomic(settings: &AppSettings) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    crate::fs_util::atomic_write(&settings_path(), &serialized).map_err(|error| error.to_string())
}

fn save_to_disk(settings: &AppSettings) -> Result<(), String> {
    write_settings_atomic(settings)?;
    *SETTINGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(settings.clone());
    Ok(())
}

/// Load once at startup, after legacy import and before any settings reader.
pub fn init() {
    let (settings, should_persist) = read_settings_file();
    if should_persist {
        if let Err(error) = write_settings_atomic(&settings) {
            crate::logging::warn(&format!("Could not persist upgraded settings: {error}"));
        }
    }
    *SETTINGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(settings);
}

pub fn current() -> AppSettings {
    let mut guard = SETTINGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(settings) = guard.as_ref() {
        return settings.clone();
    }
    let (settings, should_persist) = read_settings_file();
    if should_persist {
        if let Err(error) = write_settings_atomic(&settings) {
            crate::logging::warn(&format!("Could not persist upgraded settings: {error}"));
        }
    }
    *guard = Some(settings.clone());
    settings
}

/// Used by the one-time v1 import before the in-memory copy exists.
pub fn import_legacy(raw: Value) -> Result<(), String> {
    let settings = normalize_settings(&raw);
    save_to_disk(&settings)
}

fn merge_patch(current: &AppSettings, patch: &Map<String, Value>) -> AppSettings {
    for key in patch.keys() {
        if !ALLOWED_SETTINGS_KEYS.contains(&key.as_str()) {
            crate::logging::warn(&format!("save-settings: unexpected field \"{key}\" – ignored"));
        }
    }
    let mut merged = match serde_json::to_value(current) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        if ALLOWED_SETTINGS_KEYS.contains(&key.as_str()) {
            merged.insert(key.clone(), value.clone());
        }
    }
    // Nested settings merge one level deeper than a plain overwrite.
    if let Some(value) = patch.get("uiPanels") {
        merged.insert(
            "uiPanels".into(),
            serde_json::to_value(normalize_ui_panels(value, current.ui_panels)).unwrap_or(Value::Null),
        );
    }
    if let Some(value) = patch.get("advancedFormatSettings") {
        merged.insert(
            "advancedFormatSettings".into(),
            serde_json::to_value(merge_advanced(&current.advanced_format_settings, value))
                .unwrap_or(Value::Null),
        );
    }
    // A GPU vendor without a mode means manual, as in v1.
    if patch.contains_key("gpuManualVendor") || patch.contains_key("gpu") {
        merged.insert(
            "gpuMode".into(),
            Value::String(
                if patch.contains_key("gpuMode") {
                    normalize_gpu_mode(patch.get("gpuMode"))
                } else {
                    GpuMode::Manual
                }
                .as_str()
                .to_string(),
            ),
        );
        let vendor = normalize_gpu(
            patch
                .get("gpuManualVendor")
                .or_else(|| patch.get("gpu"))
                .or(Some(&Value::Null)),
        );
        merged.insert("gpu".into(), Value::String(vendor.as_str().to_string()));
        merged.insert("gpuManualVendor".into(), Value::String(vendor.as_str().to_string()));
    }
    normalize_settings(&Value::Object(merged))
}

// ── commands ───────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_settings() -> IpcResult<AppSettings> {
    ipc::ok(current())
}

#[tauri::command(async)]
pub fn get_default_settings() -> IpcResult<AppSettings> {
    ipc::ok(default_settings())
}

#[tauri::command(async)]
pub fn save_settings(settings: FalliblePayload<JsonObject<Value>>) -> IpcResult<()> {
    let patch = match settings.into_typed(
        crate::ipc::VALIDATION_ERROR,
        "Settings payload must be a JSON object.",
    ) {
        Ok(JsonObject(value)) => value,
        Err(error) => return ipc::from_error(error),
    };
    let Some(patch) = patch.as_object().cloned() else {
        return ipc::err(
            crate::ipc::VALIDATION_ERROR,
            "Settings payload must be a JSON object.",
        );
    };
    let _save = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let next = merge_patch(&current(), &patch);
    match save_to_disk(&next) {
        Ok(()) => ipc::ok(()),
        Err(error) => {
            crate::logging::error(&format!("Failed to save settings: {error}"));
            ipc::err(INTERNAL_ERROR, format!("Failed to save settings: {error}"))
        }
    }
}

#[tauri::command(async)]
pub fn reset_settings() -> IpcResult<AppSettings> {
    let defaults = default_settings();
    match save_to_disk(&defaults) {
        Ok(()) => ipc::ok(defaults),
        Err(error) => {
            crate::logging::error(&format!("Failed to reset settings: {error}"));
            ipc::err(INTERNAL_ERROR, format!("Failed to reset settings: {error}"))
        }
    }
}
