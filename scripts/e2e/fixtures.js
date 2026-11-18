// Fixture media for the E2E gate: FFmpeg resolution and generated source clips.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { sha256 } from "../../e2e/helpers/hash.js";
import { which } from "./common.js";

function hostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const triple = result.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (!triple) throw new Error("Could not determine the Rust host triple.");
  return triple;
}

/**
 * The bundled FFmpeg sidecar for this host when it is real (not a dev stub).
 * The E2E build copies it next to the debug binary, so the app uses it.
 */
function resolveBundledFfmpeg() {
  const manifestPath = path.join(
    REPO_ROOT,
    "src-tauri",
    "binaries",
    ".sidecar-manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const ext = process.platform === "win32" ? ".exe" : "";
  const name = `conv2-ffmpeg-${hostTriple()}${ext}`;
  if (manifest[name]?.stub !== false) return null;
  const candidate = path.join(REPO_ROOT, "src-tauri", "binaries", name);
  return fs.existsSync(candidate) ? candidate : null;
}

/** A real FFmpeg for fixtures and verification (never the dev stub). */
export function resolveTestFfmpeg() {
  const bundled = resolveBundledFfmpeg();
  if (bundled) return { binary: bundled, source: "bundled" };
  const candidate = process.env.CONV2_E2E_FFMPEG || which("ffmpeg");
  if (!candidate || !fs.existsSync(candidate)) return null;
  const probe = spawnSync(candidate, ["-hide_banner", "-version"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  const base = path.basename(candidate).toLowerCase();
  if (base !== "ffmpeg" && base !== "ffmpeg.exe") return null;
  return { binary: candidate, source: "system" };
}

/** ffprobe that pairs with the FFmpeg used for fixtures. */
export function companionFfprobe(ffmpegBinary) {
  const directory = path.dirname(ffmpegBinary);
  const name = path.basename(ffmpegBinary).replace("ffmpeg", "ffprobe");
  const candidate = path.join(directory, name);
  return fs.existsSync(candidate) ? candidate : null;
}

function runFfmpeg(ffmpeg, args, label) {
  const result = spawnSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Could not build the ${label} fixture: ${result.stderr}`);
  }
}

/**
 * Source clips for the conversion scenarios. Returns each file's path and
 * SHA-256 so the evidence report pins the exact inputs.
 */
export function buildMediaFixtures({ ffmpeg, fixtureDir }) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const files = {};
  const add = (name) => {
    files[name] = path.join(fixtureDir, name);
    return files[name];
  };
  const withAudio = add("source.mp4");
  runFfmpeg(
    ffmpeg,
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=15:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      withAudio,
    ],
    "source",
  );
  runFfmpeg(
    ffmpeg,
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=15:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      add("video-only.mp4"),
    ],
    "video-only",
  );
  // WebM remux needs VP8, VP9 or AV1 video, so it gets its own source.
  runFfmpeg(
    ffmpeg,
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=15:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=550:duration=2",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-c:a",
      "libopus",
      "-shortest",
      add("source-vp9.webm"),
    ],
    "vp9",
  );
  // A long clip so a cancel lands while FFmpeg is still encoding.
  runFfmpeg(
    ffmpeg,
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30:duration=120",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=120",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      add("long.mp4"),
    ],
    "long",
  );
  // Mixes a non-Latin-1 script with Cyrillic and a Latin-1 accent.
  fs.copyFileSync(withAudio, add("日本語-Привет-café.mp4"));
  fs.copyFileSync(withAudio, add("my clip with spaces.mp4"));
  fs.writeFileSync(
    add("corrupt.mp4"),
    crypto
      .createHash("sha256")
      .update("conv2-e2e-corrupt")
      .digest()
      .toString("hex")
      .repeat(512),
  );
  fs.writeFileSync(add("notes.txt"), "not a video\n");
  const fixtures = Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      sha256(fs.readFileSync(file)),
    ]),
  );
  return { fixtures, files };
}
