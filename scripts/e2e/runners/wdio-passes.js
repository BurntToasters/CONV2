// WebdriverIO passes: shared env, per-pass profiles, and the pass builders.
// Each pass is one app launch; the gate records its outcome and continues.

import path from "node:path";
import {
  createE2eProfile,
  e2eBinaryPath,
} from "../../../e2e/helpers/profile.js";
import {
  LEGACY_CASES,
  seedLegacyV1Data,
} from "../../../e2e/helpers/legacy-v1.js";
import { npxCommand, reserveFreePort, runAsync } from "../common.js";
import { companionFfprobe } from "../fixtures.js";

/** The PATH variable's real name; Windows environments spell it `Path`. */
function pathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

/**
 * The environment every WebdriverIO pass shares. A system FFmpeg that is not
 * on PATH (CONV2_E2E_FFMPEG) is put first on the app's PATH: the profile sets
 * useSystemFfmpeg, and the app finds FFmpeg only through PATH.
 */
export function buildSharedWdioEnv({
  ffmpeg,
  ffprobe,
  fixtures,
  fixtureFiles,
  baseEnv = process.env,
}) {
  const key = pathKey(baseEnv);
  const systemFfmpegDir =
    ffmpeg?.source === "system" ? path.dirname(ffmpeg.binary) : null;
  return {
    CONV2_E2E_BINARY: e2eBinaryPath(),
    CONV2_E2E_FIXTURES: JSON.stringify(fixtureFiles),
    CONV2_E2E_FIXTURE_HASHES: JSON.stringify(fixtures),
    CONV2_E2E_HAS_FFMPEG: ffmpeg ? "1" : "0",
    CONV2_E2E_FFMPEG: ffmpeg?.binary ?? "",
    CONV2_E2E_FFMPEG_SOURCE: ffmpeg?.source ?? "",
    CONV2_E2E_FFPROBE: ffmpeg
      ? (ffprobe ?? companionFfprobe(ffmpeg.binary) ?? "")
      : "",
    ...(systemFfmpegDir
      ? {
          [key]: [systemFfmpegDir, baseEnv[key]]
            .filter(Boolean)
            .join(path.delimiter),
        }
      : {}),
  };
}

async function runWdioPass(pass, env, sharedEnv) {
  // A fresh, verified-free port per pass: a leftover app on a fixed port
  // would answer /status and the pass would drive the wrong app.
  const port = await reserveFreePort();
  return runAsync(npxCommand(), ["wdio", "run", "e2e/wdio.conf.js"], {
    env: {
      ...pass.profile.env,
      ...sharedEnv,
      CONV2_E2E_OUTPUT: pass.profile.output,
      CONV2_E2E_PROFILE: pass.profile.profileDir,
      CONV2_E2E_RESULTS: pass.resultsPath,
      TAURI_WEBDRIVER_PORT: String(port),
      ...env,
    },
  });
}

// Records the pass outcome on the pass object and never throws, so the gate
// runs every later pass and fails once at the end with all results.
export async function runRecordedWdioPass(pass, env, sharedEnv) {
  try {
    await runWdioPass(pass, env, sharedEnv);
    pass.status = "passed";
  } catch (error) {
    pass.status = "failed";
    pass.reason = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Fresh CONV2 2 profiles with CONV2 1 data beside them, each a separate app
 * launch because the import only runs before the first settings file.
 * `trackProfile` sees each profile as soon as it exists, for cleanup.
 */
export function buildLegacyPasses({
  onlySpec,
  ownerEnabled,
  useSystemFfmpeg,
  trackProfile = () => {},
}) {
  if (onlySpec || !ownerEnabled("legacy-import")) return [];
  return LEGACY_CASES.map((legacyCase) => {
    // v2-settings-win starts with v2 settings already on disk.
    const profile = createE2eProfile({
      seedSettings: legacyCase === "v2-settings-win",
      useSystemFfmpeg,
    });
    trackProfile(profile);
    return {
      name: `legacy-import/${legacyCase}`,
      legacyCase,
      profile,
      status: "pending",
      reason: null,
      seed: seedLegacyV1Data(profile, { legacyCase }),
      resultsPath: path.join(profile.profileDir, "results.json"),
    };
  });
}
