//! Preset definitions and FFmpeg argument construction: v1's presets.ts and
//! presetProjection.ts, plus the renderer-facing preset list.

use crate::gpu::{resolve_encoder, uses_vaapi};
use crate::ipc::{self, IpcResult};
use crate::settings::default_advanced_format_settings;
use crate::types::{
    AdvancedFormatSettings, Av1TierSettings, AviTierSettings, GifTierSettings, GpuCodec, GpuVendor,
    H264TierSettings, H265TierSettings, RendererPreset, VideoPreset, WebpTierSettings,
};

/// Stream layout of the input, probed before arguments are built.
#[derive(Clone, Debug, Default)]
pub struct SourceStreamInfo {
    pub subtitle_codecs: Option<Vec<String>>,
    pub audio_channels: Option<Vec<u32>>,
}

#[derive(Clone, Copy)]
pub struct PresetContext<'a> {
    pub advanced_format_settings: Option<&'a AdvancedFormatSettings>,
    pub source_streams: Option<&'a SourceStreamInfo>,
    pub platform: &'a str,
}

impl Default for PresetContext<'_> {
    fn default() -> Self {
        Self {
            advanced_format_settings: None,
            source_streams: None,
            platform: crate::types_ffmpeg::node_platform(),
        }
    }
}

pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub extension: &'static str,
    pub gpu_codec: Option<GpuCodec>,
    pub avi_tier: Option<&'static str>,
}

const PRESET_CATEGORY_ORDER: &[&str] = &[
    "av1", "h264", "h265", "avi", "gif", "webp", "remux", "audio",
];
const ADVANCED_PRESET_CATEGORIES: &[&str] = &["avi"];

fn category_label(category: &str) -> &'static str {
    match category {
        "av1" => "AV1",
        "h264" => "H.264",
        "h265" => "H.265/HEVC",
        "avi" => "AVI",
        "gif" => "GIF",
        "webp" => "WebP (Animated)",
        "remux" => "Remux",
        "audio" => "Audio",
        _ => "Custom",
    }
}

fn category_order(category: &str) -> i32 {
    PRESET_CATEGORY_ORDER
        .iter()
        .position(|entry| *entry == category)
        .map_or(-1, |index| index as i32)
}

fn is_advanced(category: &str) -> bool {
    ADVANCED_PRESET_CATEGORIES.contains(&category)
}

const AV1_BALANCED: &str = "av1-balanced";
const AV1_QUALITY: &str = "av1-quality";
const AV1_BEST_QUALITY: &str = "av1-best-quality";
const AV1_BEST_COMPRESSION: &str = "av1-best-compression";
const AV1_COMPRESSION: &str = "av1-compression";
const H264_FAST: &str = "h264-fast";
const H264_QUALITY: &str = "h264-quality";
const H265_BALANCED: &str = "h265-balanced";
const H265_QUALITY: &str = "h265-quality";
const H265_BEST_QUALITY: &str = "h265-best-quality";
const H265_BEST_COMPRESSION: &str = "h265-best-compression";
const AVI_BEST_QUALITY: &str = "avi-best-quality";
const AVI_BEST_COMPRESSION: &str = "avi-best-compression";
const AVI_BALANCED: &str = "avi-balanced";
const GIF_BEST_QUALITY: &str = "gif-best-quality";
const GIF_QUALITY: &str = "gif-quality";
const GIF_BALANCED: &str = "gif-balanced";
const GIF_BEST_COMPRESSION: &str = "gif-best-compression";
const WEBP_BEST_QUALITY: &str = "webp-best-quality";
const WEBP_QUALITY: &str = "webp-quality";
const WEBP_BALANCED: &str = "webp-balanced";
const WEBP_BEST_COMPRESSION: &str = "webp-best-compression";

