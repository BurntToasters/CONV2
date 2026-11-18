//! Turns FFmpeg stderr into one actionable sentence while keeping the raw
//! tail for the Details view (v1 ffmpegFailure.ts).

use crate::types::GpuVendor;
use regex::Regex;
use std::sync::OnceLock;

pub const NO_VIDEO_MESSAGE: &str =
    "This file has no video track. Pick an Audio preset to extract its sound instead.";

const MAX_DETAIL_LINES: usize = 40;
const MAX_FALLBACK_CHARS: usize = 160;

fn banner_line() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?i)^\s*(?:ffmpeg version|built with|configuration:|lib(?:av|sw|post)\w*\s+\d|Copyright)",
        )
        .expect("valid regex")
    })
}

fn noise_line() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?i)^\s*(?:Conversion failed!?|Error opening (?:input|output) files?:|Error opening (?:input|output) file\b|To ignore this|Error parsing options)",
        )
        .expect("valid regex")
    })
}

fn hex_prefix() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?i)^\s*(?:\[[^\]]*@\s*0x[0-9a-f]+\]\s*)+").expect("valid regex"))
}

fn pointer_hex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?i)0x[0-9a-f]{4,}").expect("valid regex"))
}

fn path_token() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/]([^\\/\s'"]+)"#).expect("valid regex")
    })
}

enum RuleMessage {
    Fixed(&'static str),
    Encoder,
}

struct Rule {
    test: &'static str,
    message: RuleMessage,
}

const RULES: &[Rule] = &[
    Rule {
        test: r#"(?i)Stream map '[^']*' matches no streams|Output file (?:#\d+ )?does not contain any stream"#,
        message: RuleMessage::Fixed(NO_VIDEO_MESSAGE),
    },
    Rule {
        test: r"(?i)No such file or directory",
        message: RuleMessage::Fixed(
            "The file could not be found. It may have been moved, renamed, or deleted.",
        ),
    },
    Rule {
        test: r"(?i)Permission denied|Operation not permitted",
        message: RuleMessage::Fixed(
            "CONV2 doesn't have permission to read this file or write to the output folder. Choose another output folder.",
        ),
    },
    Rule {
        test: r"(?i)No space left on device|Disk quota exceeded",
        message: RuleMessage::Fixed(
            "The output drive is full. Free up space or choose another output folder.",
        ),
    },
    Rule {
        test: r"(?i)Invalid data found when processing input|moov atom not found|EBML header parsing failed|could not find codec parameters|Invalid NAL unit size|End of file",
        message: RuleMessage::Fixed(
            "CONV2 couldn't read this file. It may be damaged, incomplete, or not a supported video.",
        ),
    },
    Rule {
        test: r#"(?i)Unknown encoder '([^']+)'"#,
        message: RuleMessage::Encoder,
    },
    Rule {
        test: r"(?i)Encoder not found",
        message: RuleMessage::Fixed(
            "This FFmpeg build does not include the encoder needed for this preset.",
        ),
    },
    Rule {
        test: r"(?i)Could not write header|codec not currently supported in container|is not supported (?:in|by) (?:this|the) (?:container|muxer)|are supported for (?:WebM|MP4)",
        message: RuleMessage::Fixed(
            "The output format can't hold one of the streams in this file. Try an MKV preset or Remux to MKV.",
        ),
    },
    Rule {
        test: r"(?i)Error while opening encoder|OpenEncodeSessionEx failed|Error initializing output stream|Could not open encoder",
        message: RuleMessage::Fixed(
            "The encoder could not start with these settings. Try CPU encoding under Hardware Acceleration.",
        ),
    },
];

fn meaningful_lines(stderr: &str) -> Vec<&str> {
    stderr
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty() && !banner_line().is_match(line))
        .collect()
}

/// Strips `[in#0 @ 0x...]` prefixes, pointer values, and leading paths.
fn clean_line(line: &str) -> String {
    let without_prefix = hex_prefix().replace(line, "");
    let without_pointers = pointer_hex().replace_all(&without_prefix, "");
    path_token()
        .replace_all(&without_pointers, "$1")
        .trim()
        .to_string()
}

