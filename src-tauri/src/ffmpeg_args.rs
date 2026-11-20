//! Output naming and FFmpeg argument surgery for conversions (v1 ffmpeg.ts):
//! output file names, pipeline splicing, MP4 playback fixes, remux
//! preflight, and the input protocol whitelist.

use crate::command_builders::Preset;
use regex::Regex;
use std::sync::OnceLock;

/// Presets whose output needs a video stream from the input.
pub fn is_video_output_category(category: &str) -> bool {
    matches!(category, "av1" | "h264" | "h265" | "avi" | "gif" | "webp")
}

fn faststart_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\bfaststart\b").expect("valid regex"))
}

pub const MAX_OUTPUT_SUFFIX: u32 = 10_000;
/// Filename component limit: 255 bytes (UTF-8 filesystems) or 255 UTF-16 units
/// (NTFS).
const MAX_NAME_UNITS: usize = 255;

fn name_units(text: &str) -> usize {
    if cfg!(windows) {
        text.encode_utf16().count()
    } else {
        text.len()
    }
}

/// `<base>_converted[_N].<ext>` with the stem cut at a char boundary so the
/// whole name, suffix and extension included, fits one path component.
pub fn output_file_name(output_base_name: &str, suffix: u32, extension: &str) -> String {
    let suffix_part = if suffix == 0 {
        String::new()
    } else {
        format!("_{suffix}")
    };
    let tail = format!("_converted{suffix_part}.{extension}");
    let budget = MAX_NAME_UNITS.saturating_sub(name_units(&tail));
    let mut stem = String::new();
    let mut used = 0;
    for character in output_base_name.chars() {
        let width = name_units(character.encode_utf8(&mut [0; 4]));
        if used + width > budget {
            break;
        }
        used += width;
        stem.push(character);
    }
    format!("{stem}{tail}")
}

/// Splices pipeline options before the output path. A flag the preset already
/// sets is skipped, so the final argv never repeats an option.
pub fn splice_output_args(preset_args: &[String], extra_args: &[String]) -> Vec<String> {
    let mut additions: Vec<String> = Vec::new();
    for pair in extra_args.chunks(2) {
        let Some(flag) = pair.first() else { continue };
        if pair.len() < 2 {
            continue;
        }
        if !preset_args.iter().any(|arg| arg == flag) {
            additions.extend(pair.iter().cloned());
        }
    }
    if additions.is_empty() || preset_args.is_empty() {
        return preset_args.to_vec();
    }
    let mut next = preset_args[..preset_args.len() - 1].to_vec();
    next.extend(additions);
    next.push(preset_args[preset_args.len() - 1].clone());
    next
}

fn has_hevc_tag(args: &[String]) -> bool {
    args.iter()
        .enumerate()
        .any(|(index, arg)| arg == "-tag:v" && args.get(index + 1).is_some_and(|tag| tag == "hvc1"))
}

/// faststart for progressive playback, and `hvc1` for HEVC output. The tag
/// matters for remuxes too: HEVC copied into MP4 otherwise gets `hev1`, which
/// Apple players will not open.
pub fn ensure_mp4_playback_compatibility_args(
    preset: &Preset,
    preset_args: &[String],
    source_video_codec: Option<&str>,
) -> Vec<String> {
    if preset.extension != "mp4" || preset_args.is_empty() {
        return preset_args.to_vec();
    }
    let output = preset_args[preset_args.len() - 1].clone();
    let mut args = preset_args[..preset_args.len() - 1].to_vec();
    match args.iter().position(|arg| arg == "-movflags") {
        Some(index) if index + 1 < args.len() => {
            if !faststart_regex().is_match(&args[index + 1]) {
                args[index + 1] = format!("{}+faststart", args[index + 1]);
            }
        }
        _ => args.extend(["-movflags".to_string(), "+faststart".to_string()]),
    }
    let output_carries_hevc = preset.category == "h265"
        || (preset.category == "remux"
            && source_video_codec
                .is_some_and(|codec| matches!(codec.to_lowercase().as_str(), "hevc" | "h265")));
    if output_carries_hevc && !has_hevc_tag(&args) {
        args.extend(["-tag:v".to_string(), "hvc1".to_string()]);
    }
    args.push(output);
    args
}

const WEBM_VIDEO_CODECS: [&str; 3] = ["vp8", "vp9", "av1"];
/// Verified against the bundled build: the WebM muxer copies only these.
const WEBM_AUDIO_CODECS: [&str; 2] = ["opus", "vorbis"];
const MP4_UNSUPPORTED_VIDEO_CODECS: [&str; 3] = ["vp8", "vp9", "theora"];

fn known_codec(codec: Option<&str>) -> Option<String> {
    codec
        .filter(|codec| !codec.is_empty() && *codec != "unknown")
        .map(str::to_lowercase)
}

