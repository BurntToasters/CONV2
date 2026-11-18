//! Metadata previews: the ffprobe projection behind the selected file list
//! (v1 ffmpeg.ts runFFprobe + getVideoInfo). The probe runs through the
//! bundled `conv2-ffprobe` sidecar only; v1's system ffprobe lookup is gone.
//! Cancellation is single-slot replacement (TrackedSlot): a new request
//! invalidates and terminates the previous one, matching v1's AbortSignal.

use crate::constants::MAX_ERROR_BUFFER;
use crate::ffmpeg_status;
use crate::ipc::{self, FalliblePayload, IpcResult, INTERNAL_ERROR, INVALID_PATH};
use crate::process_util::{TrackedError, TrackedReservation, TrackedSlot};
use crate::types::VideoInfo;
use serde_json::{Map, Value};
use std::path::Path;
use std::time::Duration;

static FILE_INFO: TrackedSlot = TrackedSlot::new();

const FFPROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// v1's MAX_FFPROBE_OUTPUT_BYTES: ffprobe output is refused past this cap.
const MAX_FFPROBE_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// v1's INPUT_PROTOCOL_ARGS: a crafted container can make FFmpeg open http,
/// concat or subfile URLs, so inputs are limited to local files, pipes and
/// data URIs. (Conversions insert the same list in command_builders.)
const INPUT_PROTOCOL_ARGS: [&str; 2] = ["-protocol_whitelist", "file,pipe,crypto,data"];