/// One actionable sentence for an FFmpeg failure.
pub fn describe(stderr: Option<&str>) -> String {
    let text = stderr.unwrap_or("");
    for rule in RULES {
        let Ok(regex) = Regex::new(rule.test) else {
            continue;
        };
        let Some(captures) = regex.captures(text) else {
            continue;
        };
        return match rule.message {
            RuleMessage::Fixed(message) => message.to_string(),
            RuleMessage::Encoder => format!(
                "This FFmpeg build does not include the {} encoder needed for this preset.",
                captures.get(1).map_or("", |value| value.as_str())
            ),
        };
    }
    let candidates: Vec<&str> = meaningful_lines(text)
        .into_iter()
        .filter(|line| !noise_line().is_match(line))
        .collect();
    let last = candidates.last().map(|line| clean_line(line)).unwrap_or_default();
    if last.is_empty() {
        return "FFmpeg stopped without an error message. Open Logs for details.".to_string();
    }
    let clipped = if last.chars().count() > MAX_FALLBACK_CHARS {
        let mut text: String = last.chars().take(MAX_FALLBACK_CHARS - 1).collect();
        text.push('…');
        text
    } else {
        last
    };
    format!("FFmpeg error: {clipped}")
}

/// Last meaningful stderr lines, without the version banner.
pub fn detail(stderr: Option<&str>) -> String {
    let lines = meaningful_lines(stderr.unwrap_or(""));
    let start = lines.len().saturating_sub(MAX_DETAIL_LINES);
    lines[start..].join("\n")
}

/// v1's MAX_ERROR_OUTPUT_CHARS: the stderr tail kept for Details and retries.
pub const MAX_ERROR_OUTPUT_CHARS: usize = 256 * 1024;

/// Appends a chunk, keeping only the tail. The cut moves to a UTF-8 boundary
/// so the buffer never holds a partial character.
pub fn append_bounded_error_output(current: &mut String, next_chunk: &str) {
    if next_chunk.is_empty() {
        return;
    }
    current.push_str(next_chunk);
    if current.len() <= MAX_ERROR_OUTPUT_CHARS {
        return;
    }
    let mut start = current.len() - MAX_ERROR_OUTPUT_CHARS;
    while start < current.len() && !current.is_char_boundary(start) {
        start += 1;
    }
    current.drain(..start);
}

const INPUT_ERROR_MARKERS: [&str; 5] = [
    "error opening input",
    "no such file or directory",
    "invalid data found when processing input",
    "moov atom not found",
    "permission denied",
];

/// v1 shouldRetryWithSoftwareDecode: a hardware decode failure that a plain
/// software decode could survive.
pub fn should_retry_with_software_decode(error_output: &str) -> bool {
    let lowered = error_output.to_lowercase();
    if INPUT_ERROR_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return false;
    }
    const MARKERS: [&str; 12] = [
        "hwaccel",
        "device setup failed",
        "failed setup for format",
        "no device available",
        "error while opening decoder",
        "hardware acceleration",
        "cannot load libmfx",
        "failed to initialise vaapi",
        "vaapi init",
        "vaapi device",
        "qsv init",
        "qsv session",
    ];
    MARKERS.iter().any(|marker| lowered.contains(marker))
}

