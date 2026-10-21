'use strict';

/**
 * run-coverage.js
 *
 * Runs the Node test suite with coverage enabled, writes an LCOV report to
 * coverage/lcov.info, then enforces the per-module floors in
 * build-scripts/check-coverage-thresholds.js.
 *
 * Kept as a script (rather than a long npm command) so the output directory is
 * created cross-platform and the threshold check always runs afterwards.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const coverageDir = path.join(projectRoot, 'coverage');
const lcovPath = path.join(coverageDir, 'lcov.info');

fs.mkdirSync(coverageDir, { recursive: true });

// Enumerate test files directly: this runs without a shell, so a glob pattern
// would be passed through literally.
const testsDir = path.join(projectRoot, 'tests');
const testFiles = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('tests', name));

if (testFiles.length === 0) {
  console.error(`No test files found in ${testsDir}`);
  process.exit(1);
}

const testArgs = [
  '--test',
  '--experimental-test-coverage',
  '--test-reporter=lcov',
  `--test-reporter-destination=${lcovPath}`,
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  ...testFiles,
];

const testRun = spawnSync(process.execPath, testArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (testRun.error) {
  console.error(`Failed to run tests with coverage: ${testRun.error.message}`);
  process.exit(1);
}

if (testRun.status !== 0) {
  console.error('\nTests failed; skipping coverage threshold check.');
  process.exit(testRun.status ?? 1);
}

const thresholdRun = spawnSync(
  process.execPath,
  [path.join('build-scripts', 'check-coverage-thresholds.js'), lcovPath],
  { cwd: projectRoot, stdio: 'inherit' }
);

process.exit(thresholdRun.status ?? 1);
