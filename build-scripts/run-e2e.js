// Runs tests/e2e/*.e2e.js against the real Electron app. Artifacts land in coverage/e2e:
// junit.xml, ui-report.json, conversion-matrix.json, screenshots/.
// Usage: node build-scripts/run-e2e.js [--skip-build] [file-filter]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const E2E_DIR = path.join(ROOT, 'tests', 'e2e');
const ARTIFACT_DIR = path.join(ROOT, 'coverage', 'e2e');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const filter = args.find((a) => !a.startsWith('--'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!skipBuild) {
  const build = spawnSync(npm, ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) process.exit(build.status || 1);
}

const files = fs
  .readdirSync(E2E_DIR)
  .filter((name) => name.endsWith('.e2e.js') && (!filter || name.includes(filter)))
  .sort()
  .map((name) => path.join('tests', 'e2e', name));
if (files.length === 0) {
  console.error('No E2E files matched.');
  process.exit(1);
}

fs.rmSync(path.join(ARTIFACT_DIR, 'screenshots'), { recursive: true, force: true });
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=junit',
    `--test-reporter-destination=${path.join(ARTIFACT_DIR, 'junit.xml')}`,
    ...files,
  ],
  { cwd: ROOT, stdio: 'inherit', env: process.env }
);
console.log(`E2E artifacts: ${path.relative(ROOT, ARTIFACT_DIR)}`);
process.exit(result.status ?? 1);