/// v1 shouldRetryWithCpu: a GPU encode failure worth re-running on the CPU.
/// `cancelled` is v1's `result.error === 'Conversion cancelled'`.
pub fn should_retry_with_cpu(
    success: bool,
    cancelled: bool,
    attempted_gpu: GpuVendor,
    has_video_codec: bool,
    error_message: &str,
    retry_suggested: bool,
) -> bool {
    if attempted_gpu == GpuVendor::Cpu || !has_video_codec || success || cancelled {
        return false;
    }
    let message = error_message.to_lowercase();
    if INPUT_ERROR_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
    {
        return false;
    }
    if retry_suggested {
        return true;
    }
    const GPU_MARKERS: [&str; 32] = [
        "nvenc",
        "amf init",
        "amf failed",
        "amf error",
        "amf encoder",
        "qsv",
        "videotoolbox",
        "no capable devices found",
        "cannot load nvencode",
        "hardware acceleration",
        "openencodesessionex",
        "cuda",
        "d3d11",
        "no usable encoding profile",
        "rate control mode",
        "rc mode",
        "failed to upload",
        "failed to create surface",
        "failed to create context",
        "failed to create buffer",
        "vabeginpicture",
        "varenderpicture",
        "vaendpicture",
        "vacreate",
        "could not find any mft",
        "hardware mft",
        "format negotiation failed",
        "could not start stream",
        "failed to set d3d manager",
        "mfplat.dll",
        "could not set input type",
        "could not set output type",
    ];
    GPU_MARKERS.iter().any(|marker| message.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_failures_map_to_advice() {
        assert_eq!(
            describe(Some("Stream map '0:v:0' matches no streams.")),
            NO_VIDEO_MESSAGE
        );
        assert_eq!(
            describe(Some("No such file or directory")),
            "The file could not be found. It may have been moved, renamed, or deleted."
        );
        assert_eq!(
            describe(Some("Unknown encoder 'libsvtav1'")),
            "This FFmpeg build does not include the libsvtav1 encoder needed for this preset."
        );
        assert_eq!(
            describe(Some("No space left on device")),
            "The output drive is full. Free up space or choose another output folder."
        );
    }

    #[test]
    fn fallback_uses_last_meaningful_line() {
        let text = "ffmpeg version 8.0 Copyright\n  configuration: --x\n[in#0 @ 0x12345678] /Users/someone/file.mp4: weird failure\nConversion failed!";
        assert_eq!(describe(Some(text)), "FFmpeg error: file.mp4: weird failure");
        assert_eq!(
            describe(Some("")),
            "FFmpeg stopped without an error message. Open Logs for details."
        );
    }

    #[test]
    fn detail_drops_banner_and_keeps_tail() {
        let text = (0..50)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let detail = detail(Some(&format!("ffmpeg version 8\n{text}")));
        let lines: Vec<&str> = detail.lines().collect();
        assert_eq!(lines.len(), 40);
        assert_eq!(lines[0], "line 10");
        assert_eq!(lines[39], "line 49");
    }

    #[test]
    fn bounded_error_output_keeps_the_tail() {
        let mut buffer = "old".to_string();
        append_bounded_error_output(&mut buffer, "new");
        assert_eq!(buffer, "oldnew");
        let mut long = "a".repeat(MAX_ERROR_OUTPUT_CHARS - 2);
        append_bounded_error_output(&mut long, "éé");
        assert_eq!(long.len(), MAX_ERROR_OUTPUT_CHARS);
        assert!(long.ends_with("éé"));
        assert!(std::str::from_utf8(long.as_bytes()).is_ok());
    }

    #[test]
    fn retries_distinguish_input_from_acceleration_errors() {
        assert!(should_retry_with_software_decode(
            "Failed setup for format cuda: hwaccel initialisation returned error"
        ));
        assert!(!should_retry_with_software_decode(
            "No such file or directory"
        ));
        assert!(should_retry_with_cpu(
            false,
            false,
            GpuVendor::Nvidia,
            true,
            "OpenEncodeSessionEx failed",
            false
        ));
        assert!(!should_retry_with_cpu(
            true,
            false,
            GpuVendor::Nvidia,
            true,
            "nvenc",
            true
        ));
        assert!(!should_retry_with_cpu(
            false,
            false,
            GpuVendor::Cpu,
            true,
            "nvenc",
            true
        ));
        assert!(should_retry_with_cpu(
            false,
            false,
            GpuVendor::Intel,
            true,
            "anything",
            true
        ));
        assert!(!should_retry_with_cpu(
            false,
            true,
            GpuVendor::Intel,
            true,
            "nvenc",
            true
        ));
        assert!(!should_retry_with_cpu(
            false,
            false,
            GpuVendor::Amd,
            true,
            "No such file or directory",
            true
        ));
    }

    #[test]
    fn clean_line_strips_prefix_and_path() {
        assert_eq!(
            clean_line("[out#0/mp4 @ 0x7f0000000000] /tmp/work/out.mp4: Invalid argument"),
            "out.mp4: Invalid argument"
        );
    }
}
