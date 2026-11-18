#!/usr/bin/env node
/**
 * Prepare Tauri externalBin sidecars (FFmpeg, ffprobe) under
 * src-tauri/binaries/ using Tauri's `<name>-<target-triple>[.exe]` layout.
 *
 * Every source binary is verified against its committed checksum manifest
 * before it is copied:
 *   - FFmpeg:  resources/ffmpeg/checksums.json
 *
 * A prepared-sidecar manifest (src-tauri/binaries/.sidecar-manifest.json)
 * records the SHA-256 of every prepared file. build.rs re-hashes the sidecars
 * for the Cargo target against it and refuses stub sidecars in release builds.
 *
 * Usage:
 *   node scripts/prepare-sidecars.js                    host platform targets
 *   node scripts/prepare-sidecars.js --all              every supported target
 *   node scripts/prepare-sidecars.js --target <triple>  explicit target(s)
 *   node scripts/prepare-sidecars.js --allow-stub-ffmpeg
 *       Development/CI compile only: write non-functional FFmpeg stubs when
 *       the (non-committed) FFmpeg binaries are absent. Release profile builds
 *       reject these stubs in build.rs.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "binaries");
const manifestPath = path.join(outDir, ".sidecar-manifest.json");
const ffmpegChecksumPath = path.join(
  root,
  "resources",
  "ffmpeg",
  "checksums.json",
);

export const SIDECAR_NAMES = Object.freeze(["conv2-ffmpeg", "conv2-ffprobe"]);
export const STUB_MARKER = "CONV2-SIDECAR-STUB";

export const TARGETS = Object.freeze({
  "x86_64-pc-windows-msvc": { ffmpeg: "win:x64", ext: ".exe" },
  "aarch64-pc-windows-msvc": { ffmpeg: "win:arm64", ext: ".exe" },
  "x86_64-apple-darwin": { ffmpeg: "mac:x64", ext: "" },
  "aarch64-apple-darwin": { ffmpeg: "mac:arm64", ext: "" },
  "universal-apple-darwin": { ffmpeg: "mac:universal", ext: "" },
  "x86_64-unknown-linux-gnu": { ffmpeg: "linux:x64", ext: "" },
  "aarch64-unknown-linux-gnu": { ffmpeg: "linux:arm64", ext: "" },
});

export function hostTargets(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    return [
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "universal-apple-darwin",
    ];
  }
  if (platform === "win32") {
    return ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"];
  }
  if (platform === "linux") {
    return [
      arch === "arm64"
        ? "aarch64-unknown-linux-gnu"
        : "x86_64-unknown-linux-gnu",
    ];
  }
  throw new Error(`Unsupported host platform for sidecars: ${platform}`);
}

export function parseArgs(argv) {
  const options = { all: false, allowStubFfmpeg: false, targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--allow-stub-ffmpeg") {
      options.allowStubFfmpeg = true;
    } else if (arg === "--target") {
      const value = argv[index + 1];
      if (!value || !TARGETS[value]) {
        throw new Error(
          `--target requires one of: ${Object.keys(TARGETS).join(", ")}`,
        );
      }
      options.targets.push(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read ${label} (${path.relative(root, filePath)}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Returns the verified FFmpeg/ffprobe source path, or null when absent. */
function verifiedFfmpegSource(key, binary, ffmpegChecksums) {
  const entry = ffmpegChecksums?.[key]?.binaries?.[binary];
  const [platform, arch] = key.split(":");
  const ext = platform === "win" ? ".exe" : "";
  const relative = `resources/ffmpeg/${platform}/${arch}/${binary}${ext}`;
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) return null;
  if (!entry?.sha256 || entry.path !== relative) {
    throw new Error(
      `resources/ffmpeg/checksums.json has no ${binary} entry for ${key} at ${relative}`,
    );
  }
  const actual = sha256File(source);
  if (actual !== entry.sha256) {
    throw new Error(
      `FFmpeg checksum mismatch for ${relative}\n  expected: ${entry.sha256}\n  actual:   ${actual}\nRe-fetch with npm run get:ffmpeg (which regenerates checksums) and review the diff.`,
    );
  }
  return source;
}

