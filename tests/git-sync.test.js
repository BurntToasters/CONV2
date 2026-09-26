const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { assessDiscard, decide } = require('../build-scripts/git-sync-guard.js');

// Failure modes for `npm run b` / `npm run r` / `npm run vi`, which run git reset --hard and
// git clean -fd. Written before the guard. Uses real throwaway git repositories.

const ROOT = path.join(__dirname, '..');
const SYNC = path.join(ROOT, 'build-scripts', 'git-sync.js');
const VI = path.join(ROOT, 'build-scripts', 'vi.js');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const makeRepo = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-sync-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(work, 'tracked.txt'), 'original\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'switch', '-q', '-c', 'beta');
  git(work, 'push', '-q', '-u', 'origin', 'beta');
  git(work, 'switch', '-q', 'main');
  git(work, 'branch', '-q', '--set-upstream-to=origin/main');
  git(work, 'switch', '-q', '-c', 'next-9.9.9');
  git(work, 'push', '-q', '-u', 'origin', 'next-9.9.9');
  return { base, work, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
};

const runSync = (cwd, args) =>
  spawnSync(process.execPath, [SYNC, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CONV2_SYNC_YES: '' },
  });

test('clean, fully pushed tree is not at risk', () => {
  const repo = makeRepo();
  try {
    const risk = assessDiscard(repo.work, 'beta');
    assert.deepEqual(risk, { dirty: [], unpushed: [] });
    assert.equal(decide(risk, { yes: false, interactive: false }), 'proceed');
  } finally {
    repo.cleanup();
  }
});

test('uncommitted change is reported and blocks a non-interactive run', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
    const risk = assessDiscard(repo.work, 'beta');
    assert.equal(risk.dirty.length, 1);
    assert.equal(decide(risk, { yes: false, interactive: false }), 'refuse');
  } finally {
    repo.cleanup();
  }
});

test('untracked files count (git clean -fd would delete them); ignored files do not', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo.work, 'node_modules'));
    fs.writeFileSync(path.join(repo.work, 'node_modules', 'dep.js'), '');
    assert.deepEqual(assessDiscard(repo.work, 'beta').dirty, []);
    fs.writeFileSync(path.join(repo.work, 'new-feature.ts'), 'wip');
    assert.match(assessDiscard(repo.work, 'beta').dirty.join('\n'), /new-feature\.ts/);
  } finally {
    repo.cleanup();
  }
});

test('unpushed commits on the current branch are reported', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'committed locally\n');
    git(repo.work, 'commit', '-q', '-am', 'local only');
    const risk = assessDiscard(repo.work, 'beta');
    assert.equal(risk.unpushed.length, 1);
    assert.equal(decide(risk, { yes: false, interactive: false }), 'refuse');
  } finally {
    repo.cleanup();
  }
});

test('unpushed commits on the target branch are reported (switch -C drops them)', () => {
  const repo = makeRepo();
  try {
    git(repo.work, 'switch', '-q', 'beta');
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'beta local\n');
    git(repo.work, 'commit', '-q', '-am', 'beta local only');
    git(repo.work, 'switch', '-q', 'next-9.9.9');
    assert.equal(assessDiscard(repo.work, 'beta').unpushed.length, 1);
  } finally {
    repo.cleanup();
  }
});

test('--yes proceeds; interactive runs ask; anything but the exact word aborts', () => {
  const risky = { dirty: [' M tracked.txt'], unpushed: [] };
  assert.equal(decide(risky, { yes: true, interactive: false }), 'proceed');
  assert.equal(decide(risky, { yes: false, interactive: true }), 'ask');
  const { isConfirmation } = require('../build-scripts/git-sync-guard.js');
  assert.equal(isConfirmation('DISCARD'), true);
  for (const answer of ['', 'y', 'yes', 'discard', ' DISCARD x']) {
    assert.equal(isConfirmation(answer), false, JSON.stringify(answer));
  }
});

test('CLI refuses on a dirty tree and leaves the work untouched', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
    fs.writeFileSync(path.join(repo.work, 'untracked.ts'), 'wip');
    const run = runSync(repo.work, ['beta', '--skip-install']);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /tracked\.txt/);
    assert.equal(fs.readFileSync(path.join(repo.work, 'tracked.txt'), 'utf8'), 'my work\n');
    assert.ok(fs.existsSync(path.join(repo.work, 'untracked.ts')));
    assert.equal(git(repo.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'next-9.9.9');
  } finally {
    repo.cleanup();
  }
});

test('CLI on a clean tree syncs to origin/beta without prompting', () => {
  const repo = makeRepo();
  try {
    const run = runSync(repo.work, ['beta', '--skip-install']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(git(repo.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'beta');
    assert.equal(git(repo.work, 'rev-parse', 'HEAD'), git(repo.work, 'rev-parse', 'origin/beta'));
  } finally {
    repo.cleanup();
  }
});

test('CLI with --yes discards local work and matches origin exactly', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
    fs.writeFileSync(path.join(repo.work, 'untracked.ts'), 'wip');
    const run = runSync(repo.work, ['main', '--yes', '--skip-install']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(git(repo.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(repo.work, 'status', '--porcelain'), '');
  } finally {
    repo.cleanup();
  }
});

test('CLI rejects unknown targets before touching git', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
    const run = runSync(repo.work, ['next-9.9.9', '--yes', '--skip-install']);
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(path.join(repo.work, 'tracked.txt'), 'utf8'), 'my work\n');
  } finally {
    repo.cleanup();
  }
});

test('CLI fails cleanly outside a git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-nogit-'));
  try {
    const run = runSync(dir, ['beta', '--yes', '--skip-install']);
    assert.notEqual(run.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vi refuses on a dirty tree before resetting or installing', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
    const run = spawnSync(process.execPath, [VI], {
      cwd: repo.work,
      encoding: 'utf8',
      env: { ...process.env, CONV2_SYNC_YES: '' },
    });
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(path.join(repo.work, 'tracked.txt'), 'utf8'), 'my work\n');
  } finally {
    repo.cleanup();
  }
});

test('package scripts never run git reset --hard directly', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, script] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(script, /reset --hard|clean -f/, name);
  }
  assert.match(pkg.scripts.b, /sync:beta/);
  assert.match(pkg.scripts.r, /sync:main/);
});
