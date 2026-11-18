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
 *   5. exits non-zero until the operator passes --confirm-digests
 *
 * Checksum regeneration requires FFMPEG_ALLOW_CHECKSUM_GENERATION=1 in the
 * caller's environment; this script never supplies that approval itself.
 *
 * Usage: npm run get:ffmpeg:update -- --confirm-digests
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
 */
function run(label, args) {
  console.log(`\n── ${label} ──`);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
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
  const confirmDigests = process.argv.slice(2).includes("--confirm-digests");
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
    run("Generate checksums", [
      "scripts/check-ffmpeg.cjs",
      "--all",
      "--generate-checksums",
    ]);
    run("Check regenerated manifest", [
      "scripts/check-ffmpeg.cjs",
      "--all",
      "--require-checksums",
    ]);
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

  console.log(
    "\n✓ FFmpeg files downloaded and resources/ffmpeg/checksums.json regenerated.",
  );
  console.log("  The manifest was derived from the downloaded bytes, so it is");
  console.log(
    "  not independent evidence. Cross-check the digests above against",
  );
  console.log("  the builder's published values (build-setup.md), then run:");
  console.log("    npm run ffmpeg:check -- --require-checksums");
  console.log("  before committing resources/ffmpeg/checksums.json.\n");

  if (!confirmDigests) {
    console.error(
      "✗ Digests are unconfirmed. After the manual cross-check passes, re-run",
    );
    console.error(
      "  this flow with --confirm-digests to exit 0 and commit the manifest.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("✓ Digests confirmed by the operator (--confirm-digests).");
}

if (require.main === module) {
  main();
}
