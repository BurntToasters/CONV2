// UI E2E: drives the real Electron app through Playwright. Artifacts: coverage/e2e/ui-report.json
// plus screenshots. Failure modes are listed first; each test pins one of them.
//
//  1. First run: tour must appear, Skip must persist, relaunch must not show it again.
//  2. Presets fail to load (IPC trust mismatch, renderer exception).
//  3. File input ignores non-video files / fails to list a chosen video.
//  4. Convert produces nothing, wrong codec, or output with a mangled unicode name.
//  5. Cancel leaves a partial file behind, or "No, Continue" still cancels.
//  6. Quitting mid-conversion kills the job without asking, or "Keep Converting" still quits.
//  7. Confirmed quit leaves the partial output on disk.
//  8. Unreadable input shows raw FFmpeg output instead of an actionable message.
//  9. A batch with one bad file hides which file failed or offers no retry.
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchApp, returningUserSettings } = require('./app.js');
const {
  FFMPEG,
  ffmpegSkipReason,
  createFixtures,
  mkTemp,
  probe,
  writeArtifact,
} = require('./helpers.js');

const skip = ffmpegSkipReason();
const report = { ffmpeg: FFMPEG && { source: FFMPEG.source, version: FFMPEG.version }, cases: [] };
let fixtures;
let fixtureDir;

const record = (name, data) => report.cases.push({ name, at: new Date().toISOString(), ...data });

before(() => {
  if (skip) return;
  fixtureDir = mkTemp('ui-fixtures');
  fixtures = createFixtures(fixtureDir);
});

