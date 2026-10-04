// E2E: runs build-scripts/release-preflight.js in temp git repos.
// Covers channel branch selection (beta/main), clean tree, upstream tracking,
// and HEAD matching the pushed branch tip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PREFLIGHT_SCRIPT = path.join(ROOT, 'build-scripts', 'release-preflight.js');
const RELEASE_VERSION = path.join(ROOT, 'build-scripts', 'release-version.js');
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'release-preflight-e2e.json');

const scenarios = [];

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo({ version, branch }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-preflight-'));
  const origin = path.join(tmp, 'origin.git');
  runGit(tmp, ['init', '--bare', '--initial-branch=main', origin]);
  const work = path.join(tmp, 'work');
  runGit(tmp, ['clone', '--quiet', origin, work]);
  runGit(work, ['config', 'user.email', 'preflight-e2e@example.com']);
  runGit(work, ['config', 'user.name', 'Preflight E2E']);
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'conv2', version }, null, 2) + '\n'
  );
  fs.mkdirSync(path.join(work, 'build-scripts'));
  fs.copyFileSync(PREFLIGHT_SCRIPT, path.join(work, 'build-scripts', 'release-preflight.js'));
  fs.copyFileSync(RELEASE_VERSION, path.join(work, 'build-scripts', 'release-version.js'));
  if (branch !== 'main') runGit(work, ['checkout', '-b', branch]);
  runGit(work, ['add', '-A']);
  runGit(work, ['commit', '-m', 'release ' + version]);
  runGit(work, ['push', '--quiet', '-u', 'origin', branch]);
  return { tmp, work };
}

function runPreflight(repo) {
  return spawnSync(
    process.execPath,
    [path.join(repo.work, 'build-scripts', 'release-preflight.js')],
    { cwd: repo.work, encoding: 'utf8' }
  );
}

function cleanup(repo) {
  fs.rmSync(repo.tmp, { recursive: true, force: true, maxRetries: 3 });
}

function record(name, result) {
  scenarios.push({ scenario: name, status: result.status, stderr: result.stderr.trim() });
}

test('beta version on beta branch passes preflight', (t) => {
  const repo = createRepo({ version: '9.9.9-beta.1', branch: 'beta' });
  t.after(() => cleanup(repo));
  const result = runPreflight(repo);
  record('beta ok', result);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-preflight: ok \(9\.9\.9-beta\.1, beta@/);
});

test('stable version on main branch passes preflight', (t) => {
  const repo = createRepo({ version: '9.9.9', branch: 'main' });
  t.after(() => cleanup(repo));
  const result = runPreflight(repo);
  record('stable ok', result);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-preflight: ok \(9\.9\.9, main@/);
});

test('beta version on main branch is refused', (t) => {
  const repo = createRepo({ version: '9.9.9-beta.2', branch: 'main' });
  t.after(() => cleanup(repo));
  const result = runPreflight(repo);
  record('beta on main', result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be released from beta, not main/);
});

test('stable version on beta branch is refused', (t) => {
  const repo = createRepo({ version: '9.9.10', branch: 'beta' });
  t.after(() => cleanup(repo));
  const result = runPreflight(repo);
  record('stable on beta', result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be released from main, not beta/);
});

test('dirty working tree is refused', (t) => {
  const repo = createRepo({ version: '9.9.9-beta.3', branch: 'beta' });
  t.after(() => cleanup(repo));
  fs.writeFileSync(path.join(repo.work, 'untracked.txt'), 'dirty\n');
  const result = runPreflight(repo);
  record('dirty tree', result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Working tree is not clean/);
});

test('HEAD ahead of the pushed branch tip is refused', (t) => {
  const repo = createRepo({ version: '9.9.9-beta.4', branch: 'beta' });
  t.after(() => cleanup(repo));
  fs.writeFileSync(path.join(repo.work, 'ahead.txt'), 'unpushed\n');
  runGit(repo.work, ['add', '-A']);
  runGit(repo.work, ['commit', '-m', 'unpushed work']);
  const result = runPreflight(repo);
  record('head ahead', result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match pushed origin\/beta/);
});

test('unsupported version is refused', (t) => {
  const repo = createRepo({ version: '9.9.9-rc.1', branch: 'beta' });
  t.after(() => cleanup(repo));
  const result = runPreflight(repo);
  record('unsupported version', result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported release version/);
});

test('writes the preflight E2E artifact', () => {
  assert.ok(scenarios.length >= 7, 'expected every preflight scenario to run');
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(
    ARTIFACT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), scenarios }, null, 2) + '\n'
  );
  console.log('release-preflight E2E artifact: ' + ARTIFACT_PATH);
});
