// @ts-check
"use strict";

/**
 * update-ffmpeg.js
 *
 * Moves all targets to a new FFmpeg build from FFMPEG_DL_SERVER:
 *   1. backs up resources/ffmpeg/ (binaries + checksums.json)
 *   2. drops the old manifest so new hashes are accepted
 *   3. downloads all 6 targets, regenerates checksums.json, re-checks
 *   4. on any failure or Ctrl+C, restores the backup untouched
 *
 * Usage: npm run get:ffmpeg:update
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const ffmpegDir = path.join(projectRoot, "resources", "ffmpeg");
const checksumsPath = path.join(ffmpegDir, "checksums.json");

/** @param {string} file */
function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {string} label
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(label, args, env) {
  console.log(`\n── ${label} ──`);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} interrupted (${result.signal})`);
  if (result.status !== 0)
    throw new Error(`${label} failed (exit ${result.status})`);
}

/** @param {Record<string, any>} oldManifest @param {Record<string, any>} newManifest */
function printHashDiff(oldManifest, newManifest) {
  console.log("\n── Checksum changes ──");
  for (const [target, entry] of Object.entries(newManifest)) {
    for (const [binary, info] of Object.entries(entry?.binaries ?? {})) {
      const before = oldManifest?.[target]?.binaries?.[binary]?.sha256;
      const after = info?.sha256;
      const tag =
        before === after ? "unchanged" : before ? "updated  " : "new      ";
      console.log(`  ${tag} ${target.padEnd(12)} ${binary.padEnd(8)} ${after}`);
    }
  }
}

function main() {
  // Child gets SIGINT itself; keep this process alive so it can restore.
  process.on("SIGINT", () => {});

  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "conv2-ffmpeg-backup-"),
  );
  const backupDir = path.join(backupRoot, "ffmpeg");
  console.log(`Backing up resources/ffmpeg/ → ${backupDir}`);
  fs.cpSync(ffmpegDir, backupDir, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });

  const oldManifest = readManifest(checksumsPath);

  try {
    fs.rmSync(checksumsPath, { force: true });
    run("Download all targets", [
      "scripts/get-ffmpeg.cjs",
      "--all",
      "--allow-unverified",
    ]);
    run(
      "Generate checksums",
      ["scripts/check-ffmpeg.cjs", "--all", "--generate-checksums"],
      {
        FFMPEG_ALLOW_CHECKSUM_GENERATION: "1",
      },
    );
    run("Verify", ["scripts/check-ffmpeg.cjs", "--all", "--require-checksums"]);
  } catch (err) {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    console.error("Restoring previous resources/ffmpeg/ ...");
    fs.rmSync(ffmpegDir, { recursive: true, force: true });
    fs.cpSync(backupDir, ffmpegDir, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    fs.rmSync(backupRoot, { recursive: true, force: true });
    console.error("Restored. No changes were made.");
    process.exit(1);
  }

  printHashDiff(oldManifest, readManifest(checksumsPath));
  fs.rmSync(backupRoot, { recursive: true, force: true });

  console.log("\n✓ FFmpeg updated for all targets.");
  console.log(
    "  Cross-check a few hashes against an independent source, then commit",
  );
  console.log("  resources/ffmpeg/checksums.json.\n");
}

if (require.main === module) {
  main();
}
