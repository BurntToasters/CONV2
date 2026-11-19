import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { browser, $, $$ } from "@wdio/globals";
import { api, helper, waitForAppReady } from "../helpers/app-bridge.js";
import { sha256File } from "../helpers/hash.js";
import { createRequire } from "node:module";

const AXE_SOURCE = fs.readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

const env = process.env;
const OUTPUT = env.CONV2_E2E_OUTPUT;
const FILES = JSON.parse(env.CONV2_E2E_FIXTURES || "{}");
const RESULTS_PATH = env.CONV2_E2E_RESULTS;
const FFPROBE = env.CONV2_E2E_FFPROBE;
const SCREENSHOT_DIR = env.CONV2_E2E_SCREENSHOTS;
const FFMPEG_SOURCE = env.CONV2_E2E_FFMPEG_SOURCE;
const PACKAGE = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

const results = [];

/** Axe and screenshots must not sample a half-faded frame. */
async function waitForAnimationsToSettle() {
  await browser.waitUntil(
    async () =>
      browser.execute(
        () =>
          // Ambient effects loop forever; only finite animations must finish.
          document.getAnimations().filter((animation) => {
            const timing = animation.effect?.getComputedTiming();
            return (
              Number.isFinite(timing?.endTime) &&
              animation.playState === "running"
            );
          }).length === 0,
      ),
    { timeout: 10_000, timeoutMsg: "CSS animations never settled" },
  );
}

function record(name, details = {}) {
  results.push({ name, status: "passed", ...details });
}

