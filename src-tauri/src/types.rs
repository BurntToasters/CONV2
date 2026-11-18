//! Shared data model. Field names serialize as camelCase so the frontend sees
//! the same shapes the CONV2 v1 Electron preload bridge exposed.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A closed set of setting values, serialized as fixed strings.
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            #[allow(dead_code)]
            pub const NAMES: &'static [&'static str] = &[$($text),+];

            // Not every enum is converted back to its name outside serde.
            #[allow(dead_code)]
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            #[allow(dead_code)]
            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

string_enum!(GpuVendor {
    Nvidia => "nvidia",
    Amd => "amd",
    Intel => "intel",
    Qualcomm => "qualcomm",
    Apple => "apple",
    Cpu => "cpu",
});

string_enum!(GpuMode {
    Auto => "auto",
    Manual => "manual",
});

string_enum!(GpuCodec {
    H264 => "h264",
    H265 => "h265",
    Av1 => "av1",
});

string_enum!(QueueItemStatus {
    Pending => "pending",
    Running => "running",
    Done => "done",
    Failed => "failed",
    Cancelled => "cancelled",
});

string_enum!(ThemePreference {
    System => "system",
    Dark => "dark",
    Light => "light",
    Custom => "custom",
});

string_enum!(CustomThemeId {
    MidnightBlue => "midnight-blue",
    HighContrastDark => "high-contrast-dark",
});

string_enum!(InterfaceStyle {
    Glass => "glass",
    Flat => "flat",
});

string_enum!(UpdateChannel {
    Auto => "auto",
    Stable => "stable",
    Beta => "beta",
});

string_enum!(GifLoopMode {
    Forever => "forever",
    Once => "once",
});

string_enum!(GifDither {
    Sierra2_4a => "sierra2_4a",
    FloydSteinberg => "floyd_steinberg",
    Bayer => "bayer",
    None => "none",
});

string_enum!(VideoPreset {
    Ultrafast => "ultrafast",
    Superfast => "superfast",
    Veryfast => "veryfast",
    Faster => "faster",
    Fast => "fast",
    Medium => "medium",
    Slow => "slow",
    Slower => "slower",
    Veryslow => "veryslow",
    Placebo => "placebo",
});

string_enum!(AviCodec {
    H264 => "h264",
    H265 => "h265",
});

string_enum!(UpdatePhase {
    Checking => "checking",
    Available => "available",
    NotAvailable => "not-available",
    Downloading => "downloading",
    Downloaded => "downloaded",
    Installing => "installing",
    Error => "error",
    Disabled => "disabled",
    AlreadyChecking => "already-checking",
});

string_enum!(FFmpegStatusReason {
    Ok => "ok",
    Missing => "missing",
    VerificationFailed => "verification-failed",
    NotRunnable => "not-runnable",
});

