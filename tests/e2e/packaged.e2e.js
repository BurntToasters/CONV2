// Packaged-app FFmpeg check: launches a built CONV2 with no FFmpeg env overrides, so the bundled
// binary is verified as shipped. Artifacts: coverage/e2e/packaged-ffmpeg.json and a screenshot.
// Run with CONV2_E2E_PACKAGED_APP=<executable>, e.g. dist/mac-universal/CONV2.app/Contents/MacOS/CONV2.
// Failure modes:
//  1. Universal lipo/codesign breaks bundled-binary verification and "FFmpeg Not Found" shows.
//  2. Packaging drops the bundled FFmpeg, so the check has nothing to verify.
//  3. The renderer never finishes its startup FFmpeg check (appReady never set).
//  4. The env var is missing and the test passes without running anything (must skip instead).
//  5. --user-data-dir is ignored, so the run writes into the real user profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launchPackagedApp } = require('./app.js');
const { writeArtifact } = require('./helpers.js');

const isMac = process.platform === 'darwin';
const EXE = process.platform === 'win32' ? '.exe' : '';
const packagedApp = process.env.CONV2_E2E_PACKAGED_APP;

function packagedSkipReason() {
  if (!packagedApp) return 'set CONV2_E2E_PACKAGED_APP to a packaged CONV2 executable';
  try {
    if (fs.statSync(packagedApp).isFile()) {
      fs.accessSync(packagedApp, fs.constants.X_OK);
      return false;
    }
  } catch {
    // fall through to the reason below
  }
  return `CONV2_E2E_PACKAGED_APP is not an existing executable: ${packagedApp}`;
}

/** mac: <App>.app/Contents/MacOS/CONV2 -> Contents/Resources; others: resources/ next to the exe. */
function bundledFfmpegPath(executable) {
  const dir = path.dirname(executable);
  if (isMac) return path.resolve(dir, '..', 'Resources', 'ffmpeg', 'ffmpeg');
  return path.resolve(dir, 'resources', 'ffmpeg', `ffmpeg${EXE}`);
}

/** stdout and stderr together; codesign reports its details on stderr, even on success. */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

/** The profile a packaged build uses when no override is honoured. */
function defaultUserDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CONV2');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CONV2');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'CONV2');
}

/** Sorted "relative:size:mtime" lines for every file under dir; empty when dir is absent. */
function fingerprint(dir, limit = 5000) {
  const lines = [];
  const walk = (current) => {
    if (lines.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        lines.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        // file vanished between readdir and stat
      }
    }
  };
  walk(dir);
  return lines.sort();
}

test(
  'packaged app passes the bundled FFmpeg check with no env overrides',
  { skip: packagedSkipReason(), timeout: 150_000 },
  async () => {
    const executablePath = path.resolve(packagedApp);
    const bundledFfmpeg = bundledFfmpegPath(executablePath);
    const codesign = isMac ? capture('/usr/bin/codesign', ['-dv', bundledFfmpeg]) : undefined;
    const realProfile = defaultUserDataDir();
    const realProfileBefore = fingerprint(realProfile);
    const report = {
      executable: executablePath,
      bundledFfmpeg,
      bundledFfmpegExists: fs.existsSync(bundledFfmpeg),
      file: isMac ? capture('/usr/bin/file', [bundledFfmpeg]) : undefined,
      codesign,
      teamIdentifier: codesign?.match(/TeamIdentifier=(\S+)/)?.[1] ?? null,
      userDataDir: null,
      userDataDirPopulated: false,
      devToolsPortMatches: false,
      realProfileDir: realProfile,
      realProfileUntouched: null,
      isolationVerified: false,
      warningVisible: null,
      pass: false,
    };

    let ctx;
    try {
      ctx = await launchPackagedApp({ executablePath, label: 'packaged' });
      report.userDataDir = ctx.userDataDir;
      // Chromium writes DevToolsActivePort into the profile; its port must be the one we passed.
      const devToolsFile = path.join(ctx.userDataDir, 'DevToolsActivePort');
      const devToolsPort = fs.existsSync(devToolsFile)
        ? Number(fs.readFileSync(devToolsFile, 'utf8').split('\n')[0])
        : null;
      report.userDataDirPopulated = fs.readdirSync(ctx.userDataDir).length > 0;
      report.devToolsPortMatches = devToolsPort === ctx.port;
      report.realProfileUntouched =
        JSON.stringify(fingerprint(realProfile)) === JSON.stringify(realProfileBefore);
      report.isolationVerified =
        report.userDataDirPopulated && report.devToolsPortMatches && report.realProfileUntouched;
      assert.equal(
        report.userDataDirPopulated && report.devToolsPortMatches,
        true,
        '--user-data-dir was not honoured: no DevToolsActivePort for this run in the temp profile'
      );
      assert.equal(
        report.realProfileUntouched,
        true,
        `packaged run wrote into the real profile: ${realProfile}`
      );
      // The appReady wait inside launchPackagedApp covers the renderer's FFmpeg check.
      report.warningVisible = await ctx.window.locator('#ffmpegWarning').isVisible();
      await ctx.screenshot('packaged-main-window');
      assert.equal(report.warningVisible, false, 'packaged app shows "FFmpeg Not Found"');
      report.pass = true;
    } finally {
      if (ctx) await ctx.close();
      writeArtifact('packaged-ffmpeg.json', report);
    }
  }
);
