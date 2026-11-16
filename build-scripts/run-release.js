'use strict';

// Runs one release target: shared prepare steps, then release:<target>:continue.
// Usage: npm run release:<target> [-- --skip-check]
// --skip-check is a beta recovery override (same contract as Zinnia): it sets
// FORCE_UPLOAD=1 on the continue step, which bypasses the draft target-commit check.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  assertStableReleaseOverridesAllowed,
  isStableReleaseVersion,
  readPackageVersion,
} = require('./release-policy');

const ROOT = path.join(__dirname, '..');
const KNOWN_FLAGS = new Set(['--skip-check']);

// Target -> ensure-release-ffmpeg.js arguments.
const RELEASE_TARGETS = Object.freeze({
  win: ['--target', 'win:x64', '--target', 'win:arm64'],
  'win:x64': ['--target', 'win:x64'],
  'win:arm64': ['--target', 'win:arm64'],
  msstore: ['--target', 'win:x64', '--target', 'win:arm64'],
  mac: ['--target', 'mac:x64', '--target', 'mac:arm64'],
  linux: ['--target', 'linux:x64', '--target', 'linux:arm64'],
  all: ['--all'],
});

function usage() {
  return `Usage: node build-scripts/run-release.js <${Object.keys(RELEASE_TARGETS).join('|')}> [--skip-check]`;
}

function parseReleaseArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith('-'));
  const unknown = flags.filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknown.length > 0) throw new Error(`Unknown release flag: ${unknown.join(', ')}`);
  const targets = argv.filter((arg) => !arg.startsWith('-'));
  if (targets.length !== 1 || !Object.hasOwn(RELEASE_TARGETS, targets[0])) {
    throw new Error(usage());
  }
  const target = targets[0];
  return {
    target,
    ffmpegArgs: RELEASE_TARGETS[target],
    continueScript: `release:${target}:continue`,
    skipCheck: flags.includes('--skip-check'),
  };
}

function assertSkipCheckAllowed(skipCheck, { version } = {}) {
  if (!skipCheck) return false;
  const releaseVersion = version ?? readPackageVersion();
  if (isStableReleaseVersion(releaseVersion)) {
    throw new Error(
      `--skip-check is not allowed for stable release ${releaseVersion}; stable releases always check the draft target.`
    );
  }
  console.warn(
    `WARNING: --skip-check on beta ${releaseVersion}; this run sets FORCE_UPLOAD=1 and bypasses the draft target check.`
  );
  return true;
}

function releaseSteps({ ffmpegArgs, continueScript, skipCheck }) {
  // Prepare runs the test suite; an inherited FORCE_UPLOAD must not reach it.
  const prepareEnv = { FORCE_UPLOAD: undefined };
  return [
    { command: 'npm', args: ['run', 'prerelease:prepare'], env: prepareEnv },
    {
      command: 'node',
      args: ['build-scripts/ensure-release-ffmpeg.js', ...ffmpegArgs],
      env: prepareEnv,
    },
    { command: 'npm', args: ['run', 'release:prepare'], env: prepareEnv },
    {
      command: 'npm',
      args: ['run', continueScript],
      env: skipCheck ? { FORCE_UPLOAD: '1' } : {},
    },
  ];
}

/** Base env plus overrides; an undefined override removes the variable. */
function childEnv(base, overrides) {
  const env = { ...base, ...overrides };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

function runStep(step) {
  const isNpm = step.command === 'npm';
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(isNpm ? npmCommand : process.execPath, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: childEnv(process.env, step.env),
    // Windows refuses to spawn npm.cmd without a shell (CVE-2024-27980 fix).
    shell: isNpm && process.platform === 'win32',
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

function main(argv = process.argv.slice(2), { run = runStep, env = process.env, version } = {}) {
  const parsed = parseReleaseArgs(argv);
  const releaseVersion = version ?? readPackageVersion();
  // The draft step refuses these too; failing here skips a full prepare run first.
  assertStableReleaseOverridesAllowed(env, releaseVersion);
  assertSkipCheckAllowed(parsed.skipCheck, { version: releaseVersion });
  for (const step of releaseSteps(parsed)) {
    const status = run(step);
    if (status !== 0) return status;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  RELEASE_TARGETS,
  assertSkipCheckAllowed,
  childEnv,
  main,
  parseReleaseArgs,
  releaseSteps,
};
