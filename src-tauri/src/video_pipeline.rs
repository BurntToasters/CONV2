//! Colour tags, bit depth, HDR tone-mapping, and GPU frame residency
//! (v1 videoPipeline.ts).

use crate::command_builders::EncodeVendor;
use crate::types::{GpuCodec, GpuVendor};

pub const TONEMAP_FILTER: &str =
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

const EIGHT_BIT_CATEGORIES: &[&str] = &["h264", "avi", "gif", "webp"];
const HDR_TRANSFERS: &[&str] = &["smpte2084", "arib-std-b67"];
const UNKNOWN_COLOR: &[&str] = &["unknown", "unspecified", "reserved"];

#[derive(Clone, Copy, Default)]
pub struct SourceColor<'a> {
    pub pix_fmt: Option<&'a str>,
    pub color_primaries: Option<&'a str>,
    pub color_transfer: Option<&'a str>,
    pub color_space: Option<&'a str>,
    pub color_range: Option<&'a str>,
}

pub struct PipelineInput<'a> {
    pub category: &'a str,
    pub encode_vendor: EncodeVendor,
    pub source: Option<SourceColor<'a>>,
    pub decode_args: Vec<String>,
    pub can_tonemap: bool,
}

#[derive(Default)]
pub struct PipelinePlan {
    pub decode_args: Vec<String>,
    pub output_args: Vec<String>,
    pub filter: Option<String>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub tonemapped: bool,
    pub warning: Option<String>,
}

fn usable_color(value: Option<&str>) -> Option<&str> {
    let value = value?;
    let safe = value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-');
    (safe && !UNKNOWN_COLOR.contains(&value)).then_some(value)
}

fn is_high_bit_depth(pix_fmt: Option<&str>) -> bool {
    let Some(pix_fmt) = pix_fmt else {
        return false;
    };
    let lower = pix_fmt.to_ascii_lowercase();
    ["10", "12", "16"]
        .iter()
        .any(|depth| lower.contains(&format!("{depth}le")) || lower.contains(&format!("{depth}be")))
        || lower.contains("p010")
        || lower.contains("p016")
}

/// Drops `-hwaccel_output_format` so decoded frames are downloaded to system
/// memory.
fn with_software_frames(decode_args: &[String]) -> Vec<String> {
    let Some(index) = decode_args
        .iter()
        .position(|arg| arg == "-hwaccel_output_format")
    else {
        return decode_args.to_vec();
    };
    let mut next = decode_args[..index].to_vec();
    next.extend(
        decode_args
            .get(index + 2..)
            .unwrap_or_default()
            .iter()
            .cloned(),
    );
    next
}

fn color_tag_args(source: SourceColor<'_>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(value) = usable_color(source.color_primaries) {
        args.extend(["-color_primaries".to_string(), value.to_string()]);
    }
    if let Some(value) = usable_color(source.color_transfer) {
        args.extend(["-color_trc".to_string(), value.to_string()]);
    }
    if let Some(value) = usable_color(source.color_space) {
        args.extend(["-colorspace".to_string(), value.to_string()]);
    }
    if let Some(value) = usable_color(source.color_range) {
        args.extend(["-color_range".to_string(), value.to_string()]);
    }
    args
}

fn is_media_foundation(encode_vendor: EncodeVendor) -> bool {
    encode_vendor == EncodeVendor::Vendor(GpuVendor::Qualcomm)
}

