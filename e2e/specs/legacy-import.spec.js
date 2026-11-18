import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../helpers/app-bridge.js";
import { snapshotDir } from "../helpers/legacy-v1.js";

const env = process.env;
const CASE = env.CONV2_E2E_LEGACY_CASE;
const SEED = JSON.parse(env.CONV2_E2E_LEGACY_V1 || "{}");
const RESULTS_PATH = env.CONV2_E2E_RESULTS;
const PROFILE = env.CONV2_E2E_PROFILE;
const DATA_DIR = path.join(PROFILE, "app-data");
const LEGACY_DIR = path.join(PROFILE, "legacy-appdata", "conv2");
const NAME = `legacy-import/${CASE}`;

const results = [];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const inData = (name) => path.join(DATA_DIR, name);

/** Each case asserts its own outcome; `covers` feeds the gate's coverage check. */
const CASES = {
  async import() {
    const marker = readJson(inData("legacy-v1-import.json"));
    assert.equal(marker.outcome, "imported");
    assert.equal(marker.source, LEGACY_DIR);
    assert.deepEqual([...marker.imported].sort(), [
      "gpu-probe-cache.json",
      "settings.json",
      "windowState.json",
    ]);
    assert.deepEqual(marker.skipped, []);

    // The v1 values arrive through the normal settings path.
    const settings = await api("getSettings");
    assert.equal(settings.theme, "light");
    assert.equal(settings.outputDirectory, SEED.outputDirectory);
    assert.equal(settings.showDebugOutput, true);
    assert.equal(settings.removeSpacesFromFilenames, true);
    assert.deepEqual(settings.recentPresetIds, ["h264-fast"]);
    assert.equal(
      settings.settingsSchemaVersion,
      7,
      "normalized to the v2 schema",
    );
    assert.equal(readJson(inData("settings.json")).theme, "light");

    // The imported window state is used for the first window (logical units).
    assert.deepEqual(readJson(inData("windowState.json")), SEED.v1.windowState);
    const size = await browser.getWindowSize();
    assert.ok(
      Math.abs(size.width - SEED.v1.windowState.width) <= 4,
      `window width ${size.width} should match the imported ${SEED.v1.windowState.width}`,
    );
    assert.ok(
      Math.abs(size.height - SEED.v1.windowState.height) <= 60,
      `window height ${size.height} should match the imported ${SEED.v1.windowState.height}`,
    );
    return {
      covers: ["settings-imported", "marker-written", "v1-folder-untouched"],
      windowSize: size,
    };
  },

  async "corrupt-settings"() {
    const marker = readJson(inData("legacy-v1-import.json"));
    assert.notEqual(marker.outcome, "imported");
    assert.match(marker.reason ?? "", /settings\.json/);
    assert.deepEqual(
      marker.imported,
      [],
      "nothing is imported on a bad settings file",
    );
    // The app still starts on defaults, and writes its own settings file.
    const settings = await api("getSettings");
    assert.equal(settings.settingsSchemaVersion, 7);
    assert.notEqual(settings.outputDirectory, SEED.outputDirectory);
    assert.equal(
      settings.setupWizardCompleted,
      false,
      "a first launch shows setup",
    );
    return {
      covers: ["corrupt-settings", "marker-written", "v1-folder-untouched"],
      outcome: marker.outcome,
    };
  },

  async "preserve-v2"() {
    const marker = readJson(inData("legacy-v1-import.json"));
    assert.equal(marker.outcome, "imported");
    // The existing v2 window state is kept byte for byte; only settings and
    // the GPU cache come across.
    assert.deepEqual(readJson(inData("windowState.json")), SEED.preserved);
    assert.deepEqual(
      marker.skipped.map((entry) => entry.file),
      ["windowState.json"],
    );
    assert.deepEqual([...marker.imported].sort(), [
      "gpu-probe-cache.json",
      "settings.json",
    ]);
    assert.equal((await api("getSettings")).theme, "light");
    return {
      covers: [
        "existing-data-preserved",
        "settings-imported",
        "marker-written",
      ],
    };
  },
};

CASES["v2-settings-win"] = async () => {
  // v1 data sits beside a profile that already has v2 settings: no import.
  assert.equal(fs.existsSync(inData("legacy-v1-import.json")), false);
  assert.equal(fs.existsSync(inData("windowState.json")), false);
  const settings = await api("getSettings");
  assert.equal(
    settings.theme,
    "dark",
    "the v2 settings win over v1's light theme",
  );
  assert.equal(settings.setupWizardCompleted, true);
  return { covers: ["v2-settings-win", "v1-folder-untouched"] };
};

describe(`CONV2 ${NAME}`, () => {
  before(async () => {
    assert.ok(CASES[CASE], `unknown legacy case ${CASE}`);
    await waitForAppReady();
  });

  after(() => {
    if (RESULTS_PATH) {
      fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
    }
  });

  it("imports CONV2 1 data once and leaves the v1 folder alone", async () => {
    const details = await CASES[CASE]();
    // The v1 folder is only ever read.
    assert.deepEqual(
      snapshotDir(LEGACY_DIR),
      SEED.v1Hashes,
      "the v1 folder changed during the import",
    );
    results.push({ name: NAME, status: "passed", ...details });
  });
});