macro_rules! preset {
    ($id:expr, $name:literal, $description:literal, $category:literal, $extension:literal $(, gpu: $gpu:ident)? $(, tier: $tier:literal)?) => {
        Preset {
            id: $id,
            name: $name,
            description: $description,
            category: $category,
            extension: $extension,
            gpu_codec: preset!(@gpu $($gpu)?),
            avi_tier: preset!(@tier $($tier)?),
        }
    };
    (@gpu) => { None };
    (@gpu $gpu:ident) => { Some(GpuCodec::$gpu) };
    (@tier) => { None };
    (@tier $tier:literal) => { Some($tier) };
}

pub static PRESETS: &[Preset] = &[
    preset!(AV1_BALANCED, "AV1 - Balanced", "Good balance between quality and file size", "av1", "mp4", gpu: Av1),
    preset!(AV1_QUALITY, "AV1 - Quality", "High quality AV1 encoding", "av1", "mp4", gpu: Av1),
    preset!(AV1_BEST_QUALITY, "AV1 - Best Quality", "Maximum quality, 10-bit, with strong compression", "av1", "mp4", gpu: Av1),
    preset!(AV1_BEST_COMPRESSION, "AV1 - Best Compression", "Smallest file size with comparable quality", "av1", "mp4", gpu: Av1),
    preset!(AV1_COMPRESSION, "AV1 - Small File", "Smaller file size, faster encoding", "av1", "mp4", gpu: Av1),
    preset!(H264_FAST, "H.264 - Fast", "Quick encoding, universal compatibility", "h264", "mp4", gpu: H264),
    preset!(H264_QUALITY, "H.264 - Quality", "Better quality H.264 encoding", "h264", "mp4", gpu: H264),
    preset!(H265_BALANCED, "H.265/HEVC - Balanced", "Good compression with wide device support", "h265", "mp4", gpu: H265),
    preset!(H265_QUALITY, "H.265/HEVC - Quality", "High quality HEVC encoding", "h265", "mp4", gpu: H265),
    preset!(H265_BEST_QUALITY, "H.265/HEVC - Best Quality", "Maximum quality with best compression", "h265", "mp4", gpu: H265),
    preset!(H265_BEST_COMPRESSION, "H.265/HEVC - Best Compression", "Smallest file size, some quality sacrificed", "h265", "mp4", gpu: H265),
    preset!(AVI_BEST_QUALITY, "AVI - Best Quality", "AVI container with H.264 best quality encoding", "avi", "avi", gpu: H264, tier: "bestQuality"),
    preset!(AVI_BEST_COMPRESSION, "AVI - Best Compression", "AVI container with H.264 best compression", "avi", "avi", gpu: H264, tier: "bestCompression"),
    preset!(AVI_BALANCED, "AVI - Balanced", "AVI container with H.264 balanced encoding", "avi", "avi", gpu: H264, tier: "balanced"),
    preset!(
        GIF_BEST_QUALITY,
        "GIF - Best Quality",
        "Maximum GIF quality with highest color detail",
        "gif",
        "gif"
    ),
    preset!(
        GIF_QUALITY,
        "GIF - Quality",
        "High quality GIF with smaller file size",
        "gif",
        "gif"
    ),
    preset!(
        GIF_BALANCED,
        "GIF - Balanced",
        "Balanced GIF output for quality and compression",
        "gif",
        "gif"
    ),
    preset!(
        GIF_BEST_COMPRESSION,
        "GIF - Best Compression",
        "Smallest GIF size with comparable quality",
        "gif",
        "gif"
    ),
    preset!(
        WEBP_BEST_QUALITY,
        "WebP - Best Quality",
        "Maximum animated WebP quality with highest detail",
        "webp",
        "webp"
    ),
    preset!(
        WEBP_QUALITY,
        "WebP - Quality",
        "High quality animated WebP with smaller file size",
        "webp",
        "webp"
    ),
    preset!(
        WEBP_BALANCED,
        "WebP - Balanced",
        "Balanced animated WebP for quality and compression",
        "webp",
        "webp"
    ),
    preset!(
        WEBP_BEST_COMPRESSION,
        "WebP - Best Compression",
        "Smallest animated WebP size with comparable quality",
        "webp",
        "webp"
    ),
    preset!(
        "remux-mp4",
        "Remux to MP4",
        "Copy streams to MP4 container (no re-encoding)",
        "remux",
        "mp4"
    ),
    preset!(
        "remux-mkv",
        "Remux to MKV",
        "Copy streams to MKV container (no re-encoding)",
        "remux",
        "mkv"
    ),
    preset!(
        "remux-webm",
        "Remux to WebM",
        "Copy streams to WebM container (no re-encoding)",
        "remux",
        "webm"
    ),
    preset!(
        "audio-mp3",
        "Extract Audio (MP3)",
        "Extract audio track as MP3",
        "audio",
        "mp3"
    ),
    preset!(
        "audio-aac",
        "Extract Audio (AAC)",
        "Extract audio track as AAC",
        "audio",
        "aac"
    ),
    preset!(
        "audio-flac",
        "Extract Audio (FLAC)",
        "Extract audio track as lossless FLAC",
        "audio",
        "flac"
    ),
];