/// Pre-flights a remux so an incompatible source fails with an explanation
/// instead of a raw "Could not write header" error. Video and audio both
/// matter: WebM accepts VP9 video but only Opus/Vorbis audio.
pub fn get_remux_incompatibility_reason(
    video_codec: Option<&str>,
    extension: &str,
    audio_codec: Option<&str>,
) -> Option<String> {
    let video = known_codec(video_codec);
    let audio = known_codec(audio_codec);
    if extension == "webm" {
        if let Some(codec) = video.as_deref() {
            if !WEBM_VIDEO_CODECS.contains(&codec) {
                return Some(format!(
                    "Cannot remux {} into a WebM container without re-encoding. WebM supports only VP8, VP9, or AV1 video. Use an MP4 or MKV remux, or pick an encoding preset instead.",
                    codec.to_uppercase()
                ));
            }
        }
        if let Some(codec) = audio.as_deref() {
            if !WEBM_AUDIO_CODECS.contains(&codec) {
                return Some(format!(
                    "Cannot remux {} audio into a WebM container without re-encoding. WebM supports only Opus or Vorbis audio. Use an MP4 or MKV remux, or pick an encoding preset instead.",
                    codec.to_uppercase()
                ));
            }
        }
    }
    if extension == "mp4" {
        if let Some(codec) = video.as_deref() {
            if MP4_UNSUPPORTED_VIDEO_CODECS.contains(&codec) {
                return Some(format!(
                    "Cannot remux {} into an MP4 container without re-encoding. Use an MKV remux, or pick an encoding preset instead.",
                    codec.to_uppercase()
                ));
            }
        }
    }
    None
}

/// Inserts input options right before the first `-i`.
pub fn insert_before_input(args: &[String], extra: &[String]) -> Vec<String> {
    let Some(index) = args.iter().position(|arg| arg == "-i") else {
        return args.to_vec();
    };
    if extra.is_empty() {
        return args.to_vec();
    }
    let mut next = args[..index].to_vec();
    next.extend(extra.iter().cloned());
    next.extend(args[index..].iter().cloned());
    next
}

/// Inserts the protocol whitelist right before the user input's `-i`; None
/// when the preset has no matching input.
pub fn with_input_protocol_args(args: &[String], input_path: &str) -> Option<Vec<String>> {
    let index = args
        .iter()
        .enumerate()
        .find(|(index, arg)| {
            *arg == "-i" && args.get(index + 1).is_some_and(|next| next == input_path)
        })
        .map(|(index, _)| index)?;
    let mut next = args[..index].to_vec();
    next.extend([
        "-protocol_whitelist".to_string(),
        "file,pipe,crypto,data".to_string(),
    ]);
    next.extend(args[index..].iter().cloned());
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_builders::get_preset;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn output_names_increment_and_fit_one_component() {
        assert_eq!(output_file_name("clip", 0, "mp4"), "clip_converted.mp4");
        assert_eq!(output_file_name("clip", 2, "mp4"), "clip_converted_2.mp4");
        let long = "é".repeat(300);
        let name = output_file_name(&long, MAX_OUTPUT_SUFFIX, "webm");
        let units = if cfg!(windows) {
            name.encode_utf16().count()
        } else {
            name.len()
        };
        assert!(units <= 255);
        assert!(name.ends_with("_converted_10000.webm"));
    }

    #[test]
    fn splice_skips_flags_the_preset_already_sets() {
        let preset = strings(&["-i", "in", "-pix_fmt", "yuv420p", "out"]);
        assert_eq!(
            splice_output_args(
                &preset,
                &strings(&["-pix_fmt", "nv12", "-colorspace", "bt709"])
            ),
            strings(&[
                "-i",
                "in",
                "-pix_fmt",
                "yuv420p",
                "-colorspace",
                "bt709",
                "out"
            ])
        );
        assert_eq!(splice_output_args(&preset, &[]), preset);
    }

    #[test]
    fn mp4_gains_faststart_and_hevc_tag() {
        let h265 = get_preset("h265-balanced").unwrap();
        let args = strings(&[
            "-i",
            "in.mkv",
            "-c:v",
            "libx265",
            "-movflags",
            "+frag",
            "out.mp4",
        ]);
        let fixed = ensure_mp4_playback_compatibility_args(h265, &args, None);
        assert_eq!(
            fixed,
            strings(&[
                "-i",
                "in.mkv",
                "-c:v",
                "libx265",
                "-movflags",
                "+frag+faststart",
                "-tag:v",
                "hvc1",
                "out.mp4"
            ])
        );
        // A preset that already carries hvc1 keeps a single tag.
        let with_tag = strings(&["-i", "in", "-tag:v", "hvc1", "out.mp4"]);
        let fixed = ensure_mp4_playback_compatibility_args(h265, &with_tag, None);
        assert_eq!(fixed.iter().filter(|arg| *arg == "-tag:v").count(), 1);
    }

    #[test]
    fn remux_checks_both_streams_and_container() {
        assert!(get_remux_incompatibility_reason(Some("vp9"), "webm", Some("aac")).is_some());
        assert!(get_remux_incompatibility_reason(Some("vp9"), "webm", Some("opus")).is_none());
        assert!(get_remux_incompatibility_reason(Some("h264"), "webm", None).is_some());
        assert!(get_remux_incompatibility_reason(Some("vp9"), "mp4", None).is_some());
        assert!(get_remux_incompatibility_reason(Some("unknown"), "webm", None).is_none());
    }

    #[test]
    fn protocol_args_precede_the_matching_input_only() {
        let args = strings(&["-i", "a.mp4", "-i", "b.mp4", "out"]);
        let guarded = with_input_protocol_args(&args, "b.mp4").unwrap();
        assert_eq!(
            guarded,
            strings(&[
                "-i",
                "a.mp4",
                "-protocol_whitelist",
                "file,pipe,crypto,data",
                "-i",
                "b.mp4",
                "out"
            ])
        );
        assert!(with_input_protocol_args(&args, "c.mp4").is_none());
        assert_eq!(
            insert_before_input(&args, &strings(&["-vaapi_device", "/dev/dri/renderD128"])),
            strings(&[
                "-vaapi_device",
                "/dev/dri/renderD128",
                "-i",
                "a.mp4",
                "-i",
                "b.mp4",
                "out"
            ])
        );
    }
}
