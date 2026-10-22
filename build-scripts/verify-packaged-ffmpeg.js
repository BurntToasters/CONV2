// Verifies the FFmpeg/ffprobe payload inside unpacked CONV2 apps (macOS .app, win/linux *-unpacked).
// Usage: node build-scripts/verify-packaged-ffmpeg.js [release-dir=release] [--require]
// Writes coverage/e2e/packaged-ffmpeg-verify.json. Exit 0 when verified or skipped.
// Failure modes:
//  1. A shipped binary fails the bundled checksum or codesign check (swapped or re-signed).
//  2. An app is built without one of its ffmpeg/ffprobe binaries.
//  3. No app or no payload is found: skip (exit 0), or fail with --require or REQUIRE_FFMPEG_PAYLOAD=1.
//  4. The host-matching binary fails `-version`; only verified binaries are ever executed.
//  5. dist/main/ffmpegIntegrity.js is not compiled, so nothing can be verified.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MAX_SEARCH_DEPTH = 3;
const BINARY_NAMES = ['ffmpeg', 'ffprobe'];
const args = process.argv.slice(2);
const requireMode = args.includes('--require') || process.env.REQUIRE_FFMPEG_PAYLOAD === '1';
const releaseDir = path.resolve(ROOT, args.find((arg) => !arg.startsWith('--')) || 'release');
const outFile = path.join(ROOT, 'coverage', 'e2e', 'packaged-ffmpeg-verify.json');

const relative = (target) => {
  const rel = path.relative(ROOT, target);
  return rel === '' ? '.' : rel.startsWith('..') ? target : rel;
};
const archFromName = (name) => (name.includes('arm64') ? 'arm64' : 'x64');

/** Unpacked apps: *.app bundles and *-unpacked dirs. *-temp dirs from universal builds are skipped. */
function findUnpackedApps(dir, depth = 0, found = []) {
  if (!fs.existsSync(dir) || depth > MAX_SEARCH_DEPTH) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('-temp')) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith('.app') || entry.name.endsWith('-unpacked')) {
      found.push(full);
    } else {
      findUnpackedApps(full, depth + 1, found);
    }
  }
  return found;
}

/** Platform, package arch, app executable, and bundled binary paths for one unpacked app. */
function describeApp(appDir) {
  const name = path.basename(appDir);
  const parent = path.basename(path.dirname(appDir));
  if (name.endsWith('.app')) {
    // Universal bundles run on the host arch; the codesign team check decides on macOS.
    const arch = parent.includes('universal') ? process.arch : archFromName(parent);
    const resources = path.join(appDir, 'Contents', 'Resources', 'ffmpeg');
    return {
      appDir,
      platform: 'darwin',
      arch,
      executable: path.join(appDir, 'Contents', 'MacOS', path.basename(name, '.app')),
      binaries: BINARY_NAMES.map((binary) => ({
        name: binary,
        path: path.join(resources, binary),
      })),
    };
  }
  const resources = path.join(appDir, 'resources', 'ffmpeg');
  if (fs.existsSync(path.join(appDir, 'CONV2.exe'))) {
    return {
      appDir,
      platform: 'win32',
      arch: archFromName(name),
      executable: path.join(appDir, 'CONV2.exe'),
      binaries: BINARY_NAMES.map((binary) => ({
        name: binary,
        path: path.join(resources, `${binary}.exe`),
      })),
    };
  }
  const executable = fs.readdirSync(appDir).find((file) => /^conv2$/i.test(file)) ?? 'CONV2';
  return {
    appDir,
    platform: 'linux',
    arch: archFromName(name),
    executable: path.join(appDir, executable),
    binaries: BINARY_NAMES.map((binary) => ({ name: binary, path: path.join(resources, binary) })),
  };
}

async function main() {
  const report = {
    at: new Date().toISOString(),
    releaseDir: relative(releaseDir),
    requireMode,
    apps: [],
    binaries: [],
    verified: 0,
    ran: 0,
    errors: [],
    skipped: null,
    ok: false,
  };
  const finish = (code) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`Report: ${relative(outFile)}`);
    return code;
  };
  const noPayload = (reason) => {
    if (requireMode) {
      report.errors.push(reason);
      console.error(reason);
      return finish(1);
    }
    report.skipped = reason;
    console.log(`SKIP ${reason}`);
    return finish(0);
  };

  const apps = findUnpackedApps(releaseDir).map(describeApp);
  report.apps = apps.map((app) => ({
    path: relative(app.appDir),
    platform: app.platform,
    arch: app.arch,
  }));
  if (apps.length === 0) return noPayload(`no unpacked CONV2 app under ${relative(releaseDir)}`);

  const present = apps.flatMap((app) => app.binaries.filter((b) => fs.existsSync(b.path)));
  if (present.length === 0) {
    return noPayload(`no bundled ffmpeg or ffprobe in ${apps.length} app(s)`);
  }

  // Only compiled main-process code can verify; fail rather than silently skip.
  const integrityPath = path.join(ROOT, 'dist', 'main', 'ffmpegIntegrity.js');
  if (!fs.existsSync(integrityPath)) {
    report.errors.push(`${relative(integrityPath)} is missing; run npm run compile first`);
    return finish(1);
  }
  const { verifyBundledBinaryChecksum } = require(integrityPath);

  for (const app of apps) {
    for (const binary of app.binaries) {
      const rel = relative(binary.path);
      if (!fs.existsSync(binary.path)) {
        report.errors.push(`missing ${binary.name} in ${relative(app.appDir)}: ${rel}`);
        continue;
      }
      const entry = { app: relative(app.appDir), name: binary.name, path: rel };
      report.binaries.push(entry);
      try {
        entry.verified = await verifyBundledBinaryChecksum(
          binary.path,
          binary.name,
          app.platform,
          app.arch,
          app.executable
        );
      } catch (error) {
        entry.verified = false;
        entry.error = String(error.message || error);
      }
      if (!entry.verified) {
        report.errors.push(`${binary.name} failed bundled verification: ${rel}`);
        continue;
      }
      report.verified += 1;
      if (app.platform === process.platform && app.arch === process.arch) {
        try {
          execFileSync(binary.path, ['-version'], { stdio: 'ignore', timeout: 30_000 });
          entry.ran = true;
          report.ran += 1;
        } catch (error) {
          report.errors.push(`${rel} -version failed: ${error.message}`);
        }
      }
    }
  }

  report.ok = report.errors.length === 0 && report.verified > 0;
  for (const error of report.errors) console.error(error);
  for (const binary of report.binaries) {
    console.log(`${binary.verified ? 'OK' : 'FAIL'} ${binary.path}${binary.ran ? ' (ran)' : ''}`);
  }
  return finish(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { findUnpackedApps, describeApp };