/// v1's exact ffprobe argument list for get-file-info. The input is the value
/// of `-i` so a leading-hyphen filename can never parse as an option.
fn ffprobe_args(input_path: &str) -> Vec<String> {
    [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        INPUT_PROTOCOL_ARGS[0],
        INPUT_PROTOCOL_ARGS[1],
        "-i",
        input_path,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// JS `parseInt` semantics: leading integer digits of the string, 0 otherwise.
fn parse_int_leading(value: &Value) -> u64 {
    let text = match value {
        Value::String(text) => text.as_str(),
        Value::Number(_) => {
            return value
                .as_f64()
                .filter(|number| number.is_finite() && *number >= 0.0)
                .map(|number| number.trunc() as u64)
                .unwrap_or(0)
        }
        _ => return 0,
    };
    let trimmed = text.trim_start();
    let digits = trimmed
        .strip_prefix(['+', '-'])
        .unwrap_or(trimmed)
        .split(|character: char| !character.is_ascii_digit())
        .next()
        .unwrap_or("");
    let negative = trimmed.starts_with('-');
    let magnitude: u64 = digits.parse().unwrap_or(0);
    if negative {
        0
    } else {
        magnitude
    }
}

/// JS `parseFloat` semantics, with NaN normalized to 0 (v1 serialized NaN as
/// null; ffprobe never emits one).
fn parse_float_leading(value: &Value) -> f64 {
    if let Some(number) = value.as_f64() {
        return if number.is_finite() { number } else { 0.0 };
    }
    let Some(text) = value.as_str() else {
        return 0.0;
    };
    let trimmed = text.trim_start();
    let end = trimmed
        .find(|character: char| {
            !(character.is_ascii_digit() || matches!(character, '.' | 'e' | 'E' | '+' | '-'))
        })
        .unwrap_or(trimmed.len());
    let candidate = &trimmed[..end];
    let parsed: f64 = candidate.parse().unwrap_or(0.0);
    if parsed.is_finite() {
        parsed
    } else {
        0.0
    }
}

/// v1's `field || undefined`: absent, null, or empty strings become None.
fn pick_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
}

/// A stream's `codec_type`, for the find/filter passes below.
fn stream_codec_type(stream: &Value) -> Option<&str> {
    stream
        .as_object()
        .and_then(|object| object.get("codec_type"))
        .and_then(Value::as_str)
}

/// v1 getVideoInfo's projection of the ffprobe JSON.
pub fn parse_video_info(json: &str) -> Option<VideoInfo> {
    let parsed: Value = serde_json::from_str(json).ok()?;
    let data: &Map<String, Value> = parsed.as_object()?;
    // v1 dereferenced data.streams unguarded after the array check, so a
    // present-but-non-array streams key was a parse failure (null).
    let streams = match data.get("streams") {
        None => &[],
        Some(Value::Array(streams)) => streams.as_slice(),
        Some(_) => return None,
    };
    let video_stream = streams
        .iter()
        .find(|stream| stream_codec_type(stream) == Some("video"));
    let audio_stream = streams
        .iter()
        .find(|stream| stream_codec_type(stream) == Some("audio"));
    let video = video_stream.and_then(Value::as_object);
    let duration = data
        .get("format")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .get("duration")
                .map(parse_float_leading)
                .unwrap_or(0.0)
        })
        .unwrap_or(0.0);
    let format_name = data
        .get("format")
        .and_then(Value::as_object)
        .and_then(|object| pick_string(object.get("format_name")))
        .unwrap_or_else(|| "unknown".to_string());
    let size = data
        .get("format")
        .and_then(Value::as_object)
        .map(|object| object.get("size").map(parse_int_leading).unwrap_or(0))
        .unwrap_or(0);
    let dimension = |field: &str| -> u32 {
        video
            .and_then(|stream| stream.get(field))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u32::MAX as u64) as u32
    };
    Some(VideoInfo {
        duration,
        size,
        width: dimension("width"),
        height: dimension("height"),
        codec: video
            .and_then(|stream| pick_string(stream.get("codec_name")))
            .unwrap_or_else(|| "unknown".to_string()),
        format: format_name,
        pix_fmt: video.and_then(|stream| pick_string(stream.get("pix_fmt"))),
        color_primaries: video.and_then(|stream| pick_string(stream.get("color_primaries"))),
        color_transfer: video.and_then(|stream| pick_string(stream.get("color_transfer"))),
        color_space: video.and_then(|stream| pick_string(stream.get("color_space"))),
        color_range: video.and_then(|stream| pick_string(stream.get("color_range"))),
        audio_codec: audio_stream
            .and_then(Value::as_object)
            .and_then(|stream| pick_string(stream.get("codec_name"))),
        subtitle_codecs: Some(
            streams
                .iter()
                .filter(|stream| stream_codec_type(stream) == Some("subtitle"))
                .map(|stream| {
                    stream
                        .as_object()
                        .and_then(|object| pick_string(object.get("codec_name")))
                        .unwrap_or_else(|| "unknown".to_string())
                })
                .collect(),
        ),
        audio_channels: Some(
            streams
                .iter()
                .filter(|stream| stream_codec_type(stream) == Some("audio"))
                .map(|stream| {
                    stream
                        .as_object()
                        .and_then(|object| object.get("channels"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .min(u32::MAX as u64) as u32
                })
                .collect(),
        ),
        has_video: Some(video_stream.is_some()),
    })
}

/// Why a conversion preflight probe produced no metadata.
#[derive(Debug)]
pub(crate) enum ProbeError {
    Cancelled,
    Failed,
}

/// Probe one file through a specific ffprobe binary (the command wrapper
/// always passes the bundled sidecar; tests may pass a prepared copy).
fn probe_file(
    slot: &TrackedSlot,
    ffprobe: &Path,
    path: &str,
    reservation: TrackedReservation<'_>,
) -> Result<VideoInfo, ProbeError> {
    if reservation.is_cancelled() {
        return Err(ProbeError::Cancelled);
    }
    let args = ffprobe_args(path);
    let command = crate::process_util::command(ffprobe, &args, &[], true);
    match slot.run_reserved_with(
        reservation,
        command,
        FFPROBE_TIMEOUT,
        MAX_FFPROBE_OUTPUT_BYTES,
        MAX_ERROR_BUFFER,
        |output| {
            if output.code == Some(0) && !output.stdout_truncated {
                parse_video_info(&output.stdout).ok_or(ProbeError::Failed)
            } else {
                Err(ProbeError::Failed)
            }
        },
    ) {
        Ok(info) => info,
        Err(TrackedError::Cancelled) => Err(ProbeError::Cancelled),
        Err(TrackedError::TimedOut) => Err(ProbeError::Failed),
        Err(TrackedError::Spawn(error)) => {
            crate::logging::warn(&format!("Failed to start ffprobe: {error}"));
            Err(ProbeError::Failed)
        }
    }
}

/// Conversion preflight owns its slot so cancelling a batch never terminates
/// the file-list preview probe (and vice versa).
static CONVERSION_PROBE: TrackedSlot = TrackedSlot::new();

/// v1 `getVideoInfo` for a conversion, cancellable with the batch.
pub(crate) fn probe_for_conversion(path: &str) -> Result<VideoInfo, ProbeError> {
    // v1's runFFprobe gated on the FFmpeg status before spawning.
    if !ffmpeg_status::current_status().ok {
        return Err(ProbeError::Failed);
    }
    let reservation = CONVERSION_PROBE.reserve();
    probe_file(
        &CONVERSION_PROBE,
        &ffmpeg_status::bundled_ffprobe(),
        path,
        reservation,
    )
}

/// Stop an in-flight conversion preflight probe.
pub(crate) fn cancel_conversion_probe() {
    CONVERSION_PROBE.cancel();
}

/// v1 `getVideoDuration`: a second probe for containers whose format
/// duration is missing or zero.
pub(crate) fn probe_duration_for_conversion(path: &str) -> Result<f64, ProbeError> {
    if !ffmpeg_status::current_status().ok {
        return Err(ProbeError::Failed);
    }
    let reservation = CONVERSION_PROBE.reserve();
    if reservation.is_cancelled() {
        return Err(ProbeError::Cancelled);
    }
    let args = [
        "-protocol_whitelist",
        "file,pipe,crypto,data",
        "-i",
        path,
        "-show_entries",
        "format=duration",
        "-v",
        "quiet",
        "-of",
        "csv=p=0",
    ]
    .map(str::to_string)
    .to_vec();
    let command = crate::process_util::command(ffmpeg_status::bundled_ffprobe(), &args, &[], true);
    match CONVERSION_PROBE.run_reserved_with(
        reservation,
        command,
        FFPROBE_TIMEOUT,
        MAX_FFPROBE_OUTPUT_BYTES,
        MAX_ERROR_BUFFER,
        |output| {
            if output.code != Some(0) {
                return Err(ProbeError::Failed);
            }
            // JS parseFloat: unknown or malformed output becomes 0, not NaN.
            Ok(output.stdout.trim().parse::<f64>().unwrap_or(0.0))
        },
    ) {
        Ok(duration) => duration,
        Err(TrackedError::Cancelled) => Err(ProbeError::Cancelled),
        Err(TrackedError::TimedOut) => Err(ProbeError::Failed),
        Err(TrackedError::Spawn(error)) => {
            crate::logging::warn(&format!("Failed to start ffprobe: {error}"));
            Err(ProbeError::Failed)
        }
    }
}

fn fetch_file_info(path: String, reservation: TrackedReservation<'static>) -> Option<VideoInfo> {
    // Same admission as conversion inputs: absolute, existing regular file,
    // never a network-namespace path. A bad path stays a null probe result.
    let path = crate::validation::existing_file(&path)?;
    // v1's runFFprobe gated on the FFmpeg status before spawning.
    if !ffmpeg_status::current_status().ok {
        return None;
    }
    let ffprobe = ffmpeg_status::bundled_ffprobe();
    let probed = probe_file(&FILE_INFO, &ffprobe, &path, reservation).ok();
    // v1's handler replaced the probe's size with the actual file size.
    probed.map(|mut info| {
        if let Ok(meta) = std::fs::metadata(&path) {
            info.size = meta.len();
        }
        info
    })
}

/// v1's get-file-info: null (not an error) when the probe fails for any
/// reason, matching the renderer's `getFileInfo` catch.
#[tauri::command]
pub async fn get_file_info(file_path: FalliblePayload<String>) -> IpcResult<Option<VideoInfo>> {
    let reservation = FILE_INFO.reserve();
    let path = match file_path.into_typed(INVALID_PATH, "File path must be a non-empty string.") {
        Ok(path) => path,
        Err(error) => return ipc::from_error(error),
    };
    match tauri::async_runtime::spawn_blocking(move || fetch_file_info(path, reservation)).await {
        Ok(info) => ipc::ok(info),
        Err(error) => ipc::err(INTERNAL_ERROR, error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    // Failure modes:
    // - a container that makes ffprobe open a remote URL: the protocol
    //   whitelist must precede the input.
    // - oversized probe output: the 8 MB cap must refuse the cut buffer
    //   instead of parsing half a JSON document.
    // - malformed or partial JSON: parse returns null, never an error.
    // - a present-but-non-array streams key: treated like v1's TypeError,
    //   so null.
    // - missing optional fields: absent keys stay absent (not empty strings).
    // - a cancelled reservation: no spawn happens and the result is null.
    // All but the last are pure parser tests; the last is covered by
    // process_util's slot tests, plus a stub-gated real-sidecar probe below.
    use super::*;
    use crate::types_ffmpeg::test_support;

    #[test]
    fn ffprobe_args_match_v1_exactly() {
        let args = ffprobe_args("/tmp/movie file.mp4");
        assert_eq!(
            args,
            [
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-protocol_whitelist",
                "file,pipe,crypto,data",
                "-i",
                "/tmp/movie file.mp4"
            ]
        );
        assert_eq!(MAX_FFPROBE_OUTPUT_BYTES, 8 * 1024 * 1024);
    }

    const FULL_PROBE: &str = r#"{
        "streams": [
            {"codec_type":"video","codec_name":"hevc","width":3840,"height":2160,
             "pix_fmt":"yuv420p10le","color_primaries":"bt2020","color_transfer":"smpte2084",
             "color_space":"bt2020nc","color_range":"tv"},
            {"codec_type":"audio","codec_name":"aac","channels":6},
            {"codec_type":"subtitle","codec_name":"subrip"},
            {"codec_type":"subtitle"},
            {"codec_type":"data"}
        ],
        "format": {"duration":"12.5","size":"8044","format_name":"mov,mp4,m4a,3gp,3g2,mj2"}
    }"#;

    #[test]
    fn parse_full_projection() {
        let info = parse_video_info(FULL_PROBE).unwrap();
        assert_eq!(info.duration, 12.5);
        assert_eq!(info.size, 8044);
        assert_eq!(info.width, 3840);
        assert_eq!(info.height, 2160);
        assert_eq!(info.codec, "hevc");
        assert_eq!(info.format, "mov,mp4,m4a,3gp,3g2,mj2");
        assert_eq!(info.pix_fmt.as_deref(), Some("yuv420p10le"));
        assert_eq!(info.color_primaries.as_deref(), Some("bt2020"));
        assert_eq!(info.color_transfer.as_deref(), Some("smpte2084"));
        assert_eq!(info.color_space.as_deref(), Some("bt2020nc"));
        assert_eq!(info.color_range.as_deref(), Some("tv"));
        assert_eq!(info.audio_codec.as_deref(), Some("aac"));
        assert_eq!(info.subtitle_codecs.unwrap(), vec!["subrip", "unknown"]);
        assert_eq!(info.audio_channels.unwrap(), vec![6]);
        assert_eq!(info.has_video, Some(true));
    }

    #[test]
    fn parse_audio_only_defaults() {
        let info = parse_video_info(
            r#"{"streams":[{"codec_type":"audio","codec_name":"flac"}],
                "format":{"duration":"3.25","size":"123","format_name":"flac"}}"#,
        )
        .unwrap();
        assert_eq!(info.has_video, Some(false));
        assert_eq!(info.codec, "unknown");
        assert_eq!(info.width, 0);
        assert_eq!(info.height, 0);
        assert_eq!(info.pix_fmt, None);
        assert_eq!(info.audio_codec.as_deref(), Some("flac"));
        assert_eq!(info.audio_channels.unwrap(), vec![0]);
        assert_eq!(info.subtitle_codecs.unwrap(), Vec::<String>::new());
        assert_eq!(info.duration, 3.25);
        assert_eq!(info.size, 123);
    }

    #[test]
    fn parse_tolerates_missing_format_and_streams() {
        let info = parse_video_info("{}").unwrap();
        assert_eq!(info.duration, 0.0);
        assert_eq!(info.size, 0);
        assert_eq!(info.codec, "unknown");
        assert_eq!(info.format, "unknown");
        assert_eq!(info.has_video, Some(false));
        assert_eq!(info.audio_codec, None);
    }

    #[test]
    fn parse_rejects_malformed_output() {
        assert_eq!(parse_video_info("not json"), None);
        assert_eq!(parse_video_info("[1,2]"), None);
        // v1 threw on a non-array streams value; null is the envelope.
        assert_eq!(parse_video_info(r#"{"streams":"nope"}"#), None);
    }

    #[test]
    fn parse_handles_js_number_semantics() {
        // parseInt stops at the first non-digit; parseFloat reads the prefix.
        let info =
            parse_video_info(r#"{"format":{"duration":"2.5e1 seconds","size":"8044 bytes"}}"#)
                .unwrap();
        assert_eq!(info.duration, 25.0);
        assert_eq!(info.size, 8044);
        let info = parse_video_info(r#"{"format":{"size":"bad"}}"#).unwrap();
        assert_eq!(info.size, 0);
        let info = parse_video_info(r#"{"format":{"size":12.9}}"#).unwrap();
        assert_eq!(info.size, 12);
    }

    #[test]
    fn empty_strings_become_absent() {
        let info = parse_video_info(
            r#"{"streams":[{"codec_type":"video","codec_name":"","pix_fmt":""}],
                "format":{"format_name":""}}"#,
        )
        .unwrap();
        assert_eq!(info.pix_fmt, None);
        assert_eq!(info.codec, "unknown");
        assert_eq!(info.format, "unknown");
    }

    /// A minimal deterministic WAV: 8000 mono 8-bit samples at 8 kHz.
    fn write_wav(path: &std::path::Path) {
        let samples: u32 = 8000;
        let mut file = Vec::new();
        file.extend_from_slice(b"RIFF");
        file.extend_from_slice(&(36 + samples).to_le_bytes());
        file.extend_from_slice(b"WAVEfmt ");
        file.extend_from_slice(&16u32.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&8000u32.to_le_bytes());
        file.extend_from_slice(&8000u32.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&8u16.to_le_bytes());
        file.extend_from_slice(b"data");
        file.extend_from_slice(&samples.to_le_bytes());
        file.extend(std::iter::repeat_n(0u8, samples as usize));
        std::fs::write(path, file).unwrap();
    }

    // Integration: real prepared ffprobe against a real (generated) media
    // file, through the same spawn path the command uses. Skipped when the
    // sidecars are development stubs.
    #[test]
    fn real_ffprobe_reads_generated_wav() {
        let Some((ffprobe, stub)) = test_support::sidecar("conv2-ffprobe") else {
            return; // sidecars not prepared on this target
        };
        if stub {
            // TODO: ffprobe is a stub; spawn-based verification runs only
            // where real binaries were prepared.
            return;
        }
        let dir = std::env::temp_dir().join("conv2-media-info-test");
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        write_wav(&wav);
        let reservation = FILE_INFO.reserve();
        let info = probe_file(&FILE_INFO, &ffprobe, &wav.to_string_lossy(), reservation).unwrap();
        assert_eq!(info.has_video, Some(false));
        assert_eq!(info.audio_codec.as_deref(), Some("pcm_u8"));
        assert_eq!(info.audio_channels.unwrap(), vec![1]);
        assert_eq!(info.format, "wav");
        assert!((info.duration - 1.0).abs() < 0.01, "{:?}", info.duration);
        assert_eq!(info.size, 44 + 8000);
    }
}