/** ffprobe JSON for `file`; throws when the file is not readable media. */
function probe(file) {
  const run = spawnSync(
    FFPROBE,
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf8", windowsHide: true },
  );
  if (run.status !== 0) {
    throw new Error(`ffprobe failed for ${file}: ${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

/** A fresh, empty output directory for one scenario. */
function freshOutput(name) {
  const dir = path.join(OUTPUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * Start a queue and wait for it to finish. Returns the final snapshot and
 * everything the renderer heard while it ran.
 */
async function runQueue(
  { inputs, presetId, outputDirectory, ...rest },
  { timeout = 180_000 } = {},
) {
  await helper("resetCollected");
  await helper("startQueueDetached", {
    inputPaths: inputs.map((name) => FILES[name] ?? name),
    presetId,
    gpu: "cpu",
    outputDirectory,
    ...rest,
  });
  return waitForQueueEnd(timeout);
}

async function waitForQueueEnd(timeout = 180_000) {
  let collected = null;
  await browser.waitUntil(
    async () => {
      collected = await helper("collected");
      const last = collected.snapshots.at(-1);
      // The command's own answer must agree with the last published snapshot.
      return Boolean(
        collected.startResult &&
        last &&
        !last.active &&
        last.items.length > 0 &&
        last.items.every((item) => TERMINAL.has(item.status)),
      );
    },
    {
      timeout,
      interval: 300,
      timeoutMsg: "the conversion queue never reached a terminal state",
    },
  );
  const final = collected.snapshots.at(-1);
  assert.deepEqual(
    collected.startResult.items.map((item) => item.status),
    final.items.map((item) => item.status),
    "the start command answers with the final queue state",
  );
  return { ...collected, final };
}

function listOutputs(dir) {
  return fs.readdirSync(dir).sort();
}

const DATA_DIR = path.join(env.CONV2_E2E_PROFILE ?? "", "app-data");

const readSettingsFile = () =>
  JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));

/** The profile's starting settings, put back after a scenario changes them. */
const E2E_BASELINE = {
  theme: "dark",
  outputDirectory: OUTPUT,
  gpu: "cpu",
  gpuMode: "manual",
  gpuManualVendor: "cpu",
  removeSpacesFromFilenames: false,
  showAdvancedPresets: true,
  useSystemFfmpeg: FFMPEG_SOURCE === "system",
};

// What each preset category must produce for the 2 s source clip. ffprobe
// names the container `format_name`, a comma list for shared demuxers.
const CATEGORY_EXPECTATIONS = {
  av1: { video: ["av1"], audio: ["aac", "opus"] },
  h264: { video: ["h264"], audio: ["aac"] },
  h265: { video: ["hevc"], audio: ["aac"] },
  avi: { video: ["h264", "hevc"], audio: null },
  gif: { video: ["gif"], audio: [] },
  webp: { video: ["webp", "webp_anim"], audio: [] },
  remux: { video: null, audio: null },
  audio: { video: [], audio: null },
};
const FORMAT_BY_EXTENSION = {
  mp4: "mp4",
  mkv: "matroska",
  webm: "webm",
  avi: "avi",
  gif: "gif",
  webp: "webp",
  mp3: "mp3",
  aac: "aac",
  flac: "flac",
};
const AUDIO_CODEC_BY_EXTENSION = { mp3: "mp3", aac: "aac", flac: "flac" };

describe("CONV2 main window", () => {
  before(async () => {
    await waitForAppReady();
  });

  after(() => {
    if (RESULTS_PATH) {
      fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
    }
  });

  it("starts with the bundled FFmpeg and every preset", async () => {
    assert.equal(await api("getVersion"), PACKAGE.version);
    const ffmpeg = await api("checkFFmpeg");
    assert.equal(ffmpeg.ok, true, `FFmpeg check failed: ${ffmpeg.reason}`);
    assert.equal(ffmpeg.reason, "ok");
    assert.equal(ffmpeg.usingBundled, FFMPEG_SOURCE === "bundled");

    const presets = await api("getPresets");
    assert.equal(presets.length, 28, "the v1 preset list has 28 entries");
    assert.equal(new Set(presets.map((preset) => preset.id)).size, 28);
    for (const preset of presets) {
      assert.match(preset.extension, /^[a-z0-9]+$/, preset.id);
    }

    const settings = await api("getSettings");
    assert.equal(settings.settingsSchemaVersion, 7);
    assert.equal(settings.outputDirectory, OUTPUT);
    assert.equal(settings.setupWizardCompleted, true);
    const platform = await api("getPlatform");
    assert.equal(
      platform,
      { darwin: "darwin", win32: "win32" }[process.platform] ?? "linux",
    );
    assert.equal(await api("getDistributionChannel"), "github");
    record("startup", {
      version: PACKAGE.version,
      presets: presets.length,
      ffmpeg,
    });
  });

  it("runs a mixed batch and reports each file", async () => {
    const out = freshOutput("batch-queue");
    const { final, progress, snapshots } = await runQueue({
      inputs: ["source.mp4", "corrupt.mp4", "video-only.mp4"],
      presetId: "h264-fast",
      outputDirectory: out,
    });
    assert.deepEqual(
      final.items.map((item) => item.status),
      ["done", "failed", "done"],
    );
    assert.equal(final.total, 3);
    assert.equal(final.presetId, "h264-fast");
    const failed = final.items[1];
    assert.ok(failed.error, "a failed item explains itself");
    assert.ok(!failed.outputPath || !fs.existsSync(failed.outputPath));

    for (const index of [0, 2]) {
      const item = final.items[index];
      assert.ok(item.outputPath && fs.existsSync(item.outputPath));
      const media = probe(item.outputPath);
      const video = media.streams.find(
        (stream) => stream.codec_type === "video",
      );
      assert.equal(video?.codec_name, "h264");
    }
    assert.ok(
      probe(final.items[0].outputPath).streams.some(
        (stream) => stream.codec_type === "audio",
      ),
      "audio survives the h264 preset",
    );
    // Only the two good outputs remain: no partial file for the corrupt input.
    assert.deepEqual(listOutputs(out), [
      "source_converted.mp4",
      "video-only_converted.mp4",
    ]);

    assert.ok(progress.length > 0, "progress events arrived");
    for (const event of progress) {
      assert.ok(event.percent >= 0 && event.percent <= 100, `${event.percent}`);
    }
    assert.ok(snapshots.length >= 4, "the queue publishes each transition");
    record("batch-queue", {
      statuses: final.items.map((item) => item.status),
      progressEvents: progress.length,
      snapshots: snapshots.length,
    });
  });

  it("cancels a running conversion and removes the partial file", async () => {
    const out = freshOutput("cancel");
    await helper("resetCollected");
    await helper("startQueueDetached", {
      inputPaths: [FILES["long.mp4"]],
      presetId: "h264-quality",
      gpu: "cpu",
      outputDirectory: out,
    });
    await browser.waitUntil(
      async () => (await helper("collected")).progress.length > 0,
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "no progress before cancel",
      },
    );
    await api("cancelConversion", false);
    const { final } = await waitForQueueEnd(60_000);
    assert.equal(final.items[0].status, "cancelled");
    assert.equal(final.active, false);
    assert.deepEqual(listOutputs(out), [], "the partial output is removed");
    record("cancel-conversion", { itemStatus: final.items[0].status });
  });

  it("converts the source with every preset and verifies each output", async function () {
    this.timeout(900_000);
    const presets = await api("getPresets");
    const rows = [];
    for (const preset of presets) {
      const out = freshOutput(`matrix-${preset.id}`);
      // A WebM remux needs a WebM-compatible source stream.
      const input =
        preset.id === "remux-webm" ? "source-vp9.webm" : "source.mp4";
      const base = input.replace(/\.[^.]+$/, "");
      const { final } = await runQueue(
        { inputs: [input], presetId: preset.id, outputDirectory: out },
        { timeout: 240_000 },
      );
      const item = final.items[0];
      assert.equal(
        item.status,
        "done",
        `${preset.id} ended ${item.status}: ${item.error ?? ""} ${item.errorDetail ?? ""}`,
      );
      const files = listOutputs(out);
      assert.deepEqual(
        files,
        [`${base}_converted.${preset.extension}`],
        preset.id,
      );
      const media = probe(item.outputPath);
      const video = media.streams.filter(
        (stream) => stream.codec_type === "video",
      );
      const audio = media.streams.filter(
        (stream) => stream.codec_type === "audio",
      );
      const expected = CATEGORY_EXPECTATIONS[preset.category];
      assert.ok(expected, `unexpected preset category ${preset.category}`);
      const format = FORMAT_BY_EXTENSION[preset.extension];
      assert.ok(
        media.format.format_name.includes(format),
        `${preset.id}: container ${media.format.format_name} should include ${format}`,
      );
      if (expected.video) {
        assert.equal(
          video.length > 0,
          expected.video.length > 0,
          `${preset.id} video`,
        );
        if (video.length > 0) {
          assert.ok(
            expected.video.includes(video[0].codec_name),
            `${preset.id}: video ${video[0].codec_name} not in ${expected.video}`,
          );
        }
      } else {
        // Remux copies the source stream, so the codec is unchanged.
        assert.ok(video.length > 0, `${preset.id} keeps video`);
        assert.equal(
          video[0].codec_name,
          preset.extension === "webm" ? "vp9" : "h264",
          preset.id,
        );
      }
      const wantedAudio = AUDIO_CODEC_BY_EXTENSION[preset.extension];
      if (wantedAudio) {
        assert.equal(audio[0]?.codec_name, wantedAudio, preset.id);
      } else if (Array.isArray(expected.audio) && expected.audio.length === 0) {
        assert.equal(audio.length, 0, `${preset.id} has no audio`);
      } else if (expected.audio) {
        assert.ok(
          expected.audio.includes(audio[0]?.codec_name),
          `${preset.id}: audio ${audio[0]?.codec_name}`,
        );
      }
      if (!["webp", "gif"].includes(preset.extension)) {
        const duration = Number(media.format.duration);
        assert.ok(
          Math.abs(duration - 2) < 0.6,
          `${preset.id}: duration ${duration} should be about 2 s`,
        );
      }
      rows.push({
        id: preset.id,
        extension: preset.extension,
        container: media.format.format_name,
        video: video[0]?.codec_name ?? null,
        audio: audio[0]?.codec_name ?? null,
        bytes: fs.statSync(item.outputPath).size,
        sha256: sha256File(item.outputPath),
      });
    }
    assert.equal(rows.length, 28);

    // Failure mode: WebM cannot hold H.264, so the remux refuses up front and
    // leaves nothing behind.
    const refused = freshOutput("matrix-remux-webm-h264");
    const { final } = await runQueue({
      inputs: ["source.mp4"],
      presetId: "remux-webm",
      outputDirectory: refused,
    });
    assert.equal(final.items[0].status, "failed");
    assert.match(final.items[0].error, /WebM/);
    assert.deepEqual(listOutputs(refused), []);
    record("preset-matrix", { presets: rows.length, outputs: rows });
  });

  it("names outputs predictably and never overwrites", async () => {
    const out = freshOutput("naming");
    // Non-Latin, Cyrillic and accented names survive intact.
    const unicode = "日本語-Привет-café.mp4";
    const first = await runQueue({
      inputs: [unicode],
      presetId: "remux-mp4",
      outputDirectory: out,
    });
    assert.equal(first.final.items[0].status, "done");
    assert.deepEqual(
      listOutputs(out).map((name) => name.normalize("NFC")),
      [`${unicode.replace(".mp4", "")}_converted.mp4`.normalize("NFC")],
    );
    // A second run claims the next free name instead of overwriting.
    await runQueue({
      inputs: ["source.mp4"],
      presetId: "remux-mp4",
      outputDirectory: out,
    });
    const before = sha256File(path.join(out, "source_converted.mp4"));
    await runQueue({
      inputs: ["source.mp4"],
      presetId: "remux-mp4",
      outputDirectory: out,
    });
    assert.ok(fs.existsSync(path.join(out, "source_converted_1.mp4")));
    assert.equal(sha256File(path.join(out, "source_converted.mp4")), before);

    const spaced = "my clip with spaces.mp4";
    const keep = freshOutput("naming-spaces-kept");
    await runQueue({
      inputs: [spaced],
      presetId: "remux-mp4",
      outputDirectory: keep,
      removeSpacesFromFilenames: false,
    });
    assert.deepEqual(listOutputs(keep), ["my clip with spaces_converted.mp4"]);
    const stripped = freshOutput("naming-spaces-removed");
    await runQueue({
      inputs: [spaced],
      presetId: "remux-mp4",
      outputDirectory: stripped,
      removeSpacesFromFilenames: true,
    });
    assert.deepEqual(listOutputs(stripped), ["myclipwithspaces_converted.mp4"]);

    // A missing request folder falls back to the settings folder, and with no
    // usable settings folder to the input's own folder (v1's order).
    const missing = path.join(OUTPUT, "does-not-exist");
    const viaSettings = await runQueue({
      inputs: ["video-only.mp4"],
      presetId: "remux-mp4",
      outputDirectory: missing,
    });
    assert.equal(viaSettings.final.items[0].status, "done");
    assert.equal(path.dirname(viaSettings.final.items[0].outputPath), OUTPUT);
    await api("saveSettings", { outputDirectory: "" });
    const viaInput = await runQueue({
      inputs: ["video-only.mp4"],
      presetId: "remux-mp4",
      outputDirectory: missing,
    });
    assert.equal(
      path.dirname(viaInput.final.items[0].outputPath),
      path.dirname(FILES["video-only.mp4"]),
    );
    await api("saveSettings", { outputDirectory: OUTPUT });
    assert.ok(!fs.existsSync(missing), "the bad folder is not created");
    assert.ok(fs.existsSync(FILES["source.mp4"]), "the original is kept");
    record("output-naming");
  });

  it("merges, validates, persists and resets settings", async () => {
    const before = await api("getSettings");
    await api("saveSettings", { theme: "light" });
    const light = await api("getSettings");
    assert.equal(light.theme, "light");
    assert.equal(light.outputDirectory, before.outputDirectory);
    assert.equal(readSettingsFile().theme, "light", "the change reaches disk");

    // Unknown keys are ignored, never persisted.
    await api("saveSettings", { bogusKey: 1, theme: "dark" });
    assert.equal("bogusKey" in (await api("getSettings")), false);
    assert.equal("bogusKey" in readSettingsFile(), false);

    // Nested objects merge one level deeper than a plain overwrite.
    const gifBefore = before.advancedFormatSettings.gif;
    await api("saveSettings", {
      advancedFormatSettings: { gif: { loopMode: "once" } },
    });
    const merged = (await api("getSettings")).advancedFormatSettings.gif;
    assert.equal(merged.loopMode, "once");
    assert.deepEqual(merged.tiers, gifBefore.tiers);
    await api("saveSettings", { uiPanels: { gpuExpanded: true } });
    const panels = (await api("getSettings")).uiPanels;
    assert.equal(panels.gpuExpanded, true);
    assert.equal(typeof panels.presetExpanded, "boolean");

    // A bad value is rejected or normalized, never stored as given.
    await api("saveSettings", { theme: "neon" }).catch(() => undefined);
    assert.ok(
      ["system", "dark", "light", "custom"].includes(
        (await api("getSettings")).theme,
      ),
    );
    await api("saveSettings", { showDebugOutput: "yes" }).catch(
      () => undefined,
    );
    assert.equal(typeof (await api("getSettings")).showDebugOutput, "boolean");

    // Reset restores the defaults; the profile baseline is put back after.
    const defaults = await api("getDefaultSettings");
    const reset = await api("resetSettings");
    assert.deepEqual(reset, defaults);
    assert.deepEqual(await api("getSettings"), defaults);

    const settingsPath = path.join(DATA_DIR, "settings.json");
    const settingsBackupPath = path.join(DATA_DIR, "settings.json.e2e-backup");
    const previousChannel = defaults.updateChannel;
    const nextChannel = previousChannel === "beta" ? "stable" : "beta";
    assert.ok(fs.existsSync(settingsPath), "the profile settings file exists");
    assert.ok(
      !fs.existsSync(settingsBackupPath),
      "the settings backup path is unused",
    );
    fs.renameSync(settingsPath, settingsBackupPath);
    try {
      fs.mkdirSync(settingsPath);
      await assert.rejects(api("setUpdateChannel", nextChannel));
      assert.equal(
        (await api("getSettings")).updateChannel,
        previousChannel,
        "a failed channel save leaves the settings cache unchanged",
      );
    } finally {
      fs.rmSync(settingsPath, { recursive: true, force: true });
      fs.renameSync(settingsBackupPath, settingsPath);
    }

    await api("setUpdateChannel", nextChannel);
    assert.equal((await api("getSettings")).updateChannel, nextChannel);
    assert.equal(readSettingsFile().updateChannel, nextChannel);
    await api("setUpdateChannel", previousChannel);
    assert.equal((await api("getSettings")).updateChannel, previousChannel);

    await api("saveSettings", E2E_BASELINE);
    assert.equal((await api("getSettings")).outputDirectory, OUTPUT);
    record("settings-patch");
  });

  it("handles the file picker, selection list and dialogs without surprises", async function () {
    this.timeout(300_000);
    const modes = [];
    const mode = (name) => modes.push(name);
    const names = async () => {
      const found = [];
      for (const element of await $$(
        ".selected-file-item .selected-file-name",
      )) {
        found.push(await element.getText());
      }
      return found;
    };
    const expectNames = async (expected, label) => {
      await browser
        .waitUntil(
          async () =>
            JSON.stringify(
              (await names()).map((name) => name.normalize("NFC")),
            ) === JSON.stringify(expected.map((name) => name.normalize("NFC"))),
          { timeout: 5000, interval: 100 },
        )
        .catch(async () => {
          assert.deepEqual(await names(), expected, label);
        });
    };
    const pick = async (...files) => {
      await helper(
        "stubInputFiles",
        files.map((name) => FILES[name] ?? name),
      );
      await $("#browseFilesBtn").click();
      // The picker resolves asynchronously; give the renderer a turn.
      await browser.pause(300);
    };
    const statusState = async () => ({
      className: await $("#statusMessage").getAttribute("class"),
      text: await $("#statusMessage").getText(),
    });
    await helper("resetCollected");

    // 1. Nothing selected: Convert stays disabled.
    assert.equal(await $("#convertBtn").isEnabled(), false);
    mode("convert-disabled-without-files");
    // 14. The missing-FFmpeg banner stays hidden when FFmpeg works.
    assert.equal(await $("#ffmpegWarning").isDisplayed(), false);
    mode("ffmpeg-warning-hidden");

    // 2. A cancelled dialog changes nothing and raises no error.
    await pick();
    await expectNames([], "empty list");
    assert.doesNotMatch((await statusState()).className ?? "", /error/);
    mode("cancelled-dialog-is-silent");

    // 3. A non-video file is refused with a clear message.
    await pick("notes.txt");
    await expectNames([], "empty list");
    const refused = await statusState();
    assert.match(refused.className, /error/);
    assert.match(refused.text, /Unsupported file type/);
    mode("non-video-refused");

    // 4. A mixed pick keeps only the video.
    await pick("notes.txt", "source.mp4");
    await expectNames(["source.mp4"], "one file");
    mode("mixed-pick-filtered");

    // 5. Picking the same file again does not duplicate it.
    await pick("source.mp4");
    await expectNames(["source.mp4"], "one file");
    mode("duplicates-ignored");

    // 6. Remove drops one entry and keeps the rest in order.
    await pick("video-only.mp4");
    await expectNames(["source.mp4", "video-only.mp4"], "two files");
    const removeButtons = await $$(".selected-file-item button");
    // Each row has Up, Down, Remove; the first row's Remove is the third.
    await removeButtons[2].click();
    await expectNames(["video-only.mp4"], "first file removed");
    mode("remove-one-file");

    // 7. Clear empties the list and disables Convert again.
    await $("#clearSelectedFilesBtn").click();
    await expectNames([], "empty list");
    assert.equal(await $("#convertBtn").isEnabled(), false);
    mode("clear-selection");

    // 8. Non-Latin names render exactly.
    const unicode = "日本語-Привет-café.mp4";
    await pick(unicode);
    await expectNames([unicode], "unicode name");
    await $("#clearSelectedFilesBtn").click();
    mode("unicode-name-listed");

    // 9. A search with no match shows the empty state, and clearing restores.
    if (!(await $("#presetSearch").isDisplayed())) {
      await $("#presetPanelToggle").click();
    }
    await $("#presetSearch").setValue("zzzz-no-such-preset");
    await browser.waitUntil(
      async () => (await $$(".preset-empty-state")).length > 0,
      {
        timeout: 5000,
        timeoutMsg: "no empty state for an unmatched search",
      },
    );
    assert.equal((await $$(".preset-card")).length, 0);
    // Clear the box the way a user does: type, then delete.
    await $("#presetSearch").setValue("x");
    await browser.keys("Backspace");
    await browser.waitUntil(async () => (await $$(".preset-card")).length > 0, {
      timeout: 5000,
      timeoutMsg: "clearing the search did not restore the presets",
    });
    mode("preset-search-empty-state");

    // 10. A corrupt file fails with a friendly status and offers details.
    for (const parent of await $$(".preset-parent-btn")) {
      if ((await parent.$(".preset-parent-label").getText()) === "H.264") {
        await parent.click();
      }
    }
    await $('.preset-card[data-preset-id="h264-fast"]').click();
    const waitIdle = () =>
      browser.waitUntil(
        async () => (await $("#convertBtn").isEnabled()) === true,
        {
          timeout: 60_000,
          timeoutMsg: "Convert never re-enabled",
        },
      );
    await pick("corrupt.mp4");
    await $("#convertBtn").click();
    await browser.waitUntil(
      async () => /error/.test((await statusState()).className ?? ""),
      { timeout: 60_000, timeoutMsg: "no error status for a corrupt file" },
    );
    await waitIdle();
    assert.match((await statusState()).text, /couldn't read this file/);
    assert.equal(await $("#statusDetailsBtn").isDisplayed(), true);
    assert.equal(await $("#cancelBtn").isDisplayed(), false);
    assert.equal(
      fs.existsSync(path.join(OUTPUT, "corrupt_converted.mp4")),
      false,
      "no partial output for the corrupt file",
    );
    mode("corrupt-file-reports-and-recovers");

    // A mixed batch lists every file and offers Retry for the failed one.
    await $("#clearSelectedFilesBtn").click();
    await pick("source.mp4", "corrupt.mp4");
    await $("#convertBtn").click();
    await $("#retryFailedQueueBtn").waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: "no Retry failed button after a failed batch file",
    });
    await waitIdle();
    assert.equal((await $$("#conversionQueueList li")).length, 2);
    assert.ok(fs.existsSync(path.join(OUTPUT, "source_converted.mp4")));
    mode("mixed-batch-offers-retry");

    // 11 and 12. During a long conversion Cancel shows and Convert is locked.
    // Cancel asks first: "No, Continue" keeps going, "Yes, Cancel" stops it.
    await $("#clearSelectedFilesBtn").click();
    await $('.preset-card[data-preset-id="h264-quality"]').click();
    await pick("long.mp4");
    assert.equal(
      await $("#cancelBtn").isDisplayed(),
      false,
      "Cancel hidden when idle",
    );
    await helper("resetCollected");
    await $("#convertBtn").click();
    await browser.waitUntil(
      async () => (await $("#cancelBtn").isDisplayed()) === true,
      {
        timeout: 60_000,
        timeoutMsg: "Cancel never appeared during a conversion",
      },
    );
    mode("cancel-visible-only-while-converting");
    assert.equal(await $("#convertBtn").isEnabled(), false);
    await $("#convertBtn")
      .click()
      .catch(() => undefined);
    await $("#cancelBtn").click();
    await $("#dynamicModal").waitForDisplayed({ timeout: 5000 });
    await $("#modalCancel").click();
    await $("#dynamicModal").waitForDisplayed({ timeout: 5000, reverse: true });
    assert.equal(
      await $("#cancelBtn").isDisplayed(),
      true,
      "No, Continue keeps the conversion running",
    );
    mode("cancel-confirmation-can-be-declined");
    await $("#cancelBtn").click();
    await $("#dynamicModal").waitForDisplayed({ timeout: 5000 });
    await $("#modalConfirm").click();
    await browser.waitUntil(
      async () => (await $("#cancelBtn").isDisplayed()) === false,
      {
        timeout: 60_000,
        timeoutMsg: "Cancel stayed visible after confirming",
      },
    );
    await waitIdle();
    const collected = await helper("collected");
    assert.ok(
      collected.snapshots.some(
        (snapshot) => snapshot.items[0]?.status === "running",
      ),
      "the queue did start",
    );
    assert.equal(
      collected.snapshots.at(-1).items[0].status,
      "cancelled",
      "the confirmed cancel stopped the file",
    );
    assert.equal(
      new Set(collected.snapshots.map((snapshot) => snapshot.items.length))
        .size,
      1,
      "a second click on Convert did not start a second queue",
    );
    assert.deepEqual(
      fs
        .readdirSync(OUTPUT)
        .filter((name) => name.startsWith("long_converted")),
      [],
      "the partial output is removed",
    );
    mode("convert-locked-while-running");
    await $("#clearSelectedFilesBtn").click();
    await helper("restoreDialogs");

    // 13. Settings opens and Escape closes it, returning focus to the button.
    // WebKit does not focus a button on click, so focus it first: the app
    // returns focus to whatever had it when the dialog opened.
    await browser.execute(() => document.getElementById("settingsBtn").focus());
    await $("#settingsBtn").click();
    await $("#settingsModal").waitForDisplayed({ timeout: 5000 });
    await browser.pause(300);
    await browser.keys("Escape");
    await $("#settingsModal").waitForDisplayed({
      timeout: 5000,
      reverse: true,
    });
    const focused = await browser.execute(
      () => document.activeElement?.id ?? "",
    );
    assert.equal(focused, "settingsBtn");
    mode("settings-escape-restores-focus");

    assert.equal(modes.length, 16, `modes: ${modes.join(", ")}`);
    record("ui-failure-modes", { modes });
  });

  it("passes axe checks in every theme", async function () {
    this.timeout(180_000);
    // axe skips disabled controls, so check the state users act in: a file is
    // selected and Convert is enabled.
    await helper("stubInputFiles", [FILES["source.mp4"]]);
    await $("#browseFilesBtn").click();
    await $("#convertBtn").waitForEnabled({ timeout: 10_000 });
    // The file probe fills the details line asynchronously; axe must see it.
    await browser.waitUntil(
      async () => ((await $("#fileDetails").getText()) ?? "").trim().length > 0,
      { timeout: 15_000, timeoutMsg: "the file details line never filled in" },
    );
    await waitForAnimationsToSettle();
    await browser.execute(AXE_SOURCE);
    const themes = ["dark", "light", "midnight-blue", "high-contrast-dark"];
    const reports = [];
    for (const theme of themes) {
      await browser.execute((id) => {
        document.documentElement.setAttribute("data-theme", id);
      }, theme);
      await waitForAnimationsToSettle();
      const encoded = await browser.executeAsync((done) => {
        window.axe
          .run(document, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "best-practice"],
            },
          })
          .then((result) =>
            done(
              JSON.stringify({
                violations: result.violations.map((violation) => ({
                  id: violation.id,
                  impact: violation.impact,
                  nodes: violation.nodes.slice(0, 5).map((node) => ({
                    target: node.target.join(" "),
                    data: node.any[0] ? node.any[0].data : null,
                  })),
                })),
                passes: result.passes.length,
              }).replace(
                /[\u0080-\uffff]/g,
                (char) =>
                  `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
              ),
            ),
          );
      });
      const report = JSON.parse(encoded);
      reports.push({
        theme,
        violations: report.violations,
        passes: report.passes,
      });
    }
    // Findings that predate 2.0 (v1 shipped the same accent colors): white text
    // on the Convert button is below 4.5:1 in two themes. Listed exactly, so a
    // new violation fails the run and so does fixing one without updating this.
    const KNOWN = {
      dark: ["color-contrast:#convertBtn"],
      "midnight-blue": ["color-contrast:#convertBtn"],
    };
    const found = (report) =>
      report.violations
        .flatMap((violation) =>
          violation.nodes.map((node) => `${violation.id}:${node.target}`),
        )
        .sort();
    const failing = reports
      .filter(
        (report) =>
          JSON.stringify(found(report)) !==
          JSON.stringify((KNOWN[report.theme] ?? []).sort()),
      )
      .map((report) => ({ ...report, expected: KNOWN[report.theme] ?? [] }));
    assert.deepEqual(
      failing,
      [],
      `axe violations: ${JSON.stringify(failing, null, 1)}`,
    );
    await $("#clearSelectedFilesBtn").click();
    await helper("restoreDialogs");
    record("accessibility-themes", {
      themes: reports.map(({ theme, passes }) => ({ theme, passes })),
      knownFindings: KNOWN,
    });
  });

  it("captures the main window and settings in every theme", async function () {
    this.timeout(120_000);
    assert.ok(SCREENSHOT_DIR, "CONV2_E2E_SCREENSHOTS is set by the gate");
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const shots = [];
    const capture = async (name) => {
      const file = `${name}.png`;
      const target = path.join(SCREENSHOT_DIR, file);
      await browser.saveScreenshot(target);
      assert.ok(fs.statSync(target).size > 2000, `${file} is not blank`);
      shots.push({ name, file, sha256: sha256File(target) });
    };
    for (const theme of [
      "dark",
      "light",
      "midnight-blue",
      "high-contrast-dark",
    ]) {
      await browser.execute((id) => {
        document.documentElement.setAttribute("data-theme", id);
      }, theme);
      await waitForAnimationsToSettle();
      await capture(`main-${theme}`);
      await $("#settingsBtn").click();
      await $("#settingsModal").waitForDisplayed({ timeout: 5000 });
      await waitForAnimationsToSettle();
      await capture(`settings-${theme}`);
      await browser.keys("Escape");
      await $("#settingsModal").waitForDisplayed({
        timeout: 5000,
        reverse: true,
      });
    }
    record("ui-screenshots", { shots });
  });
});