pub fn get_preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|preset| preset.id == id)
}

pub fn map_presets_for_renderer() -> Vec<RendererPreset> {
    PRESETS
        .iter()
        .map(|preset| RendererPreset {
            id: preset.id.to_string(),
            name: preset.name.to_string(),
            description: preset.description.to_string(),
            category: preset.category.to_string(),
            category_label: category_label(preset.category).to_string(),
            category_order: category_order(preset.category),
            is_advanced: is_advanced(preset.category),
            extension: preset.extension.to_string(),
            avi_tier: preset.avi_tier.map(str::to_string),
        })
        .collect()
}

#[tauri::command(async)]
pub fn get_presets() -> IpcResult<Vec<RendererPreset>> {
    ipc::ok(map_presets_for_renderer())
}

// ── quality / encoder helpers ──────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum EncodeVendor {
    Cpu,
    Vaapi,
    Vendor(GpuVendor),
}

/// Some vendor/codec pairs have no hardware encoder and fall back to CPU;
/// the argument style must follow the encoder that actually runs.
pub(crate) fn resolve_encode_vendor(
    codec: GpuCodec,
    gpu: GpuVendor,
    platform: &str,
) -> EncodeVendor {
    if uses_vaapi(gpu, platform) {
        return EncodeVendor::Vaapi;
    }
    let encoder = resolve_encoder(codec, gpu, platform);
    let cpu_encoder = resolve_encoder(codec, GpuVendor::Cpu, platform);
    if encoder == cpu_encoder {
        EncodeVendor::Cpu
    } else {
        EncodeVendor::Vendor(gpu)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EncodeEffort {
    Max,
    High,
    Balanced,
    Fast,
}

fn effort_from_preset(preset: VideoPreset) -> EncodeEffort {
    match preset {
        VideoPreset::Placebo | VideoPreset::Veryslow | VideoPreset::Slower => EncodeEffort::Max,
        VideoPreset::Slow => EncodeEffort::High,
        VideoPreset::Medium => EncodeEffort::Balanced,
        VideoPreset::Fast
        | VideoPreset::Faster
        | VideoPreset::Veryfast
        | VideoPreset::Superfast
        | VideoPreset::Ultrafast => EncodeEffort::Fast,
    }
}

fn effort_from_cpu_preset(preset: u32) -> EncodeEffort {
    if preset <= 3 {
        EncodeEffort::Max
    } else if preset <= 5 {
        EncodeEffort::High
    } else if preset <= 7 {
        EncodeEffort::Balanced
    } else {
        EncodeEffort::Fast
    }
}

const GPU_QP_MAX: u32 = 51;

/// Maps a 0..51 QP onto the 1..100 quality scale used by VideoToolbox and MF.
fn qp_to_percent_quality(qp: u32) -> u32 {
    (1.0 - f64::from(qp) / f64::from(GPU_QP_MAX))
        .mul_add(100.0, 0.0)
        .round()
        .clamp(1.0, 100.0) as u32
}

fn quality_args(
    gpu: GpuVendor,
    quality: u32,
    codec: GpuCodec,
    effort: EncodeEffort,
    platform: &str,
) -> Vec<String> {
    let qp = quality.min(GPU_QP_MAX);
    let hw_quality = qp.to_string();
    let mut args: Vec<String> = Vec::new();
    match resolve_encode_vendor(codec, gpu, platform) {
        EncodeVendor::Vaapi => {
            let clamped = qp.max(1);
            let global_quality = if codec == GpuCodec::Av1 {
                (clamped * 4).clamp(1, 255)
            } else {
                clamped
            };
            args.extend(
                [
                    "-rc_mode",
                    "CQP",
                    "-global_quality",
                    &global_quality.to_string(),
                ]
                .map(str::to_string),
            );
        }
        EncodeVendor::Vendor(GpuVendor::Nvidia) => {
            let (preset, multipass) = match effort {
                EncodeEffort::Max => ("p7", "fullres"),
                EncodeEffort::High => ("p6", "qres"),
                EncodeEffort::Balanced => ("p5", "disabled"),
                EncodeEffort::Fast => ("p4", "disabled"),
            };
            args.extend(
                [
                    "-cq",
                    &hw_quality,
                    "-b:v",
                    "0",
                    "-preset",
                    preset,
                    "-multipass",
                    multipass,
                ]
                .map(str::to_string),
            );
            if codec != GpuCodec::Av1 {
                args.extend(
                    ["-tune", "hq", "-spatial_aq", "1", "-temporal_aq", "1"].map(str::to_string),
                );
            }
        }
        EncodeVendor::Vendor(GpuVendor::Amd) => {
            let amf = match effort {
                EncodeEffort::Max | EncodeEffort::High => "quality",
                EncodeEffort::Balanced => "balanced",
                EncodeEffort::Fast => "speed",
            };
            args.extend(
                [
                    "-rc",
                    "cqp",
                    "-qp_i",
                    &hw_quality,
                    "-qp_p",
                    &hw_quality,
                    "-quality",
                    amf,
                ]
                .map(str::to_string),
            );
        }
        EncodeVendor::Vendor(GpuVendor::Intel) => {
            let (preset, lookahead) = match effort {
                EncodeEffort::Max => ("veryslow", 60),
                EncodeEffort::High => ("slower", 40),
                EncodeEffort::Balanced => ("medium", 25),
                EncodeEffort::Fast => ("faster", 0),
            };
            args.extend(["-global_quality", &hw_quality, "-preset", preset].map(str::to_string));
            if codec != GpuCodec::Av1 && lookahead > 0 {
                args.extend(
                    [
                        "-look_ahead",
                        "1",
                        "-look_ahead_depth",
                        &lookahead.to_string(),
                        "-extbrc",
                        "1",
                    ]
                    .map(str::to_string),
                );
            }
        }
        EncodeVendor::Vendor(GpuVendor::Apple) => {
            args.extend(
                [
                    "-q:v",
                    &qp_to_percent_quality(qp).to_string(),
                    "-allow_sw",
                    "1",
                    "-realtime",
                    "0",
                ]
                .map(str::to_string),
            );
            if effort == EncodeEffort::Fast {
                args.extend(["-prio_speed", "1"].map(str::to_string));
            }
        }
        EncodeVendor::Vendor(GpuVendor::Qualcomm) => {
            args.extend(
                [
                    "-hw_encoding",
                    "1",
                    "-rate_control",
                    "quality",
                    "-quality",
                    &qp_to_percent_quality(qp).to_string(),
                ]
                .map(str::to_string),
            );
        }
        EncodeVendor::Vendor(GpuVendor::Cpu) | EncodeVendor::Cpu => {
            args.extend(["-crf", &quality.to_string()].map(str::to_string));
        }
    }
    args
}

/// v1's effectiveConversionGpu: the vendor a conversion should request before
/// the encoder check, given platform/codec limits.
pub fn effective_conversion_gpu(
    gpu: GpuVendor,
    codec: Option<GpuCodec>,
    platform: &str,
    arch: &str,
) -> GpuVendor {
    if gpu == GpuVendor::Qualcomm && !crate::gpu::supports_qualcomm(platform, arch) {
        return GpuVendor::Cpu;
    }
    if gpu == GpuVendor::Apple && codec == Some(GpuCodec::Av1) {
        return GpuVendor::Cpu;
    }
    gpu
}

/// The codec a preset will encode with, used to check GPU support first.
pub fn preset_gpu_codec(preset: &Preset, advanced: &AdvancedFormatSettings) -> Option<GpuCodec> {
    if matches!(preset.category, "av1" | "h264" | "h265") {
        return GpuCodec::parse(preset.category);
    }
    if preset.category == "avi" {
        let tier = preset.avi_tier.unwrap_or("balanced");
        return Some(avi_gpu_codec(match tier {
            "bestQuality" => advanced.avi.tiers.best_quality.codec,
            "bestCompression" => advanced.avi.tiers.best_compression.codec,
            _ => advanced.avi.tiers.balanced.codec,
        }));
    }
    preset.gpu_codec
}

// ── argument builders ──────────────────────────────────────────────────────

fn advanced(context: PresetContext<'_>) -> AdvancedFormatSettings {
    context
        .advanced_format_settings
        .copied()
        .unwrap_or_else(default_advanced_format_settings)
}

fn gif_tier(tier: &str, context: PresetContext<'_>) -> GifTierSettings {
    let settings = advanced(context);
    match tier {
        "bestQuality" => settings.gif.tiers.best_quality,
        "quality" => settings.gif.tiers.quality,
        "balanced" => settings.gif.tiers.balanced,
        _ => settings.gif.tiers.best_compression,
    }
}

fn webp_tier(tier: &str, context: PresetContext<'_>) -> WebpTierSettings {
    let settings = advanced(context);
    match tier {
        "bestQuality" => settings.webp.tiers.best_quality,
        "quality" => settings.webp.tiers.quality,
        "balanced" => settings.webp.tiers.balanced,
        _ => settings.webp.tiers.best_compression,
    }
}

fn av1_tier(tier: &str, context: PresetContext<'_>) -> Av1TierSettings {
    let settings = advanced(context);
    match tier {
        "bestQuality" => settings.av1.tiers.best_quality,
        "quality" => settings.av1.tiers.quality,
        "balanced" => settings.av1.tiers.balanced,
        "bestCompression" => settings.av1.tiers.best_compression,
        _ => settings.av1.tiers.compression,
    }
}

fn h264_tier(tier: &str, context: PresetContext<'_>) -> H264TierSettings {
    let settings = advanced(context);
    if tier == "fast" {
        settings.h264.tiers.fast
    } else {
        settings.h264.tiers.quality
    }
}

fn h265_tier(tier: &str, context: PresetContext<'_>) -> H265TierSettings {
    let settings = advanced(context);
    match tier {
        "bestQuality" => settings.h265.tiers.best_quality,
        "quality" => settings.h265.tiers.quality,
        "balanced" => settings.h265.tiers.balanced,
        _ => settings.h265.tiers.best_compression,
    }
}

fn avi_tier(tier: &str, context: PresetContext<'_>) -> AviTierSettings {
    let settings = advanced(context);
    match tier {
        "bestQuality" => settings.avi.tiers.best_quality,
        "bestCompression" => settings.avi.tiers.best_compression,
        _ => settings.avi.tiers.balanced,
    }
}

/// v1's AviCodec is a subset of the GPU codecs, so argument helpers take the
/// wider type.
fn avi_gpu_codec(codec: crate::types::AviCodec) -> GpuCodec {
    match codec {
        crate::types::AviCodec::H264 => GpuCodec::H264,
        crate::types::AviCodec::H265 => GpuCodec::H265,
    }
}

fn bitrate_kbps(value: u32) -> String {
    format!("{value}k")
}

fn animated_frame_filter(fps: u32, max_dimension: u32) -> String {
    format!(
        "fps='if(gt(source_fps,0),min(source_fps,{fps}),{fps})',scale='min({max_dimension},iw)':'min({max_dimension},ih)':flags=bicubic:force_original_aspect_ratio=decrease"
    )
}

fn multichannel_bitrate_args(base_kbps: u32, context: PresetContext<'_>) -> Vec<String> {
    let channels = context
        .source_streams
        .and_then(|streams| streams.audio_channels.as_ref())
        .cloned()
        .unwrap_or_default();
    let mut args = Vec::new();
    for (index, count) in channels.into_iter().enumerate() {
        if count <= 2 {
            continue;
        }
        let scale = if count > 6 { 3.5 } else { 2.5 };
        let bitrate = (f64::from(base_kbps) * scale).round().min(640.0) as u32;
        args.push(format!("-b:a:{index}"));
        args.push(bitrate_kbps(bitrate));
    }
    args
}

fn gif_args(input: &str, output: &str, tier: &str, context: PresetContext<'_>) -> Vec<String> {
    let settings = gif_tier(tier, context);
    let loop_arg = if advanced(context).gif.loop_mode == crate::types::GifLoopMode::Once {
        "-1"
    } else {
        "0"
    };
    let bscale = if settings.dither == crate::types::GifDither::Bayer {
        ":bayer_scale=5"
    } else {
        ""
    };
    let frames = animated_frame_filter(settings.fps, settings.max_dimension);
    let filter = format!(
        "[0:v]{frames},split[v0][v1];[v0]palettegen=max_colors={}:stats_mode=full[palette];[v1][palette]paletteuse=dither={}{bscale}:diff_mode=rectangle[gifout]",
        settings.max_colors,
        settings.dither.as_str()
    );
    [
        "-i",
        input,
        "-filter_complex",
        &filter,
        "-map",
        "[gifout]",
        "-an",
        "-sn",
        "-dn",
        "-loop",
        loop_arg,
        output,
    ]
    .map(str::to_string)
    .to_vec()
}

fn webp_args(input: &str, output: &str, tier: &str, context: PresetContext<'_>) -> Vec<String> {
    let settings = webp_tier(tier, context);
    let loop_arg = if advanced(context).webp.loop_mode == crate::types::GifLoopMode::Once {
        "1"
    } else {
        "0"
    };
    [
        "-i",
        input,
        "-vf",
        &animated_frame_filter(settings.fps, settings.max_dimension),
        "-c:v",
        "libwebp_anim",
        "-quality",
        &settings.quality.to_string(),
        "-compression_level",
        "4",
        "-loop",
        loop_arg,
        "-an",
        "-sn",
        "-dn",
        output,
    ]
    .map(str::to_string)
    .to_vec()
}

const SVTAV1_ADVANCED_PARAMS: &str = "tune=0:enable-overlays=1:enable-qm=1:qm-min=0:keyint=10s";
const X265_ADVANCED_PARAMS: &str = "aq-mode=3:psy-rd=2.0:psy-rdoq=1.0:rc-lookahead=60:bframes=8";
const AVI_X265_PARAMS: &str =
    "aq-mode=3:rd=6:psy-rd=2.0:psy-rdoq=1.0:rdoq-level=2:rc-lookahead=60:bframes=8:ref=6";
const OPUS_SAFE_LAYOUTS: &str = "aformat=channel_layouts=mono|stereo|3.0|quad|5.0|5.1|6.1|7.1";

fn av1_args(
    input: &str,
    output: &str,
    gpu: GpuVendor,
    tier: &str,
    context: PresetContext<'_>,
) -> Vec<String> {
    let settings = av1_tier(tier, context);
    let platform = context.platform;
    let mut args: Vec<String> = [
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        &resolve_encoder(GpuCodec::Av1, gpu, platform),
    ]
    .map(str::to_string)
    .to_vec();
    args.extend(quality_args(
        gpu,
        settings.quality,
        GpuCodec::Av1,
        effort_from_cpu_preset(settings.cpu_preset),
        platform,
    ));
    if resolve_encode_vendor(GpuCodec::Av1, gpu, platform) == EncodeVendor::Cpu {
        args.extend(["-preset", &settings.cpu_preset.to_string()].map(str::to_string));
        args.extend(["-svtav1-params", SVTAV1_ADVANCED_PARAMS].map(str::to_string));
        args.extend(["-pix_fmt", "yuv420p10le"].map(str::to_string));
    }
    args.extend(
        [
            "-af",
            OPUS_SAFE_LAYOUTS,
            "-c:a",
            "libopus",
            "-b:a",
            &bitrate_kbps(settings.audio_bitrate_kbps),
        ]
        .map(str::to_string),
    );
    args.extend(multichannel_bitrate_args(
        settings.audio_bitrate_kbps,
        context,
    ));
    args.push(output.to_string());
    args
}

fn h264_args(
    input: &str,
    output: &str,
    gpu: GpuVendor,
    tier: &str,
    context: PresetContext<'_>,
) -> Vec<String> {
    let settings = h264_tier(tier, context);
    let platform = context.platform;
    let mut args: Vec<String> = [
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        &resolve_encoder(GpuCodec::H264, gpu, platform),
    ]
    .map(str::to_string)
    .to_vec();
    args.extend(quality_args(
        gpu,
        settings.quality,
        GpuCodec::H264,
        effort_from_preset(settings.preset),
        platform,
    ));
    if resolve_encode_vendor(GpuCodec::H264, gpu, platform) == EncodeVendor::Cpu {
        args.extend(["-preset", settings.preset.as_str()].map(str::to_string));
        args.extend(["-pix_fmt", "yuv420p"].map(str::to_string));
    }
    args.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            &bitrate_kbps(settings.audio_bitrate_kbps),
        ]
        .map(str::to_string),
    );
    args.extend(multichannel_bitrate_args(
        settings.audio_bitrate_kbps,
        context,
    ));
    args.push(output.to_string());
    args
}