function writeExecutable(destination, writer) {
  fs.rmSync(destination, { force: true });
  writer();
  if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
}

function stubContents(name) {
  return `#!/bin/sh\n# ${STUB_MARKER}: ${name} is not bundled in this development build.\necho "${name} is unavailable in this development build" >&2\nexit 127\n`;
}

function lipoUniversal(inputs, destination) {
  const result = spawnSync(
    "lipo",
    ["-create", ...inputs, "-output", destination],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`lipo failed for ${destination}: ${result.stderr}`);
  }
}

export function prepareSidecars(options) {
  const targets =
    options.targets.length > 0
      ? Array.from(new Set(options.targets))
      : options.all
        ? Object.keys(TARGETS)
        : hostTargets();
  const ffmpegChecksums = readJson(ffmpegChecksumPath, "FFmpeg checksums");
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = fs.existsSync(manifestPath)
    ? readJson(manifestPath, "sidecar manifest")
    : {};
  if (!options.allowStubFfmpeg) {
    // Release preparation purges development stubs left by earlier dev/CI
    // runs (release VMs reset with `git clean -fd`, which keeps ignored
    // files), so a stale stub can never be bundled or signed.
    for (const [name, entry] of Object.entries(manifest)) {
      if (entry?.stub !== true) continue;
      fs.rmSync(path.join(outDir, name), { force: true });
      delete manifest[name];
    }
  }
  const summary = [];

  for (const triple of targets) {
    const spec = TARGETS[triple];
    const fileFor = (name) => `${name}-${triple}${spec.ext}`;

    for (const binary of ["ffmpeg", "ffprobe"]) {
      const dest = path.join(outDir, fileFor(`conv2-${binary}`));
      let sources;
      if (spec.ffmpeg === "mac:universal") {
        sources = ["mac:x64", "mac:arm64"].map((key) =>
          verifiedFfmpegSource(key, binary, ffmpegChecksums),
        );
      } else {
        sources = [verifiedFfmpegSource(spec.ffmpeg, binary, ffmpegChecksums)];
      }
      const missing = sources.some((source) => !source);
      if (missing) {
        if (!options.allowStubFfmpeg) {
          throw new Error(
            `Missing ${binary} for ${triple} (${spec.ffmpeg}). Fetch FFmpeg with npm run get:ffmpeg (see resources/ffmpeg/README.md).`,
          );
        }
        writeExecutable(dest, () =>
          fs.writeFileSync(dest, stubContents(`conv2-${binary}`)),
        );
        manifest[path.basename(dest)] = {
          sha256: sha256File(dest),
          stub: true,
          source: "stub",
        };
        summary.push(`${path.basename(dest)} (STUB)`);
        continue;
      }
      if (sources.length > 1) {
        if (process.platform !== "darwin") {
          throw new Error(
            `${triple} needs lipo to merge ${binary}; prepare it on macOS.`,
          );
        }
        writeExecutable(dest, () => lipoUniversal(sources, dest));
      } else {
        writeExecutable(dest, () => fs.copyFileSync(sources[0], dest));
      }
      manifest[path.basename(dest)] = {
        sha256: sha256File(dest),
        stub: false,
        source:
          sources.length > 1
            ? "lipo(resources/ffmpeg/mac/x64, resources/ffmpeg/mac/arm64)"
            : path.relative(root, sources[0]).replaceAll("\\", "/"),
      };
    }
    summary.push(triple);
  }

  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
  return summary;
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  try {
    const summary = prepareSidecars(parseArgs(process.argv.slice(2)));
    console.log(`[prepare-sidecars] Prepared: ${summary.join(", ")}`);
  } catch (error) {
    console.error(
      `[prepare-sidecars] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
