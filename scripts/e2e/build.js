// E2E binary build, reuse, and generated-schema restore.

import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  e2eBinaryPath,
  e2eStampPath,
} from "../../e2e/helpers/profile.js";
import { npmCommand, npxCommand, run } from "./common.js";

const STAMP = "e2e-feature-1\n";

export function e2eBinaryIsFresh() {
  const binary = e2eBinaryPath();
  const stamp = e2eStampPath();
  if (!fs.existsSync(binary) || !fs.existsSync(stamp)) return false;
  if (fs.readFileSync(stamp, "utf8") !== STAMP) return false;
  // cargo test / clippy rebuild target/debug/conv2 without --features e2e.
  return fs.statSync(stamp).mtimeMs >= fs.statSync(binary).mtimeMs;
}

export function mayReuseE2eBinary({ onlySpec, reuseRequested, binaryFresh }) {
  return onlySpec === true && reuseRequested === true && binaryFresh === true;
}

function snapshotGeneratedSchemas() {
  const schemaDir = path.join(REPO_ROOT, "src-tauri", "gen", "schemas");
  if (!fs.existsSync(schemaDir)) return [];
  return fs
    .readdirSync(schemaDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(schemaDir, entry.name);
      return [file, fs.readFileSync(file)];
    });
}

function restoreGeneratedSchemas(snapshots) {
  for (const [file, contents] of snapshots) {
    fs.writeFileSync(file, contents);
  }
  // Files the build created (e.g. another platform's schema) were not in the
  // snapshot; remove them so the tracked directory ends as it began.
  const schemaDir = path.join(REPO_ROOT, "src-tauri", "gen", "schemas");
  if (!fs.existsSync(schemaDir)) return;
  const kept = new Set(snapshots.map(([file]) => file));
  for (const entry of fs.readdirSync(schemaDir, { withFileTypes: true })) {
    const file = path.join(schemaDir, entry.name);
    if (entry.isFile() && !kept.has(file)) fs.rmSync(file, { force: true });
  }
}

/**
 * Stages the sidecars in src-tauri/binaries: the real FFmpeg from
 * resources/ffmpeg when present, development stubs otherwise. The gate runs
 * this before it resolves the test FFmpeg, since that lookup only sees staged
 * sidecars; running it again is harmless.
 */
export function prepareE2eSidecars() {
  run(npmCommand(), ["run", "prepare:rust-tests"]);
}

export function buildE2eBinary({ sidecarsPrepared = false } = {}) {
  // Development stubs are acceptable: E2E uses a debug build and supplies a
  // real FFmpeg through the custom-path setting when one is available.
  if (!sidecarsPrepared) prepareE2eSidecars();
  // The licenses scenario renders these git-ignored notices; release builds
  // generate them in build:*, so a fresh checkout or CI runner has none yet.
  run(npmCommand(), ["run", "licenses"]);
  const schemaSnapshots = snapshotGeneratedSchemas();
  try {
    run(npxCommand(), [
      "tauri",
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      // Relative to the repo root (the run cwd): an absolute path with spaces
      // would be split by the Windows cmd shell.
      "src-tauri/tauri.e2e.conf.json",
      "--",
      "--features",
      "e2e",
    ]);
  } finally {
    // Tauri writes feature-dependent ACL schemas into this tracked directory.
    // An E2E build must not dirty a clean release checkout with test-only ACLs.
    restoreGeneratedSchemas(schemaSnapshots);
  }
  const binary = e2eBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(`E2E binary missing after build: ${binary}`);
  }
  fs.mkdirSync(path.dirname(e2eStampPath()), { recursive: true });
  fs.writeFileSync(e2eStampPath(), STAMP);
}