fn h265_args(
    input: &str,
    output: &str,
    gpu: GpuVendor,
    tier: &str,
    context: PresetContext<'_>,
) -> Vec<String> {
    let settings = h265_tier(tier, context);
    let platform = context.platform;
    let mut args: Vec<String> = [
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        &resolve_encoder(GpuCodec::H265, gpu, platform),
    ]
    .map(str::to_string)
    .to_vec();
    args.extend(quality_args(
        gpu,
        settings.quality,
        GpuCodec::H265,
        effort_from_preset(settings.preset),
        platform,
    ));
    if resolve_encode_vendor(GpuCodec::H265, gpu, platform) == EncodeVendor::Cpu {
        args.extend(["-preset", settings.preset.as_str()].map(str::to_string));
        if settings.use_advanced_params {
            args.extend(
                [
                    "-x265-params",
                    X265_ADVANCED_PARAMS,
                    "-pix_fmt",
                    "yuv420p10le",
                ]
                .map(str::to_string),
            );
        }
    }
    args.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            &bitrate_kbps(settings.audio_bitrate_kbps),
        ]
        .map(str::to_string),
    );
    args.extend(multichannel_bitrate_args(
        settings.audio_bitrate_kbps,
        context,
    ));
    args.push(output.to_string());
    args
}

