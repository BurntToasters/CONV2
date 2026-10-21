const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Failure modes: prompts block dirty syncs; local commits survive resets; ignored
// files disappear; invalid targets touch Git; VM setup stops before installing.
// Exercise the real CLIs in throwaway repositories before changing production code.

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

for (const target of ['main', 'beta']) {
  test(`CLI discards local work and commits on ${target} without confirmation`, () => {
    const repo = makeRepo();
    try {
      for (const branch of [target, 'next-9.9.9']) {
        git(repo.work, 'switch', '-q', branch);
        fs.writeFileSync(path.join(repo.work, 'tracked.txt'), `${branch} local commit\n`);
        git(repo.work, 'commit', '-q', '-am', 'local only');
      }
      fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
      fs.writeFileSync(path.join(repo.work, 'untracked.ts'), 'wip');
      fs.mkdirSync(path.join(repo.work, 'node_modules'));
      fs.writeFileSync(path.join(repo.work, 'node_modules', 'keep'), 'ignored');
      const run = runSync(repo.work, [target, '--skip-install']);
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stdout + run.stderr, /DISCARD|Refusing/);
      assert.equal(git(repo.work, 'rev-parse', '--abbrev-ref', 'HEAD'), target);
      assert.equal(
        git(repo.work, 'rev-parse', 'HEAD'),
        git(repo.work, 'rev-parse', `origin/${target}`)
      );
      assert.equal(fs.readFileSync(path.join(repo.work, 'tracked.txt'), 'utf8'), 'original\n');
      assert.equal(fs.existsSync(path.join(repo.work, 'untracked.ts')), false);
      assert.equal(
        fs.readFileSync(path.join(repo.work, 'node_modules', 'keep'), 'utf8'),
        'ignored'
      );
      assert.equal(git(repo.work, 'status', '--porcelain'), '');
    } finally {
      repo.cleanup();
    }
  });
}

test('CLI rejects unknown targets before touching git', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
    const run = runSync(repo.work, ['next-9.9.9', '--skip-install']);
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(path.join(repo.work, 'tracked.txt'), 'utf8'), 'my work\n');
  } finally {
    repo.cleanup();
  }
});

test('CLI fails cleanly outside a git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-nogit-'));
  try {
    const run = runSync(dir, ['beta', '--skip-install']);
    assert.notEqual(run.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vi discards local work without confirmation and installs dependencies', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(
      path.join(repo.work, 'package.json'),
      JSON.stringify({ name: 'sync-fixture', version: '1.0.0' })
    );
    fs.writeFileSync(
      path.join(repo.work, 'package-lock.json'),
      JSON.stringify({
        name: 'sync-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'sync-fixture', version: '1.0.0' } },
      })
    );
    git(repo.work, 'add', '.');
    git(repo.work, 'commit', '-q', '-m', 'dependency fixture');
    git(repo.work, 'push', '-q');
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'local commit\n');
    git(repo.work, 'commit', '-q', '-am', 'local only');
    fs.writeFileSync(path.join(repo.work, 'tracked.txt'), 'my work\n');
    fs.writeFileSync(path.join(repo.work, 'untracked.ts'), 'wip');
    const run = spawnSync(process.execPath, [VI], {
      cwd: repo.work,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONV2_SYNC_YES: '',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /VM Setup Complete/);
    assert.doesNotMatch(run.stdout + run.stderr, /DISCARD|Refusing/);
    assert.equal(git(repo.work, 'rev-parse', 'HEAD'), git(repo.work, 'rev-parse', '@{u}'));
    assert.equal(fs.readFileSync(path.join(repo.work, 'tracked.txt'), 'utf8'), 'original\n');
    assert.equal(fs.existsSync(path.join(repo.work, 'untracked.ts')), false);
    assert.equal(git(repo.work, 'status', '--porcelain'), '');
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