pub fn plan_video_pipeline(input: PipelineInput<'_>) -> PipelinePlan {
    let mf_nv12_args: Vec<String> = if is_media_foundation(input.encode_vendor) {
        ["-pix_fmt", "nv12"].map(str::to_string).to_vec()
    } else {
        Vec::new()
    };
    let Some(source) = input.source else {
        return PipelinePlan {
            decode_args: input.decode_args,
            output_args: mf_nv12_args,
            ..Default::default()
        };
    };
    let is_hdr = usable_color(source.color_transfer)
        .is_some_and(|transfer| HDR_TRANSFERS.contains(&transfer));
    let eight_bit_target =
        EIGHT_BIT_CATEGORIES.contains(&input.category) || is_media_foundation(input.encode_vendor);
    let high_bit_depth = is_high_bit_depth(source.pix_fmt);

    if is_hdr && eight_bit_target && input.can_tonemap {
        let mut output_args = [
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-colorspace",
            "bt709",
            "-color_range",
            "tv",
        ]
        .map(str::to_string)
        .to_vec();
        output_args.extend(mf_nv12_args);
        return PipelinePlan {
            decode_args: with_software_frames(&input.decode_args),
            output_args,
            filter: Some(TONEMAP_FILTER.to_string()),
            tonemapped: true,
            warning: None,
        };
    }

    let output_args = color_tag_args(source);
    let mut plan = PipelinePlan {
        decode_args: input.decode_args.clone(),
        output_args,
        filter: None,
        tonemapped: false,
        warning: None,
    };
    if is_hdr && eight_bit_target {
        plan.warning = Some(
            "HDR source into an 8-bit format: this FFmpeg build cannot tone-map, colours may look washed out."
                .to_string(),
        );
    }
    if high_bit_depth
        && input.encode_vendor == EncodeVendor::Cpu
        && (input.category == "h265" || input.category == "av1")
    {
        plan.output_args
            .extend(["-pix_fmt", "yuv420p10le"].map(str::to_string));
    }
    // NVENC/QSV/AMF H.264 reject 10-bit GPU frames; VideoToolbox converts on its own.
    if high_bit_depth
        && input.category == "h264"
        && !matches!(
            input.encode_vendor,
            EncodeVendor::Cpu
                | EncodeVendor::Vendor(GpuVendor::Apple)
                | EncodeVendor::Vaapi
                | EncodeVendor::Vendor(GpuVendor::Qualcomm)
        )
    {
        plan.decode_args = with_software_frames(&input.decode_args);
        plan.output_args
            .extend(["-pix_fmt", "yuv420p"].map(str::to_string));
    }
    if is_media_foundation(input.encode_vendor) {
        plan.decode_args = with_software_frames(&input.decode_args);
        plan.output_args
            .extend(["-pix_fmt", "nv12"].map(str::to_string));
    }
    plan
}

/// Upload chain for VAAPI: p010 needs a 10-bit source, H.265/AV1, and a
/// category outside the 8-bit set; everything else is nv12.
pub fn vaapi_upload_filter(
    category: &str,
    codec: GpuCodec,
    source_pix_fmt: Option<&str>,
) -> String {
    let ten_bit = matches!(codec, GpuCodec::H265 | GpuCodec::Av1)
        && is_high_bit_depth(source_pix_fmt)
        && !EIGHT_BIT_CATEGORIES.contains(&category);
    if ten_bit {
        "format=p010,hwupload".to_string()
    } else {
        "format=nv12,hwupload".to_string()
    }
}