fn avi_args(
    input: &str,
    output: &str,
    gpu: GpuVendor,
    tier: &str,
    context: PresetContext<'_>,
) -> Vec<String> {
    let settings = avi_tier(tier, context);
    let platform = context.platform;
    let codec = avi_gpu_codec(settings.codec);
    let mut args: Vec<String> = [
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        &resolve_encoder(codec, gpu, platform),
    ]
    .map(str::to_string)
    .to_vec();
    args.extend(quality_args(
        gpu,
        settings.quality,
        codec,
        effort_from_preset(settings.preset),
        platform,
    ));
    if resolve_encode_vendor(codec, gpu, platform) == EncodeVendor::Cpu {
        args.extend(["-preset", settings.preset.as_str()].map(str::to_string));
        if codec == GpuCodec::H264 {
            args.extend(["-pix_fmt", "yuv420p"].map(str::to_string));
        } else if settings.use_advanced_params {
            args.extend(["-x265-params", AVI_X265_PARAMS].map(str::to_string));
        }
    }
    args.extend(
        [
            "-c:a",
            "libmp3lame",
            "-b:a",
            &bitrate_kbps(settings.audio_bitrate_kbps),
        ]
        .map(str::to_string),
    );
    args.push(output.to_string());
    args
}

const TEXT_SUBTITLE_CODECS: &[&str] = &[
    "ass",
    "jacosub",
    "microdvd",
    "mov_text",
    "mpl2",
    "pjs",
    "realtext",
    "sami",
    "ssa",
    "srt",
    "stl",
    "subrip",
    "subviewer",
    "subviewer1",
    "text",
    "vplayer",
    "webvtt",
];