after(() => {
  writeArtifact('ui-report.json', report);
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const RAW_FFMPEG =
  /Invalid data found|Error opening input|moov atom|Conversion failed: Error|at \w+ \(/;

async function selectPreset(window, presetId) {
  const toggle = window.locator('#presetPanelToggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const card = window.locator(`[data-preset-id="${presetId}"]`);
  if ((await card.count()) === 0) {
    const parents = window.locator('.preset-parent-btn');
    const n = await parents.count();
    for (let i = 0; i < n && (await card.count()) === 0; i += 1) {
      await parents.nth(i).click();
    }
  }
  await card.first().click();
  await window.waitForFunction(
    (id) => document.querySelector(`[data-preset-id="${id}"]`)?.classList.contains('is-selected'),
    presetId
  );
}

async function addFiles(window, files) {
  await window.setInputFiles('#fileInput', files);
  await window.waitForFunction(
    (count) => document.querySelectorAll('#selectedFileList li').length >= count,
    files.length
  );
}

const statusText = (window) => window.locator('#statusMessage .status-text').innerText();

/** Waits until a run has finished and posted its result (not merely "not started yet"). */
async function waitForIdle(window, timeout = 120_000) {
  await window.waitForFunction(
    () =>
      !document.getElementById('convertBtn')?.classList.contains('converting') &&
      document.getElementById('statusMessage')?.classList.contains('visible') &&
      !/Cancelling/.test(document.querySelector('#statusMessage .status-text')?.textContent || ''),
    null,
    { timeout }
  );
}

async function waitForRunning(window) {
  await window.waitForFunction(
    () => document.getElementById('convertBtn')?.classList.contains('converting'),
    null,
    { timeout: 30_000 }
  );
  await window.waitForFunction(
    () => parseFloat(document.getElementById('progressPercent')?.textContent || '0') > 0,
    null,
    { timeout: 30_000 }
  );
}

const listOutputs = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith(base));

test(
  'first run shows the tour; Skip persists across relaunch',
  { skip, timeout: 90_000 },
  async () => {
    const first = await launchApp({ label: 'first-run', keepProfile: true });
    try {
      await first.window
        .locator('#setupWizardModal')
        .waitFor({ state: 'visible', timeout: 15_000 });
      await first.screenshot('01-first-run-tour');
      await first.window.click('#setupWizardSkipBtn');
      await first.window.locator('#setupWizardModal').waitFor({ state: 'hidden' });
      await first.window.waitForTimeout(500);
    } finally {
      await first.close({ keepProfile: true });
    }
    const second = await launchApp({ label: 'relaunch', userDataDir: first.userDataDir });
    try {
      await second.window
        .locator('#presetCardList .preset-card')
        .first()
        .waitFor({ state: 'attached' });
      assert.equal(await second.window.locator('#setupWizardModal').isVisible(), false);
    } finally {
      await second.close();
    }
    record('first-run-tour', { ok: true });
  }
);

test(
  'presets load with no IPC trust errors or renderer exceptions',
  { skip, timeout: 60_000 },
  async () => {
    const ctx = await launchApp({ settings: returningUserSettings(), label: 'presets' });
    try {
      await ctx.window
        .locator('#presetCardList .preset-card')
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 });
      const cards = await ctx.window.locator('#presetCardList .preset-card').count();
      const parents = await ctx.window.locator('.preset-parent-btn').count();
      assert.ok(cards > 0 && parents > 0);
      assert.equal(await ctx.window.locator('#ffmpegWarning').isVisible(), false, 'FFmpeg missing');
      await ctx.screenshot('02-main-window');
      const logs = ctx.logs.join('');
      assert.doesNotMatch(logs, /Untrusted IPC sender|Uncaught exception/);
      assert.deepEqual(ctx.pageErrors, []);
      record('presets-load', { cards, parents });
    } finally {
      await ctx.close();
    }
  }
);

test(
  'GPU probe results are saved, reused on relaunch, and cleared by Refresh',
  {
    skip: skip || (process.platform !== 'darwin' && 'needs a probeable encoder (VideoToolbox)'),
    timeout: 120_000,
  },
  async () => {
    const first = await launchApp({
      settings: returningUserSettings({ gpuMode: 'auto' }),
      label: 'gpu-1',
    });
    const cacheFile = path.join(first.userDataDir, 'gpu-probe-cache.json');
    try {
      await first.window.evaluate(() => window.electronAPI.getGpuCapabilities(null));
      assert.ok(fs.existsSync(cacheFile), 'probe cache not written');
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.equal(saved.results.h264_videotoolbox, true);
    } finally {
      await first.close({ keepProfile: true });
    }
    const second = await launchApp({ label: 'gpu-2', userDataDir: first.userDataDir });
    try {
      await second.app.evaluate(() => {
        globalThis.__probeSpawns = 0;
        const cp = process.mainModule.require('child_process');
        const original = cp.spawn;
        cp.spawn = (cmd, args, ...rest) => {
          if (Array.isArray(args) && args.includes('lavfi') && args.includes('null'))
            globalThis.__probeSpawns += 1;
          return original(cmd, args, ...rest);
        };
      });
      await second.window.evaluate(() => window.electronAPI.getGpuCapabilities(null));
      const reused = await second.app.evaluate(() => globalThis.__probeSpawns);
      await second.window.evaluate(() => window.electronAPI.refreshGpuCapabilities());
      assert.equal(fs.existsSync(cacheFile), false, 'Refresh did not clear the cache file');
      await second.window.evaluate(() => window.electronAPI.getGpuCapabilities(null));
      const reprobed = await second.app.evaluate(() => globalThis.__probeSpawns);
      assert.ok(fs.existsSync(cacheFile), 'cache not rewritten after refresh');
      assert.equal(reused, 0, 'relaunch re-ran hardware probe encodes');
      assert.ok(reprobed > 0, 'Refresh did not re-probe');
      record('gpu-probe-cache', {
        probeSpawnsOnRelaunch: reused,
        probeSpawnsAfterRefresh: reprobed,
      });
    } finally {
      await second.close();
    }
  }
);

test('file input lists videos and ignores other files', { skip, timeout: 60_000 }, async () => {
  const ctx = await launchApp({ settings: returningUserSettings(), label: 'files' });
  const notes = path.join(fixtureDir, 'notes.txt');
  fs.writeFileSync(notes, 'not a video');
  try {
    await ctx.window.setInputFiles('#fileInput', [notes]);
    await ctx.window.waitForTimeout(500);
    assert.equal(await ctx.window.locator('#selectedFileList li').count(), 0);
    await addFiles(ctx.window, [fixtures.standard, fixtures.unicode]);
    const listed = await ctx.window.locator('#selectedFileList').innerText();
    assert.match(listed, /standard\.mp4/);
    assert.match(listed, /ünïcode clip ✓\.mp4/);
    assert.equal(await ctx.window.locator('#convertBtn').isDisabled(), false);
    record('file-input', { ok: true });
  } finally {
    await ctx.close();
  }
});

test(
  'converting through the UI writes a playable file (unicode name)',
  { skip, timeout: 120_000 },
  async () => {
    const outDir = mkTemp('ui-out');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'convert',
    });
    try {
      await addFiles(ctx.window, [fixtures.unicode]);
      await selectPreset(ctx.window, 'h264-fast');
      await ctx.window.click('#convertBtn');
      await waitForIdle(ctx.window);
      await ctx.screenshot('03-conversion-done');
      assert.match(await statusText(ctx.window), /complete|success|converted/i);
      assert.equal(await ctx.window.locator('#showInFolderBtn').isVisible(), true);
      const outputs = listOutputs(outDir, 'ünïcode clip ✓');
      assert.equal(outputs.length, 1, `outputs: ${fs.readdirSync(outDir)}`);
      const info = probe(path.join(outDir, outputs[0]));
      assert.equal(info.videoCodec, 'h264');
      assert.equal(info.videoTag, 'avc1');
      assert.ok(info.duration > 1.5);
      record('ui-convert', { output: outputs[0], probe: info });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

test(
  'cancel: "No, Continue" keeps going; "Yes, Cancel" deletes the partial file',
  { skip, timeout: 180_000 },
  async () => {
    const outDir = mkTemp('ui-cancel');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'cancel',
    });
    try {
      await addFiles(ctx.window, [fixtures.long]);
      await selectPreset(ctx.window, 'h265-best-quality');
      await ctx.window.click('#convertBtn');
      await waitForRunning(ctx.window);

      await ctx.window.click('#cancelBtn');
      await ctx.window.locator('#dynamicModal').waitFor({ state: 'visible' });
      await ctx.screenshot('04-cancel-confirm');
      await ctx.window.click('#modalCancel');
      await ctx.window.waitForTimeout(1500);
      assert.equal(
        await ctx.window
          .locator('#convertBtn')
          .getAttribute('class')
          .then((c) => c.includes('converting')),
        true
      );

      await ctx.window.click('#cancelBtn');
      await ctx.window.locator('#dynamicModal').waitFor({ state: 'visible' });
      await ctx.window.click('#modalConfirm');
      await waitForIdle(ctx.window, 30_000);
      assert.match(await statusText(ctx.window), /cancel/i);
      await ctx.window.waitForTimeout(500);
      assert.deepEqual(listOutputs(outDir, 'long'), [], 'partial output left behind');
      record('ui-cancel', { ok: true });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

test(
  'quit mid-conversion asks; "Keep Converting" keeps the app and the job alive',
  { skip, timeout: 180_000 },
  async () => {
    const outDir = mkTemp('ui-quit-keep');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'quit-keep',
    });
    try {
      await addFiles(ctx.window, [fixtures.long]);
      await selectPreset(ctx.window, 'h265-best-quality');
      await ctx.window.click('#convertBtn');
      await waitForRunning(ctx.window);
      await ctx.stubMessageBox([0]);

      await ctx.app.evaluate(({ app }) => app.quit());
      await ctx.window.waitForTimeout(500);
      const dialogs = await ctx.dialogsShown();
      assert.equal(dialogs.length, 1, 'expected exactly one confirmation');
      assert.match(dialogs[0].title, /Conversion in Progress/);
      assert.equal(ctx.app.process().exitCode, null, 'app exited despite Keep Converting');

      await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await ctx.window.waitForTimeout(500);
      assert.equal((await ctx.dialogsShown()).length, 2, 'window close must ask too');
      assert.equal(ctx.window.isClosed(), false);

      await waitForIdle(ctx.window, 150_000);
      assert.match(await statusText(ctx.window), /complete|success|converted/i);
      assert.equal(listOutputs(outDir, 'long').length, 1);
      record('ui-quit-keep', { dialogs: await ctx.dialogsShown() });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

test(
  'quit mid-conversion + "Quit Anyway" exits and removes the partial file',
  { skip, timeout: 120_000 },
  async () => {
    const outDir = mkTemp('ui-quit-go');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'quit-go',
    });
    try {
      await addFiles(ctx.window, [fixtures.long]);
      await selectPreset(ctx.window, 'h265-best-quality');
      await ctx.window.click('#convertBtn');
      await waitForRunning(ctx.window);
      assert.equal(listOutputs(outDir, 'long').length, 1, 'expected an in-progress output');
      await ctx.stubMessageBox([1]);
      await ctx.app.evaluate(({ app }) => app.quit()).catch(() => {});
      const code = await Promise.race([
        ctx.exited,
        new Promise((r) => setTimeout(() => r('timeout'), 20_000)),
      ]);
      assert.notEqual(code, 'timeout', 'app did not exit after Quit Anyway');
      assert.deepEqual(listOutputs(outDir, 'long'), [], 'partial output left behind');
      record('ui-quit-go', { exitCode: code });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

test(
  'unreadable input shows an actionable message, not raw FFmpeg output',
  { skip, timeout: 60_000 },
  async () => {
    const outDir = mkTemp('ui-corrupt');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'corrupt',
    });
    try {
      await addFiles(ctx.window, [fixtures.corrupt]);
      await selectPreset(ctx.window, 'h264-fast');
      await ctx.window.click('#convertBtn');
      await waitForIdle(ctx.window);
      await ctx.screenshot('05-corrupt-input');
      const text = await statusText(ctx.window);
      assert.match(text, /couldn.t read|damaged|not a (?:supported )?video/i, text);
      assert.doesNotMatch(text, RAW_FFMPEG, text);
      assert.deepEqual(listOutputs(outDir, 'corrupt'), []);
      record('ui-corrupt', { status: text });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

test(
  'batch with one bad file names it, keeps the rest, offers retry',
  { skip, timeout: 120_000 },
  async () => {
    const outDir = mkTemp('ui-batch');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'batch',
    });
    try {
      await addFiles(ctx.window, [fixtures.standard, fixtures.audioOnly, fixtures.rotated]);
      await selectPreset(ctx.window, 'h264-fast');
      await ctx.window.click('#convertBtn');
      await waitForIdle(ctx.window);
      await ctx.window
        .locator('.conversion-queue-item.is-failed')
        .first()
        .waitFor({ state: 'attached', timeout: 30_000 });
      await ctx.screenshot('06-batch-partial-failure');
      const failedRow = ctx.window.locator('.conversion-queue-item.is-failed');
      assert.equal(await failedRow.count(), 1);
      assert.match(await failedRow.innerText(), /audio-only\.mp4/);
      assert.equal(await failedRow.isVisible(), true, 'batch results hidden after the run ends');
      assert.equal(await ctx.window.locator('#retryFailedQueueBtn').isVisible(), true);
      const label = await failedRow.locator('.conversion-queue-status').innerText();
      assert.match(label, /no video/i, label);
      assert.doesNotMatch(label, RAW_FFMPEG, label);
      assert.equal(await failedRow.locator('.conversion-queue-retry-one').count(), 1);
      assert.equal(await ctx.window.locator('.conversion-queue-item.is-done').count(), 2);
      assert.equal(fs.readdirSync(outDir).filter((f) => f.endsWith('.mp4')).length, 2);
      record('ui-batch', { failedLabel: label });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

// Failure modes for the error Details view (written before the view existed):
//  - raw FFmpeg output never reachable, or dumped inline in the status line
//  - Details offered on success or when there is nothing to show
//  - modal traps focus badly / Escape does not close / focus is lost afterwards
//  - batch rows do not expose per-file detail
test(
  'failed conversion offers Details with the raw FFmpeg output',
  { skip, timeout: 90_000 },
  async () => {
    const outDir = mkTemp('ui-details');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'details',
    });
    try {
      await addFiles(ctx.window, [fixtures.standard]);
      await selectPreset(ctx.window, 'h264-fast');
      await ctx.window.click('#convertBtn');
      await waitForIdle(ctx.window);
      assert.equal(
        await ctx.window.locator('#statusDetailsBtn').isVisible(),
        false,
        'Details on success'
      );

      await ctx.window.click('#clearSelectedFilesBtn');
      await addFiles(ctx.window, [fixtures.corrupt]);
      await ctx.window.click('#convertBtn');
      await waitForIdle(ctx.window);
      const status = await statusText(ctx.window);
      assert.doesNotMatch(status, RAW_FFMPEG, status);
      const detailsBtn = ctx.window.locator('#statusDetailsBtn');
      assert.equal(await detailsBtn.isVisible(), true, 'no Details button on failure');
      await detailsBtn.click();
      const modal = ctx.window.locator('#errorDetailsModal');
      await modal.waitFor({ state: 'visible' });
      await ctx.screenshot('07-error-details');
      const detail = await ctx.window.locator('#errorDetailsContent').innerText();
      assert.match(detail, /Invalid data found|moov atom/);
      assert.doesNotMatch(detail, /ffmpeg version|configuration:/);
      assert.equal(
        await ctx.window.locator('#errorDetailsModal [role="dialog"]').getAttribute('aria-modal'),
        'true'
      );
      await ctx.window.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden' });
      assert.equal(await ctx.window.evaluate(() => document.activeElement?.id), 'statusDetailsBtn');
      record('ui-error-details', { status, detailLines: detail.split('\n').length });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

test(
  'batch rows expose per-file Details only when there is detail',
  { skip, timeout: 90_000 },
  async () => {
    const outDir = mkTemp('ui-row-details');
    const ctx = await launchApp({
      settings: returningUserSettings({ outputDirectory: outDir }),
      label: 'row-details',
    });
    try {
      await addFiles(ctx.window, [fixtures.standard, fixtures.corrupt, fixtures.audioOnly]);
      await selectPreset(ctx.window, 'h264-fast');
      await ctx.window.click('#convertBtn');
      await waitForIdle(ctx.window);
      const corruptRow = ctx.window.locator('.conversion-queue-item.is-failed', {
        hasText: 'corrupt.mp4',
      });
      const audioRow = ctx.window.locator('.conversion-queue-item.is-failed', {
        hasText: 'audio-only.mp4',
      });
      await corruptRow.waitFor({ state: 'attached' });
      assert.equal(await corruptRow.locator('.conversion-queue-details').count(), 1);
      assert.equal(
        await audioRow.locator('.conversion-queue-details').count(),
        0,
        'preflight has no raw detail'
      );
      assert.equal(
        await ctx.window
          .locator('.conversion-queue-item.is-done .conversion-queue-details')
          .count(),
        0
      );
      await corruptRow.locator('.conversion-queue-details').click();
      await ctx.window.locator('#errorDetailsModal').waitFor({ state: 'visible' });
      assert.match(await ctx.window.locator('#errorDetailsTitle').innerText(), /corrupt\.mp4/);
      assert.match(
        await ctx.window.locator('#errorDetailsContent').innerText(),
        /Invalid data found|moov atom/
      );
      await ctx.window.click('#closeErrorDetails');
      await ctx.window.locator('#errorDetailsModal').waitFor({ state: 'hidden' });
      record('ui-row-details', { ok: true });
    } finally {
      await ctx.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);
