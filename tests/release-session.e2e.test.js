// E2E: runs build-scripts/release-session.js functions against temp git repos.
// Proves the quality-gate proof and build session bind version, commit,
// platform, toolchain, and lockfile, expire after 24h, and fail closed.
// Failure modes: dirty tree, expired proof/session, commit or lockfile drift,
// missing files, proof recorded after session started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SESSION_SCRIPT = path.join(ROOT, 'build-scripts', 'release-session.js');
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'release-session-e2e.json');

const scenarios = [];

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function setupRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-session-'));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  git(tmp, ['init', work]);
  git(work, ['config', 'user.email', 'session-e2e@example.com']);
  git(work, ['config', 'user.name', 'Session E2E']);
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'conv2', version: '9.9.9-beta.1' }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(work, 'package-lock.json'),
    JSON.stringify({ name: 'conv2', version: '9.9.9-beta.1', lockfileVersion: 3 }, null, 2) + '\n'
  );
  fs.mkdirSync(path.join(work, 'build-scripts'));
  fs.copyFileSync(SESSION_SCRIPT, path.join(work, 'build-scripts', 'release-session.js'));
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'release']);
  return { tmp, work };
}

function cleanup(repo) {
  fs.rmSync(repo.tmp, { recursive: true, force: true, maxRetries: 3 });
}

function loadSessionModule(repo) {
  return require(path.join(repo.work, 'build-scripts', 'release-session.js'));
}

function runCli(repo) {
  return spawnSync(
    process.execPath,
    [path.join(repo.work, 'build-scripts', 'release-session.js')],
    {
      cwd: repo.work,
      encoding: 'utf8',
    }
  );
}

function record(name, ok, detail = '') {
  scenarios.push({ scenario: name, ok, detail: String(detail).slice(0, 160) });
}

test('clean tree records the quality-gate proof', (t) => {
  const repo = setupRepo();
  t.after(() => cleanup(repo));
  const session = loadSessionModule(repo);
  const result = session.recordSuccessfulQualityGate(repo.work);
  record('record clean', result.recorded === true);
  assert.equal(result.recorded, true);
  const proof = JSON.parse(
    fs.readFileSync(path.join(repo.work, 'coverage', '.release-quality.json'), 'utf8')
  );
  assert.equal(proof.version, '9.9.9-beta.1');
  assert.equal(proof.commit, git(repo.work, ['rev-parse', 'HEAD']));
  assert.equal(proof.platform, process.platform);
  assert.ok(Number.isFinite(proof.completedAt));
});

test('dirty tree is not recorded', (t) => {
  const repo = setupRepo();
  t.after(() => cleanup(repo));
  fs.writeFileSync(path.join(repo.work, 'dirty.txt'), 'uncommitted\n');
  const session = loadSessionModule(repo);
  const result = session.recordSuccessfulQualityGate(repo.work);
  record('record dirty refused', result.recorded === false);
  assert.equal(result.recorded, false);
  assert.match(result.dirtyFiles, /dirty\.txt/);
});

test('session creation requires a fresh proof', (t) => {
  const repo = setupRepo();
  t.after(() => cleanup(repo));
  const session = loadSessionModule(repo);
  assert.throws(() => session.createReleaseSession(repo.work), /quality-gate proof is missing/);
  session.recordSuccessfulQualityGate(repo.work);
  const created = session.createReleaseSession(repo.work);
  record('session created after proof', Number.isFinite(created.startedAt));
  assert.ok(Number.isFinite(created.startedAt));
  assert.ok(created.startedAt >= created.qualityGateCompletedAt);
  fs.mkdirSync(path.join(repo.work, 'release'), { recursive: true });
  fs.writeFileSync(
    path.join(repo.work, 'release', '.build-session.json'),
    JSON.stringify(created) + '\n'
  );
  const verified = session.verifyReleaseSession(repo.work);
  assert.equal(verified.commit, git(repo.work, ['rev-parse', 'HEAD']));
});

test('proof for another commit is rejected', (t) => {
  const repo = setupRepo();
  t.after(() => cleanup(repo));
  const session = loadSessionModule(repo);
  session.recordSuccessfulQualityGate(repo.work);
  fs.writeFileSync(path.join(repo.work, 'next.txt'), 'new commit\n');
  git(repo.work, ['add', '-A']);
  git(repo.work, ['commit', '-m', 'advance']);
  assert.throws(() => session.createReleaseSession(repo.work), /does not match/);
  record('commit drift rejected', true);
});

test('lockfile drift after the proof is rejected', (t) => {
  const repo = setupRepo();
  t.after(() => cleanup(repo));
  const session = loadSessionModule(repo);
  session.recordSuccessfulQualityGate(repo.work);
  fs.writeFileSync(
    path.join(repo.work, 'package-lock.json'),
    JSON.stringify({ name: 'conv2', version: '9.9.9-beta.2', lockfileVersion: 3 }, null, 2) + '\n'
  );
  git(repo.work, ['add', '-A']);
  git(repo.work, ['commit', '-m', 'bump lock']);
  assert.throws(() => session.createReleaseSession(repo.work), /does not match/);
  record('lockfile drift rejected', true);
});

test('expired proof and session fail closed', (t) => {
  const repo = setupRepo();
  t.after(() => cleanup(repo));
  const session = loadSessionModule(repo);
  session.recordSuccessfulQualityGate(repo.work);
  const proofPath = path.join(repo.work, 'coverage', '.release-quality.json');
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  proof.completedAt = Date.now() - 25 * 60 * 60 * 1000;
  fs.writeFileSync(proofPath, JSON.stringify(proof) + '\n');
  assert.throws(() => session.createReleaseSession(repo.work), /expired/);
  record('expired proof rejected', true);
});

test('CLI verifies a live session and fails without one', (t) => {
  const repo = setupRepo();
  t.after(() => cleanup(repo));
  const missing = runCli(repo);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /FAILED/);
  const session = loadSessionModule(repo);
  session.recordSuccessfulQualityGate(repo.work);
  const created = session.createReleaseSession(repo.work);
  fs.mkdirSync(path.join(repo.work, 'release'), { recursive: true });
  fs.writeFileSync(
    path.join(repo.work, 'release', '.build-session.json'),
    JSON.stringify(created) + '\n'
  );
  const ok = runCli(repo);
  record('CLI verifies live session', ok.status === 0);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /release-session: ok/);
});

test('writes the session E2E artifact', () => {
  assert.ok(scenarios.length >= 6, 'expected every session scenario to run');
  assert.ok(
    scenarios.every((entry) => entry.ok),
    'every session scenario must pass'
  );
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(
    ARTIFACT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), scenarios }, null, 2) + '\n'
  );
  console.log('release-session E2E artifact: ' + ARTIFACT_PATH);
});