/// `UIPanelSettings` from v1's settingsSchema.ts.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UIPanelSettings {
    pub preset_expanded: bool,
    pub gpu_expanded: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GifTierSettings {
    pub fps: u32,
    pub max_dimension: u32,
    pub max_colors: u32,
    pub dither: GifDither,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GifTierCollection {
    pub best_quality: GifTierSettings,
    pub quality: GifTierSettings,
    pub balanced: GifTierSettings,
    pub best_compression: GifTierSettings,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GifAdvancedSettings {
    pub loop_mode: GifLoopMode,
    pub tiers: GifTierCollection,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WebpTierSettings {
    pub fps: u32,
    pub max_dimension: u32,
    pub quality: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WebpTierCollection {
    pub best_quality: WebpTierSettings,
    pub quality: WebpTierSettings,
    pub balanced: WebpTierSettings,
    pub best_compression: WebpTierSettings,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WebpAdvancedSettings {
    pub loop_mode: GifLoopMode,
    pub tiers: WebpTierCollection,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Av1TierSettings {
    pub quality: u32,
    pub cpu_preset: u32,
    pub audio_bitrate_kbps: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Av1TierCollection {
    pub best_quality: Av1TierSettings,
    pub quality: Av1TierSettings,
    pub balanced: Av1TierSettings,
    pub best_compression: Av1TierSettings,
    pub compression: Av1TierSettings,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Av1AdvancedSettings {
    pub tiers: Av1TierCollection,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct H264TierSettings {
    pub quality: u32,
    pub preset: VideoPreset,
    pub audio_bitrate_kbps: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct H264TierCollection {
    pub fast: H264TierSettings,
    pub quality: H264TierSettings,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct H264AdvancedSettings {
    pub tiers: H264TierCollection,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct H265TierSettings {
    pub quality: u32,
    pub preset: VideoPreset,
    pub audio_bitrate_kbps: u32,
    pub use_advanced_params: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct H265TierCollection {
    pub best_quality: H265TierSettings,
    pub quality: H265TierSettings,
    pub balanced: H265TierSettings,
    pub best_compression: H265TierSettings,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct H265AdvancedSettings {
    pub tiers: H265TierCollection,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AviTierSettings {
    pub codec: AviCodec,
    pub quality: u32,
    pub preset: VideoPreset,
    pub audio_bitrate_kbps: u32,
    pub use_advanced_params: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AviTierCollection {
    pub best_quality: AviTierSettings,
    pub best_compression: AviTierSettings,
    pub balanced: AviTierSettings,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AviAdvancedSettings {
    pub tiers: AviTierCollection,
}

/// `AdvancedFormatSettings` from v1's advancedFormats.ts: per-format quality
/// tiers the settings UI edits.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AdvancedFormatSettings {
    pub gif: GifAdvancedSettings,
    pub webp: WebpAdvancedSettings,
    pub av1: Av1AdvancedSettings,
    pub h264: H264AdvancedSettings,
    pub h265: H265AdvancedSettings,
    pub avi: AviAdvancedSettings,
}

/// `AppSettings` from v1's shared/appContract.ts: every persisted setting at
/// schema version 7.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AppSettings {
    pub settings_schema_version: u32,
    pub output_directory: String,
    pub gpu: GpuVendor,
    pub gpu_mode: GpuMode,
    pub gpu_manual_vendor: GpuVendor,
    pub theme: ThemePreference,
    pub custom_theme: CustomThemeId,
    pub interface_style: InterfaceStyle,
    pub show_debug_output: bool,
    pub auto_check_updates: bool,
    pub use_system_ffmpeg: bool,
    pub use_cpu_decoding_when_gpu: bool,
    pub move_original_to_trash_on_success: bool,
    pub update_channel: UpdateChannel,
    pub show_advanced_presets: bool,
    pub remove_spaces_from_filenames: bool,
    pub show_all_gpu_vendors: bool,
    pub notify_on_conversion_complete: bool,
    pub prevent_sleep_while_converting: bool,
    pub setup_wizard_completed: bool,
    pub recent_preset_ids: Vec<String>,
    pub ui_panels: UIPanelSettings,
    pub advanced_format_settings: AdvancedFormatSettings,
}

/// `QueueItemSnapshot` from v1's shared/appContract.ts: one file in a batch.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct QueueItemSnapshot {
    pub id: String,
    pub input_path: String,
    pub file_name: String,
    pub status: QueueItemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Raw FFmpeg stderr tail (paths redacted) for the Details view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_cpu_fallback: Option<bool>,
}

/// `QueueSnapshot` from v1's shared/appContract.ts: the full batch state,
/// broadcast on every queue transition.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueueSnapshot {
    pub active: bool,
    pub preset_id: String,
    pub current_index: usize,
    pub total: usize,
    pub items: Vec<QueueItemSnapshot>,
}

/// `ConversionProgress` from v1's shared/appContract.ts: one FFmpeg progress
/// line, emitted as the `conversion-progress` event.
#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ConversionProgress {
    pub percent: f64,
    pub frame: u64,
    pub fps: f64,
    pub time: String,
    pub bitrate: String,
    pub speed: String,
}

/// `VideoInfo` from v1's ffmpeg.ts: the ffprobe projection `get_file_info`
/// returns. Optional keys are absent when unknown, as in v1.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct VideoInfo {
    pub duration: f64,
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub codec: String,
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pix_fmt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_primaries: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_transfer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_space: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_range: Option<String>,
    /// First audio stream's codec, used for remux container compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    /// Codec names of every subtitle stream, in subtitle-stream order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle_codecs: Option<Vec<String>>,
    /// Channel count of every audio stream, in audio-stream order (0 when unknown).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_channels: Option<Vec<u32>>,
    /// False when the probe found no video stream (audio-only files).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_video: Option<bool>,
}

/// `GPUCapabilityStatus` from v1's shared/electronApi.ts.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GPUCapabilityStatus {
    pub available: bool,
    pub reason: String,
    pub encoder: String,
}

/// `GPUCapabilitiesPayload` from v1's shared/electronApi.ts: the GPU panel
/// matrix plus the Auto recommendation.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GPUCapabilitiesPayload {
    pub platform: String,
    pub requested_codec: Option<GpuCodec>,
    pub checked_codecs: Vec<GpuCodec>,
    pub matrix: BTreeMap<String, BTreeMap<String, GPUCapabilityStatus>>,
    pub recommended_vendor: GpuVendor,
    pub recommendation_reason: String,
}

/// `UpdateStatePayload` from v1's shared/electronApi.ts, emitted as the
/// `update-state` event.
#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct UpdateStatePayload {
    pub phase: UpdatePhase,
    pub manual: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
}

/// `FFmpegStatus` from v1's shared/electronApi.ts: the main-process verdict on
/// the bundled or system FFmpeg; ok gates every spawn.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FFmpegStatus {
    pub ok: bool,
    pub reason: FFmpegStatusReason,
    pub using_bundled: bool,
}

/// `RendererPreset` from v1's shared/electronApi.ts: the preset projection the
/// preset picker renders.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RendererPreset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub category_label: String,
    pub category_order: i32,
    pub is_advanced: bool,
    pub extension: String,
    /// AVI preset tier name, or null for every non-AVI preset.
    pub avi_tier: Option<String>,
}

/// `StartConversionQueuePayload` from v1's shared/electronApi.ts.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct StartConversionQueuePayload {
    pub input_paths: Vec<String>,
    pub preset_id: String,
    pub gpu: GpuVendor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_spaces_from_filenames: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_debug_output: Option<bool>,
}

/// `GPUEncoderError` from v1's shared/electronApi.ts, emitted as the
/// `gpu-encoder-error` event.
#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct GPUEncoderError {
    #[serde(rename = "type")]
    #[cfg_attr(
        test,
        ts(type = "\"encoder_unavailable\" | \"gpu_capability\" | \"driver_error\" | \"unknown\"")
    )]
    pub kind: String,
    pub message: String,
    pub details: String,
    pub suggestion: String,
    #[serde(rename = "canRetryWithCPU")]
    pub can_retry_with_cpu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuVendor>,
}

/// `ConversionMenuStatePayload` from v1's shared/electronApi.ts: the renderer
/// reports menu enablement (converting, hasOutput) for native menu items.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ConversionMenuStatePayload {
    pub converting: bool,
    pub has_output: bool,
}

#[cfg(test)]
mod ts_bindings {
    //! `src/generated/ipc-types.ts` is generated from these types. Run
    //! `CONV2_UPDATE_IPC_TYPES=1 cargo test ts_bindings` after changing them.
    //! `ts(as)`/`ts(type)` field attributes narrow `String` fields that IPC
    //! validation already restricts to a closed set.
    use super::*;
    use ts_rs::{Config, TS};

    const GENERATED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/generated/ipc-types.ts");

    fn render() -> String {
        // Timestamps and byte counts stay below 2^53, so plain numbers are exact.
        let cfg = Config::new().with_large_int("number");
        let decls = [
            GpuVendor::decl(&cfg),
            GpuMode::decl(&cfg),
            GpuCodec::decl(&cfg),
            QueueItemStatus::decl(&cfg),
            ThemePreference::decl(&cfg),
            CustomThemeId::decl(&cfg),
            InterfaceStyle::decl(&cfg),
            UpdateChannel::decl(&cfg),
            GifLoopMode::decl(&cfg),
            GifDither::decl(&cfg),
            VideoPreset::decl(&cfg),
            AviCodec::decl(&cfg),
            UpdatePhase::decl(&cfg),
            FFmpegStatusReason::decl(&cfg),
            UIPanelSettings::decl(&cfg),
            GifTierSettings::decl(&cfg),
            GifTierCollection::decl(&cfg),
            GifAdvancedSettings::decl(&cfg),
            WebpTierSettings::decl(&cfg),
            WebpTierCollection::decl(&cfg),
            WebpAdvancedSettings::decl(&cfg),
            Av1TierSettings::decl(&cfg),
            Av1TierCollection::decl(&cfg),
            Av1AdvancedSettings::decl(&cfg),
            H264TierSettings::decl(&cfg),
            H264TierCollection::decl(&cfg),
            H264AdvancedSettings::decl(&cfg),
            H265TierSettings::decl(&cfg),
            H265TierCollection::decl(&cfg),
            H265AdvancedSettings::decl(&cfg),
            AviTierSettings::decl(&cfg),
            AviTierCollection::decl(&cfg),
            AviAdvancedSettings::decl(&cfg),
            AdvancedFormatSettings::decl(&cfg),
            AppSettings::decl(&cfg),
            QueueItemSnapshot::decl(&cfg),
            QueueSnapshot::decl(&cfg),
            ConversionProgress::decl(&cfg),
            VideoInfo::decl(&cfg),
            GPUCapabilityStatus::decl(&cfg),
            GPUCapabilitiesPayload::decl(&cfg),
            UpdateStatePayload::decl(&cfg),
            FFmpegStatus::decl(&cfg),
            RendererPreset::decl(&cfg),
            StartConversionQueuePayload::decl(&cfg),
            GPUEncoderError::decl(&cfg),
            ConversionMenuStatePayload::decl(&cfg),
            crate::ipc::IpcError::decl(&cfg),
        ];
        let mut out = String::from(
            "// Generated from src-tauri/src/types.rs by the ts_bindings test. Do not edit.\n",
        );
        for decl in decls {
            out.push_str("\nexport ");
            out.push_str(&decl);
            out.push('\n');
        }
        out
    }

    #[test]
    fn generated_ipc_types_are_current() {
        let rendered = render();
        if std::env::var("CONV2_UPDATE_IPC_TYPES").as_deref() == Ok("1") {
            std::fs::write(GENERATED, &rendered).expect("write generated IPC types");
            return;
        }
        let committed = std::fs::read_to_string(GENERATED).unwrap_or_default();
        assert!(
            committed == rendered,
            "src/generated/ipc-types.ts is stale; run CONV2_UPDATE_IPC_TYPES=1 cargo test ts_bindings"
        );
    }
}
