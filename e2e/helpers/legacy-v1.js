import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./hash.js";

/**
 * Each way the one-time CONV2 1.x import can go wrong, and a short note on the
 * expected behavior. Scenarios list the ids they cover in `covers`; the gate
 * fails when one has no covering scenario.
 */
export const LEGACY_IMPORT_FAILURE_MODES = {
  "settings-imported":
    "v1 settings, window state, and GPU cache are copied and the settings are normalized",
  "marker-written": "legacy-v1-import.json records outcome, source, and files",
  "v1-folder-untouched": "the v1 folder is only read, never modified",
  "corrupt-settings":
    "unreadable v1 settings.json leaves no v2 settings and records a skipped outcome",
  "existing-data-preserved":
    "a v2 file already in place is never replaced by its v1 copy",
  "v2-settings-win":
    "a profile that already has v2 settings ignores v1 data entirely",
};

export const LEGACY_CASES = [
  "import",
  "corrupt-settings",
  "preserve-v2",
  "v2-settings-win",
];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** v1 files as Electron's userData folder held them. */
export function v1Files({ outputDirectory }) {
  return {
    settings: {
      settingsSchemaVersion: 6,
      outputDirectory,
      gpu: "cpu",
      gpuMode: "manual",
      gpuManualVendor: "cpu",
      theme: "light",
      showDebugOutput: true,
      removeSpacesFromFilenames: true,
      setupWizardCompleted: true,
      recentPresetIds: ["h264-fast"],
    },
    windowState: { width: 1111, height: 777, isMaximized: false },
    gpuProbeCache: { version: 1, entries: {} },
  };
}

/**
 * Seed the v1 folder for `legacyCase`. Returns what the spec needs to assert:
 * the v1 values, and a snapshot hash of every v1 file for the untouched check.
 */
export function seedLegacyV1Data(profile, { legacyCase }) {
  const files = v1Files({ outputDirectory: profile.output });
  const v1Settings = path.join(profile.legacyDir, "settings.json");
  fs.mkdirSync(profile.legacyDir, { recursive: true });
  if (legacyCase === "corrupt-settings") {
    fs.writeFileSync(v1Settings, "{ this is not json");
  } else {
    writeJson(v1Settings, files.settings);
  }
  writeJson(
    path.join(profile.legacyDir, "windowState.json"),
    files.windowState,
  );
  writeJson(
    path.join(profile.legacyDir, "gpu-probe-cache.json"),
    files.gpuProbeCache,
  );
  const preserved = { width: 999, height: 700, isMaximized: false };
  if (legacyCase === "preserve-v2") {
    // A v2 window state exists, but no settings yet: the import still runs and
    // must leave this file alone.
    writeJson(path.join(profile.dataDir, "windowState.json"), preserved);
  }
  return {
    legacyCase,
    outputDirectory: profile.output,
    v1: files,
    preserved,
    v1Hashes: snapshotDir(profile.legacyDir),
  };
}

/** SHA-256 of every file directly inside `dir`, keyed by name. */
export function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [
        entry.name,
        sha256(fs.readFileSync(path.join(dir, entry.name))),
      ]),
  );
}