pub fn is_text_subtitle_codec(codec: Option<&str>) -> bool {
    codec.is_some_and(|codec| {
        TEXT_SUBTITLE_CODECS
            .iter()
            .any(|known| known.eq_ignore_ascii_case(codec))
    })
}

fn remux_args(
    input: &str,
    output: &str,
    extension: &str,
    context: PresetContext<'_>,
) -> Vec<String> {
    if extension == "mkv" {
        return [
            "-i",
            input,
            "-map",
            "0",
            "-map_metadata",
            "0",
            "-c",
            "copy",
            output,
        ]
        .map(str::to_string)
        .to_vec();
    }
    let subtitle_codecs = context
        .source_streams
        .and_then(|streams| streams.subtitle_codecs.as_ref())
        .cloned()
        .unwrap_or_default();
    let text_indices: Vec<usize> = subtitle_codecs
        .iter()
        .enumerate()
        .filter(|(_, codec)| is_text_subtitle_codec(Some(codec)))
        .map(|(index, _)| index)
        .collect();
    let mut args: Vec<String> = ["-i", input, "-map", "0:v:0?", "-map", "0:a?"]
        .map(str::to_string)
        .to_vec();
    for index in &text_indices {
        args.push("-map".into());
        args.push(format!("0:s:{index}"));
    }
    args.extend(["-map_metadata", "0", "-c", "copy"].map(str::to_string));
    let subtitle_encoder = match extension {
        "mp4" => Some("mov_text"),
        "webm" => Some("webvtt"),
        _ => None,
    };
    if !text_indices.is_empty() {
        if let Some(encoder) = subtitle_encoder {
            args.extend(["-c:s", encoder].map(str::to_string));
        }
    }
    args.push(output.to_string());
    args
}

