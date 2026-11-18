import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const APP_ID = "run.rosie.conv2";
const permanentDisabledFeatures = [
  "CalculateNativeWinOcclusion",
  "RendererCodeIntegrity",
];
// TEMP_WEBVIEW2_LOCKOUT_WORKAROUND: temporary upstream workaround, remove.
// A fresh WebView2 environment can log a failed Windows interactive logon
// (Event 4625); repeated E2E launches can lock the account.
// Tracking: MicrosoftEdge/WebView2Feedback #5722, Chromium #562403601.
export const TEMP_WEBVIEW2_LOCKOUT_FEATURES = [
  "AutofillAiWalletPrivatePasses",
  "AutofillAmbientAutofill",
];
export const E2E_WEBVIEW2_BROWSER_ARGS = `--disable-gpu --disable-features=${[
  ...permanentDisabledFeatures,
  ...TEMP_WEBVIEW2_LOCKOUT_FEATURES,
].join(",")}`;

const FEATURE_SWITCHES = ["--disable-features=", "--enable-features="];

/**
 * Merges WebView2 browser-argument strings. All --disable-features and
 * --enable-features values collapse into one switch each, placed where the
 * first occurrence appeared; other switches are kept once, in order.
 */
export function mergeWebView2BrowserArgs(...argStrings) {
  const order = [];
  const seen = new Set();
  const features = new Map(FEATURE_SWITCHES.map((prefix) => [prefix, []]));
  for (const argString of argStrings) {
    if (!argString) continue;
    for (const token of String(argString).split(/\s+/)) {
      if (!token) continue;
      const prefix = FEATURE_SWITCHES.find((item) => token.startsWith(item));
      if (prefix) {
        const names = features.get(prefix);
        if (!seen.has(prefix)) {
          seen.add(prefix);
          order.push(prefix);
        }
        for (const name of token.slice(prefix.length).split(",")) {
          const trimmed = name.trim();
          if (trimmed && !names.includes(trimmed)) names.push(trimmed);
        }
      } else if (!seen.has(token)) {
        seen.add(token);
        order.push(token);
      }
    }
  }
  return order
    .map((item) => {
      const names = features.get(item);
      if (!names) return item;
      return names.length ? `${item}${names.join(",")}` : null;
    })
    .filter((item) => item !== null)
    .join(" ");
}

export function hostBinaryName(platform = process.platform) {
  return platform === "win32" ? "conv2.exe" : "conv2";
}

export function e2eBinaryPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, "src-tauri", "target", "debug", hostBinaryName());
}

export function e2eStampPath(repoRoot = REPO_ROOT) {
  return path.join(
    repoRoot,
    "src-tauri",
    "target",
    "debug",
    ".conv2-e2e-stamp",
  );
}

/** Settings that skip the setup wizard so the suite exercises the main UI. */
export function e2eSettings({ outputDirectory, useSystemFfmpeg = false }) {
  return {
    settingsSchemaVersion: 7,
    outputDirectory,
    gpu: "cpu",
    gpuMode: "manual",
    gpuManualVendor: "cpu",
    theme: "dark",
    showDebugOutput: true,
    autoCheckUpdates: false,
    notifyOnConversionComplete: false,
    preventSleepWhileConverting: false,
    moveOriginalToTrashOnSuccess: false,
    setupWizardCompleted: true,
    showAdvancedPresets: true,
    // CI has no bundled FFmpeg payload, so the suite uses the system one.
    useSystemFfmpeg,
  };
}

/**
 * An isolated profile: its own HOME, XDG dirs, and app data directory. With
 * `seedSettings: false` the app sees a first launch and may import v1 data
 * from `legacyDir`.
 */
export function createE2eProfile({
  seedSettings = true,
  useSystemFfmpeg = false,
} = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv2-e2e-"));
  const home = path.join(profileDir, "home");
  const dataDir = path.join(profileDir, "app-data");
  const legacyDir = path.join(profileDir, "legacy-appdata", "conv2");
  const output = path.join(home, "Videos", "conv2-e2e");
  for (const dir of [home, dataDir, output]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (seedSettings) {
    fs.writeFileSync(
      path.join(dataDir, "settings.json"),
      `${JSON.stringify(e2eSettings({ outputDirectory: output, useSystemFfmpeg }), null, 2)}\n`,
    );
  }
  const env = {
    CONV2_E2E: "1",
    CONV2_E2E_DATA_DIR: dataDir,
    CONV2_E2E_LEGACY_V1_DIR: legacyDir,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(profileDir, "data"),
    XDG_CONFIG_HOME: path.join(profileDir, "config"),
    XDG_STATE_HOME: path.join(profileDir, "state"),
    XDG_CACHE_HOME: path.join(profileDir, "cache"),
  };
  if (process.platform === "win32") {
    const webview2 = path.join(profileDir, "webview2");
    fs.mkdirSync(webview2, { recursive: true });
    env.WEBVIEW2_USER_DATA_FOLDER = webview2;
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = mergeWebView2BrowserArgs(
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      E2E_WEBVIEW2_BROWSER_ARGS,
    );
  }
  if (process.platform === "linux") {
    env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
  }
  return { profileDir, home, dataDir, legacyDir, output, env };
}
