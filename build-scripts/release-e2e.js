'use strict';

// Release E2E gate, run by release:prepare on the release VMs.
// No usable display: warn, record the skip in coverage/e2e, and let the release go on.
// The app launched but a test failed: block the release.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RECORD_PATH = path.join(ROOT, 'coverage', 'e2e', 'release-e2e.json');
const PROBE_TIMEOUT_MS = 60_000;

/** Linux without a display needs xvfb-run; everything else runs as is. */
function displayPlan({ platform, env, hasXvfb }) {
  if (platform !== 'linux' || env.DISPLAY || env.WAYLAND_DISPLAY) return { prefix: [] };
  if (hasXvfb()) return { prefix: ['xvfb-run', '-a'] };
  return { skip: 'no display and xvfb-run is not installed (install the xvfb package)' };
}

function wrap(prefix, command, args) {
  return prefix.length === 0
    ? { command, args }
    : { command: prefix[0], args: [...prefix.slice(1), command, ...args] };
}

function releaseE2E({
  platform = process.platform,
  env = process.env,
  hasXvfb = commandExists('xvfb-run'),
  run = runStep,
  record = writeRecord,
  warn = (message) => console.warn(message),
} = {}) {
  const skip = (reason) => {
    warn(`\n[!!WARNING!!] E2E SKIPPED: ${reason}. This release was not E2E tested.\n`);
    record({ status: 'skipped', reason, platform });
    return 0;
  };

  const plan = displayPlan({ platform, env, hasXvfb });
  if (plan.skip) return skip(plan.skip);

  const build = run({ command: 'npm', args: ['run', 'build'], env: {} });
  if (build !== 0) {
    record({ status: 'failed', reason: `build exited ${build}`, platform });
    return build;
  }

  const electron = require('electron');
  const sandbox = env.CI ? ['--no-sandbox'] : [];
  const probe = run({
    ...wrap(plan.prefix, electron, [path.join(__dirname, 'display-probe.js'), ...sandbox]),
    env: { ELECTRON_RUN_AS_NODE: undefined },
    timeout: PROBE_TIMEOUT_MS,
  });
  if (probe !== 0) return skip(`Electron could not open a hidden window (exit ${probe})`);

  const suite = run({
    ...wrap(plan.prefix, process.execPath, ['build-scripts/run-e2e.js', '--skip-build']),
    env: { CONV2_REQUIRE_FFMPEG_TESTS: '1' },
  });
  if (suite !== 0) {
    record({ status: 'failed', reason: `E2E suite exited ${suite}`, platform });
    return suite;
  }
  record({ status: 'passed', platform });
  return 0;
}

function commandExists(name) {
  return () =>
    process.platform !== 'win32' &&
    spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

function runStep(step) {
  const isNpm = step.command === 'npm';
  const env = { ...process.env, ...step.env };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const result = spawnSync(
    isNpm && process.platform === 'win32' ? 'npm.cmd' : step.command,
    step.args,
    {
      cwd: ROOT,
      stdio: 'inherit',
      env,
      timeout: step.timeout,
      // Windows refuses to spawn npm.cmd without a shell (CVE-2024-27980 fix).
      shell: isNpm && process.platform === 'win32',
    }
  );
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

function writeRecord(entry) {
  fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
  const body = { ...entry, at: new Date().toISOString() };
  fs.writeFileSync(RECORD_PATH, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`[release-e2e] ${entry.status} → ${path.relative(ROOT, RECORD_PATH)}`);
}

if (require.main === module) {
  try {
    process.exitCode = releaseE2E();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { displayPlan, releaseE2E };
