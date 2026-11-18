//! FFmpeg progress parsing: `-progress pipe:1` stdout and legacy stderr
//! status lines (v1 ffmpegProgress.ts).

use crate::types::ConversionProgress;
use regex::Regex;
use std::sync::OnceLock;

fn out_time_ms_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^[+-]?\d+").expect("valid regex"))
}

fn number_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^[+-]?(?:\d+\.?\d*|\.\d+)").expect("valid regex"))
}

fn frame_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"frame=\s*(\d+)").expect("valid regex"))
}

fn fps_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"fps=\s*([\d.]+)").expect("valid regex"))
}

fn time_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"time=\s*([\d:.]+)").expect("valid regex"))
}

fn bitrate_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"bitrate=\s*([\d.]+\s*\w+)").expect("valid regex"))
}

fn speed_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"speed=\s*([\d.]+x)").expect("valid regex"))
}

/// JS `parseInt` on the first run of digits, plus sign support.
fn parse_int_leading(text: &str) -> Option<i64> {
    out_time_ms_regex()
        .find(text.trim_start())
        .and_then(|matched| matched.as_str().parse::<i64>().ok())
}

/// JS `parseFloat` on the leading numeric prefix.
fn parse_float_leading(text: &str) -> f64 {
    number_regex()
        .find(text.trim_start())
        .and_then(|matched| matched.as_str().parse::<f64>().ok())
        .unwrap_or(0.0)
}

/// Parse `out_time_ms=` (microseconds) into seconds and a clamped percent.
pub fn parse_out_time_ms(line: &str, total_duration: f64) -> Option<(f64, f64)> {
    let index = line.find("out_time_ms=")?;
    let rest = &line[index + "out_time_ms=".len()..];
    let raw = rest.split('=').next().unwrap_or(rest);
    let time_us = parse_int_leading(raw).filter(|value| *value >= 0)?;
    let seconds = time_us as f64 / 1_000_000.0;
    let percent = if total_duration > 0.0 {
        (seconds / total_duration * 100.0).min(100.0)
    } else {
        0.0
    };
    Some((percent, seconds))
}

/// Parse a legacy stderr status line, or None when it carries no `time=`.
pub fn parse_progress(line: &str, total_duration: f64) -> Option<ConversionProgress> {
    let time_match = time_regex().captures(line)?;
    let time = time_match.get(1)?.as_str();
    let parts: Vec<f64> = time
        .split(':')
        .map(|part| {
            let parsed = parse_float_leading(part);
            if parsed.is_finite() {
                parsed
            } else {
                0.0
            }
        })
        .collect();
    let seconds = if parts.len() >= 3 {
        parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]
    } else if parts.len() == 2 {
        parts[0] * 60.0 + parts[1]
    } else {
        parts.first().copied().unwrap_or(0.0)
    };
    let percent = if total_duration > 0.0 {
        (seconds / total_duration * 100.0).min(100.0)
    } else {
        0.0
    };
    let frame = frame_regex()
        .captures(line)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<u64>().ok())
        .unwrap_or(0);
    let fps = fps_regex()
        .captures(line)
        .and_then(|captures| captures.get(1))
        .map(|value| parse_float_leading(value.as_str()))
        .unwrap_or(0.0);
    Some(ConversionProgress {
        percent,
        frame,
        fps,
        time: time.to_string(),
        bitrate: bitrate_regex()
            .captures(line)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| "N/A".to_string()),
        speed: speed_regex()
            .captures(line)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| "N/A".to_string()),
    })
}

/// `HH:MM:SS`, as v1's formatTime produced for `-progress` updates.
pub fn format_time(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    format!("{:02}:{:02}:{:02}", total / 3600, (total % 3600) / 60, total % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_time_uses_microseconds_and_clamps() {
        assert_eq!(parse_out_time_ms("out_time_ms=5000000", 10.0), Some((50.0, 5.0)));
        assert_eq!(
            parse_out_time_ms("out_time_ms=99999999", 10.0),
            Some((100.0, 99.999999))
        );
        assert_eq!(parse_out_time_ms("out_time_us=1", 10.0), None);
        assert_eq!(parse_out_time_ms("out_time_ms=-1", 10.0), None);
        assert_eq!(parse_out_time_ms("out_time_ms=abc", 10.0), None);
        assert_eq!(parse_out_time_ms("out_time_ms=1000000", 0.0), Some((0.0, 1.0)));
    }

    #[test]
    fn stderr_line_projection_matches_v1() {
        let progress = parse_progress(
            "frame=  120 fps= 30.5 q=28.0 size=  12kB time=00:00:04.00 bitrate= 24.6kbits/s speed=1.5x",
            10.0,
        )
        .unwrap();
        assert_eq!(progress.percent, 40.0);
        assert_eq!(progress.frame, 120);
        assert_eq!(progress.fps, 30.5);
        assert_eq!(progress.time, "00:00:04.00");
        assert_eq!(progress.bitrate, "24.6kbits");
        assert_eq!(progress.speed, "1.5x");
    }

    #[test]
    fn stderr_line_defaults_to_na_and_zero() {
        let progress = parse_progress("time=01:02.5", 60.0).unwrap();
        assert_eq!(progress.percent, 100.0);
        assert_eq!(progress.frame, 0);
        assert_eq!(progress.fps, 0.0);
        assert_eq!(progress.time, "01:02.5");
        assert_eq!(progress.bitrate, "N/A");
        assert_eq!(progress.speed, "N/A");
        assert_eq!(parse_progress("frame=1", 10.0), None);
    }

    #[test]
    fn format_time_pads() {
        assert_eq!(format_time(3661.9), "01:01:01");
        assert_eq!(format_time(-1.0), "00:00:00");
    }
}
