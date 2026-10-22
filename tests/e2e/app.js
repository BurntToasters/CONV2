// Launches the real Electron app with an isolated profile for UI E2E.
// launchApp sets CONV2_E2E_BACKGROUND=1 so windows stay hidden and never take focus; CONV2_E2E_FOREGROUND=1 opts out.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron, chromium } = require('playwright-core');
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
  env.CONV2_E2E_BACKGROUND = process.env.CONV2_E2E_FOREGROUND === '1' ? '0' : '1';
  if (FFMPEG) {
    env.CONV2_FFMPEG_PATH = FFMPEG.ffmpeg;
    env.CONV2_FFPROBE_PATH = FFMPEG.ffprobe;
  }

  const app = await electron.launch({
    executablePath: electronBinary,
    args: process.env.CI ? [ROOT, '--no-sandbox'] : [ROOT],
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
  // Evidence for the no-on-screen-window guarantee: one line per launch in the e2e artifacts.
  const visibleWindows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => win.isVisible())
  );
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.appendFileSync(
    path.join(ARTIFACT_DIR, 'window-visibility.log'),
    `${label} background=${env.CONV2_E2E_BACKGROUND} visible=${JSON.stringify(visibleWindows)}\n`
  );

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
      if (!keepProfile) {
        // Windows can return EPERM while the exited app still holds the profile.
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/**
 * Launches a packaged CONV2 executable. Release builds disable the Node inspect fuse, so
 * Playwright's _electron.launch cannot attach. This spawns the app with a remote-debugging
 * port and connects over CDP. No FFmpeg env overrides are set, so the bundled check runs.
 * Packaged builds ignore CONV2_USER_DATA_DIR, so Chromium's --user-data-dir isolates the profile.
 * @param {{ executablePath: string, label?: string }} options
 */
async function launchPackagedApp({ executablePath, label = 'packaged' }) {
  const userDataDir = mkTemp(`profile-${label}`);
  const port = await freePort();
  const env = { ...process.env, CONV2_USER_DATA_DIR: userDataDir, CONV2_DISABLE_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CONV2_FFMPEG_PATH;
  delete env.CONV2_FFPROBE_PATH;
  const sandboxArgs = process.env.CI ? ['--no-sandbox'] : [];
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    ...sandboxArgs,
  ];
  const child = spawn(executablePath, args, {
    cwd: path.dirname(executablePath),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const exited = new Promise((resolve) => child.once('exit', resolve));

  let browser;
  const deadline = Date.now() + 30_000;
  try {
    while (!browser) {
      if (child.exitCode !== null) {
        throw new Error(
          `packaged app exited with ${child.exitCode}: ${logs.join('').slice(-2000)}`
        );
      }
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 });
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(250);
      }
    }
    const context = browser.contexts()[0];
    const isAppPage = (page) => !page.url().startsWith('devtools://');
    const window =
      context.pages().find(isAppPage) ||
      (await context.waitForEvent('page', { predicate: isAppPage, timeout: 30_000 }));
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => document.documentElement.dataset.appReady === 'true', null, {
      timeout: 30_000,
    });

    return {
      window,
      userDataDir,
      port,
      logs,
      /** Saves a screenshot artifact under coverage/e2e/screenshots. */
      async screenshot(name) {
        const dir = path.join(ARTIFACT_DIR, 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${name}.png`);
        await window.screenshot({ path: file });
        return file;
      },
      async close() {
        await Promise.race([browser.close().catch(() => {}), sleep(5_000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
          await exited;
          clearTimeout(killTimer);
        }
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      },
    };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw error;
  }
}

module.exports = { launchApp, launchPackagedApp, returningUserSettings };
