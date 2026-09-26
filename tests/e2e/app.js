// Launches the real Electron app with an isolated profile for UI E2E.
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { ROOT, FFMPEG, ARTIFACT_DIR, mkTemp } = require('./helpers.js');

const electronBinary = require('electron');

/**
 * @param {{ settings?: object, label?: string }} [options] settings are written as the
 *   profile's settings.json before launch; omit to exercise a true first run.
 */
async function launchApp({ settings, label = 'app', userDataDir: reuseDir } = {}) {
  const userDataDir = reuseDir || mkTemp(`profile-${label}`);
  if (settings) {
    fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(settings));
  }
  const env = { ...process.env, CONV2_USER_DATA_DIR: userDataDir, CONV2_DISABLE_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  if (FFMPEG) {
    env.CONV2_FFMPEG_PATH = FFMPEG.ffmpeg;
    env.CONV2_FFPROBE_PATH = FFMPEG.ffprobe;
  }

  const app = await electron.launch({
    executablePath: electronBinary,
    args: [ROOT],
    cwd: ROOT,
    env,
    timeout: 60_000,
  });
  const logs = [];
  app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
  const window = await app.firstWindow();
  const pageErrors = [];
  window.on('pageerror', (error) => pageErrors.push(String(error)));
  window.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
  });
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => document.documentElement.dataset.appReady === 'true', null, {
    timeout: 30_000,
  });

  const exited = new Promise((resolve) => app.process().once('exit', (code) => resolve(code)));

  return {
    app,
    window,
    userDataDir,
    logs,
    pageErrors,
    exited,
    /** Saves a screenshot artifact under coverage/e2e/screenshots. */
    async screenshot(name) {
      const dir = path.join(ARTIFACT_DIR, 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.png`);
      await window.screenshot({ path: file });
      return file;
    },
    /** Replaces dialog.showMessageBox in main; answers are button indexes, consumed in order. */
    async stubMessageBox(answers) {
      await app.evaluate(({ dialog }, queued) => {
        globalThis.__conv2Dialogs = [];
        const remaining = [...queued];
        dialog.showMessageBox = async (...args) => {
          const options = args.find((a) => a && typeof a === 'object' && 'buttons' in a) || {};
          globalThis.__conv2Dialogs.push({ title: options.title, message: options.message });
          return { response: remaining.length > 0 ? remaining.shift() : 0, checkboxChecked: false };
        };
      }, answers);
    },
    async dialogsShown() {
      return app.evaluate(() => globalThis.__conv2Dialogs || []);
    },
    async close({ keepProfile = false } = {}) {
      try {
        await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
      } catch {
        // already gone
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (!keepProfile) fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Settings for a returning user so tests skip the first-run tour. */
const returningUserSettings = (overrides = {}) => ({
  setupWizardCompleted: true,
  gpuMode: 'manual',
  gpuManualVendor: 'cpu',
  gpu: 'cpu',
  autoCheckUpdates: false,
  notifyOnConversionComplete: false,
  preventSleepWhileConverting: false,
  ...overrides,
});

module.exports = { launchApp, returningUserSettings };