/// Adds a video filter before the output path, merging with an existing `-vf`
/// or GIF graph.
pub fn apply_video_filter(args: &[String], filter: &str) -> Vec<String> {
    let mut next = args.to_vec();
    if let Some(index) = next.iter().position(|arg| arg == "-filter_complex") {
        if let Some(graph) = next.get(index + 1) {
            if let Some(rest) = graph.strip_prefix("[0:v]") {
                next[index + 1] = format!("[0:v]{filter},{rest}");
                return next;
            }
        }
    }
    if let Some(index) = next.iter().position(|arg| arg == "-vf") {
        if let Some(value) = next.get(index + 1) {
            next[index + 1] = format!("{filter},{value}");
            return next;
        }
    }
    let Some(output) = next.pop() else {
        return next;
    };
    next.extend(["-vf".to_string(), filter.to_string(), output]);
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source<'a>(pix_fmt: Option<&'a str>, transfer: Option<&'a str>) -> SourceColor<'a> {
        SourceColor {
            pix_fmt,
            color_transfer: transfer,
            color_primaries: Some("bt2020"),
            color_space: Some("bt2020nc"),
            color_range: Some("tv"),
        }
    }

    #[test]
    fn hdr_to_eight_bit_tonemaps_and_drops_hw_frames() {
        let plan = plan_video_pipeline(PipelineInput {
            category: "h264",
            encode_vendor: EncodeVendor::Vendor(GpuVendor::Nvidia),
            source: Some(source(Some("yuv420p10le"), Some("smpte2084"))),
            decode_args: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
                .map(str::to_string)
                .to_vec(),
            can_tonemap: true,
        });
        assert!(plan.tonemapped);
        assert_eq!(plan.filter.as_deref(), Some(TONEMAP_FILTER));
        assert_eq!(plan.decode_args, ["-hwaccel", "cuda"]);
        assert!(plan.output_args.contains(&"-color_trc".to_string()));
    }

    #[test]
    fn hdr_without_tonemap_warns() {
        let plan = plan_video_pipeline(PipelineInput {
            category: "webp",
            encode_vendor: EncodeVendor::Cpu,
            source: Some(source(Some("yuv420p10le"), Some("arib-std-b67"))),
            decode_args: Vec::new(),
            can_tonemap: false,
        });
        assert!(plan.warning.is_some());
        assert!(!plan.tonemapped);
    }

    #[test]
    fn high_bit_depth_h264_gpu_drops_frames_and_forces_8bit() {
        let plan = plan_video_pipeline(PipelineInput {
            category: "h264",
            encode_vendor: EncodeVendor::Vendor(GpuVendor::Intel),
            source: Some(source(Some("yuv420p10le"), Some("bt709"))),
            decode_args: ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"]
                .map(str::to_string)
                .to_vec(),
            can_tonemap: true,
        });
        assert_eq!(plan.decode_args, ["-hwaccel", "qsv"]);
        assert!(plan
            .output_args
            .windows(2)
            .any(|pair| pair == ["-pix_fmt", "yuv420p"]));
    }

    #[test]
    fn qualcomm_always_outputs_nv12() {
        let plan = plan_video_pipeline(PipelineInput {
            category: "h264",
            encode_vendor: EncodeVendor::Vendor(GpuVendor::Qualcomm),
            source: None,
            decode_args: Vec::new(),
            can_tonemap: true,
        });
        assert_eq!(plan.output_args, ["-pix_fmt", "nv12"]);
    }

    #[test]
    fn apply_filter_merges_each_graph_style() {
        let vf = ["-i", "in.mp4", "-vf", "scale=2", "-c:v", "x", "out.mp4"]
            .map(str::to_string)
            .to_vec();
        assert_eq!(
            apply_video_filter(&vf, "fps=5")[3],
            "fps=5,scale=2".to_string()
        );
        let graph = ["-i", "in", "-filter_complex", "[0:v]split[a][b]", "out"]
            .map(str::to_string)
            .to_vec();
        assert_eq!(
            apply_video_filter(&graph, "fps=5")[3],
            "[0:v]fps=5,split[a][b]"
        );
        let bare = ["-i", "in", "out"].map(str::to_string).to_vec();
        assert_eq!(
            apply_video_filter(&bare, "fps=5"),
            ["-i", "in", "-vf", "fps=5", "out"]
        );
    }

    #[test]
    fn vaapi_upload_uses_p010_only_for_ten_bit_high_efficiency() {
        assert_eq!(
            vaapi_upload_filter("h265", GpuCodec::H265, Some("yuv420p10le")),
            "format=p010,hwupload"
        );
        assert_eq!(
            vaapi_upload_filter("avi", GpuCodec::H265, Some("yuv420p10le")),
            "format=nv12,hwupload"
        );
        assert_eq!(
            vaapi_upload_filter("h264", GpuCodec::H264, Some("yuv420p10le")),
            "format=nv12,hwupload"
        );
    }
}
