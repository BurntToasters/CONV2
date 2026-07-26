'use strict';

/**
 * check-coverage-thresholds.js
 *
 * Enforces per-module line-coverage floors against an LCOV report produced by
 * `node --test --experimental-test-coverage` (see build-scripts/run-coverage.js).
 *
 * Usage: node build-scripts/check-coverage-thresholds.js [path/to/lcov.info]
 *
 * Thresholds intentionally cover the pure, unit-testable modules that carry
 * correctness- and security-critical logic. main.ts and preload.ts are NOT
 * listed: they require the Electron runtime and are never loaded by the unit
 * suite, so any threshold on them would be unreachable. Their behaviour is
 * covered by source-contract tests plus the packaged runtime smoke test.
 *
 * Floors sit a few points below measured coverage so ordinary refactors don't
 * trip the gate, while a real regression still does.
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const lcovArg = process.argv[2];
const lcovPath = lcovArg
  ? path.resolve(projectRoot, lcovArg)
  : path.join(projectRoot, 'coverage', 'lcov.info');

/** Minimum line coverage percentage, keyed by path suffix. */
const THRESHOLDS = {
  'main/presets.js': 95,
  'main/advancedFormats.js': 88,
  'main/conversionQueue.js': 90,
  'main/executableTemp.js': 85,
  'main/ipcTrust.js': 95,
  'main/updaterPolicy.js': 95,
  'main/settingsSchema.js': 80,
  'main/ffmpegProgress.js': 95,
  'main/presetProjection.js': 95,
  'main/gpuEncoders.js': 95,
  'renderer/presetPickerModel.js': 85,
};

if (!fs.existsSync(lcovPath)) {
  console.error(`Coverage report not found: ${lcovPath}`);
  console.error('Generate it with: npm run test:coverage');
  process.exit(1);
}

/** Parse LCOV into { [normalizedPath]: { found, hit, pct } }. */
function parseLcov(raw) {
  /** @type {Record<string, {found: number, hit: number, pct: number}>} */
  const files = {};
  for (const block of raw.split('end_of_record')) {
    const sourceMatch = block.match(/^SF:(.*)$/m);
    if (!sourceMatch) continue;
    const filePath = sourceMatch[1].trim().replace(/\\/g, '/');
    const found = Number(block.match(/^LF:(\d+)/m)?.[1] ?? 0);
    const hit = Number(block.match(/^LH:(\d+)/m)?.[1] ?? 0);
    files[filePath] = { found, hit, pct: found > 0 ? (100 * hit) / found : 0 };
  }
  return files;
}

const coverage = parseLcov(fs.readFileSync(lcovPath, 'utf8'));

function findEntry(suffix) {
  const normalized = suffix.replace(/\\/g, '/');
  const match = Object.entries(coverage).find(([filePath]) => filePath.endsWith(normalized));
  return match ? { path: match[0], ...match[1] } : null;
}

const failures = [];
const passes = [];

for (const [suffix, minimum] of Object.entries(THRESHOLDS)) {
  const entry = findEntry(suffix);
  if (!entry) {
    failures.push(`${suffix}: not present in coverage report (is it still imported by a test?)`);
    continue;
  }
  if (entry.found === 0) {
    failures.push(`${suffix}: no executable lines recorded`);
    continue;
  }
  const pct = entry.pct;
  if (pct + 1e-9 < minimum) {
    failures.push(`${suffix}: lines ${pct.toFixed(1)}% < ${minimum}%`);
  } else {
    passes.push(`${suffix}: ${pct.toFixed(1)}% (min ${minimum}%)`);
  }
}

if (failures.length > 0) {
  console.error('\nCoverage thresholds failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`\nCoverage thresholds passed for ${passes.length} modules:`);
for (const pass of passes) {
  console.log(`- ${pass}`);
}