/// v1's preset getArgs for one input/output pair.
pub fn build_args(
    preset: &Preset,
    input: &str,
    output: &str,
    gpu: GpuVendor,
    context: PresetContext<'_>,
) -> Vec<String> {
    let category = preset.category;
    match category {
        "av1" => av1_args(
            input,
            output,
            gpu,
            preset.id.trim_start_matches("av1-"),
            context,
        ),
        "h264" => h264_args(
            input,
            output,
            gpu,
            preset.id.trim_start_matches("h264-"),
            context,
        ),
        "h265" => h265_args(
            input,
            output,
            gpu,
            preset.id.trim_start_matches("h265-"),
            context,
        ),
        "avi" => avi_args(
            input,
            output,
            gpu,
            preset.avi_tier.unwrap_or("balanced"),
            context,
        ),
        "gif" => gif_args(input, output, preset.id.trim_start_matches("gif-"), context),
        "webp" => webp_args(
            input,
            output,
            preset.id.trim_start_matches("webp-"),
            context,
        ),
        "remux" => remux_args(input, output, preset.extension, context),
        "audio" => audio_args(preset, input, output),
        _ => Vec::new(),
    }
}

fn audio_args(preset: &Preset, input: &str, output: &str) -> Vec<String> {
    match preset.id {
        "audio-mp3" => [
            "-i",
            input,
            "-vn",
            "-map_metadata",
            "0",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "2",
            output,
        ]
        .map(str::to_string)
        .to_vec(),
        "audio-aac" => [
            "-i",
            input,
            "-vn",
            "-map_metadata",
            "0",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            output,
        ]
        .map(str::to_string)
        .to_vec(),
        _ => [
            "-i",
            input,
            "-vn",
            "-map_metadata",
            "0",
            "-c:a",
            "flac",
            "-compression_level",
            "8",
            output,
        ]
        .map(str::to_string)
        .to_vec(),
    }
}
