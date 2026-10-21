// E2E: runs the real release:mirror runner (build/finalize-release-assets.js) in a temp repo.
// Failure modes:
// - Windows mapped drive (Z:): fs.cpSync's native recursive path aborts Node after the
//   banners print; nothing is mirrored and no error is reported.
// - SMB rejects copyFileSync metadata (EPERM/EACCES) though plain bytes would copy.
// - Same-size corruption passes a size-only verification.
// - A failed copy leaves a partial file under the final name or staging debris in the mirror.
// - Re-mirroring removes other platforms' artifacts from the shared mirror.
// - Dotfile session markers (.build-session.json) are mirrored to the share.
// - Relative, repository-local, or symlinked AFTER_PACK_LOC is accepted, or rejected only
//   after release/ build-only files were already cleaned.
// - A stable release reports success without mirroring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'release-mirror-e2e.json');
const RUNNER_FILES = [
  'build/post-release-assets.js',
  'build/finalize-release-assets.js',
  'build-scripts/release-policy.js',
  'build-scripts/release-version.js',
];
const STABLE = '9.9.9';
const BETA = '9.9.9-beta.1';
const INSTALLER = 'CONV2-Win-x64-Setup.exe';

const scenarios = [];
const temporaryDirectories = [];

function record(name, ok, detail = {}) {
  scenarios.push({ name, ok, ...detail });
}

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function setupRepo(version = STABLE) {
  const repo = tempDir('conv2-mirror-repo-');
  for (const file of RUNNER_FILES) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(repo, file));
  }
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'conv2', version }));
  const release = path.join(repo, 'release');
  fs.mkdirSync(path.join(release, 'win-unpacked'), { recursive: true });
  fs.mkdirSync(path.join(release, 'checksums'), { recursive: true });
  fs.writeFileSync(path.join(release, INSTALLER), 'installer-bytes');
  fs.writeFileSync(path.join(release, 'checksums', 'SHA256SUMS-Windows.txt'), 'sums');
  fs.writeFileSync(path.join(release, 'win-unpacked', 'CONV2.exe'), 'unpacked');
  fs.writeFileSync(path.join(release, 'builder-debug.yml'), 'debug');
  fs.writeFileSync(path.join(release, '.build-session.json'), '{}');
  return { repo, release };
}

function writeHook(source) {
  const hook = path.join(tempDir('conv2-mirror-hook-'), 'hook.js');
  fs.writeFileSync(hook, source);
  return hook;
}

function runMirror(repo, env, hook) {
  const args = hook ? ['--require', hook] : [];
  args.push(path.join(repo, 'build', 'finalize-release-assets.js'));
  const ran = spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: path.join(ROOT, 'node_modules'),
      SKIP_RELEASE_MIRROR: '',
      OVERRIDE_BETA_MIRROR_SKIP: '',
      FORCE_UPLOAD: '',
      ALLOW_ASSET_REPLACE: '',
      ...env,
    },
  });
  return { status: ran.status, output: `${ran.stdout ?? ''}${ran.stderr ?? ''}` };
}

function mirrorDebris(mirror) {
  return fs.existsSync(mirror)
    ? fs.readdirSync(mirror).filter((name) => name.startsWith('.conv2-mirror-'))
    : [];
}

test('mirrors even when the native recursive cpSync path aborts Node (Windows Z: drive)', () => {
  const { repo } = setupRepo();
  const mirror = path.join(tempDir('conv2-mirror-dest-'), 'CONV2');
  const hook = writeHook("const fs = require('node:fs');\nfs.cpSync = () => process.exit(134);\n");
  const ran = runMirror(repo, { AFTER_PACK_LOC: mirror }, hook);
  const ok =
    ran.status === 0 && fs.readFileSync(path.join(mirror, INSTALLER), 'utf8') === 'installer-bytes';
  record('native cpSync abort does not block the mirror', ok, { status: ran.status });
  assert.equal(ran.status, 0, ran.output);
  assert.match(ran.output, /Mirrored and verified 2 cleaned release entries/);
  assert.equal(
    fs.readFileSync(path.join(mirror, 'checksums', 'SHA256SUMS-Windows.txt'), 'utf8'),
    'sums'
  );
});

test('falls back to a plain byte copy when SMB rejects copyFileSync', () => {
  const { repo } = setupRepo();
  const mirror = path.join(tempDir('conv2-mirror-dest-'), 'CONV2');
  const hook = writeHook(
    [
      "const fs = require('node:fs');",
      'fs.copyFileSync = () => {',
      "  throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });",
      '};',
      '',
    ].join('\n')
  );
  const ran = runMirror(repo, { AFTER_PACK_LOC: mirror }, hook);
  const ok = ran.status === 0 && fs.existsSync(path.join(mirror, INSTALLER));
  record('EPERM copy falls back to byte copy', ok, { status: ran.status });
  assert.equal(ran.status, 0, ran.output);
  assert.equal(fs.readFileSync(path.join(mirror, INSTALLER), 'utf8'), 'installer-bytes');
});

test('rejects same-size corruption and keeps the previous mirrored file intact', () => {
  const { repo } = setupRepo();
  const mirror = path.join(tempDir('conv2-mirror-dest-'), 'CONV2');
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, INSTALLER), 'previous-good');
  // Corrupt every copy with same-length bytes.
  const hook = writeHook(
    [
      "const fs = require('node:fs');",
      'const copy = fs.copyFileSync;',
      'fs.copyFileSync = (src, dest) => {',
      '  copy(src, dest);',
      "  fs.writeFileSync(dest, 'x'.repeat(fs.statSync(src).size));",
      '};',
      '',
    ].join('\n')
  );
  const ran = runMirror(repo, { AFTER_PACK_LOC: mirror }, hook);
  const ok =
    ran.status !== 0 &&
    /hash differs/.test(ran.output) &&
    fs.readFileSync(path.join(mirror, INSTALLER), 'utf8') === 'previous-good' &&
    mirrorDebris(mirror).length === 0;
  record('same-size corruption fails closed without debris', ok, { status: ran.status });
  assert.notEqual(ran.status, 0);
  assert.match(ran.output, /hash differs/);
  assert.equal(fs.readFileSync(path.join(mirror, INSTALLER), 'utf8'), 'previous-good');
  assert.deepEqual(mirrorDebris(mirror), []);
});

test('merges into a shared mirror, overwrites same names, skips dotfiles, cleans build-only files', () => {
  const { repo, release } = setupRepo();
  const mirror = path.join(tempDir('conv2-mirror-dest-'), 'CONV2');
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, 'CONV2-macOS-universal.dmg'), 'mac');
  fs.writeFileSync(path.join(mirror, INSTALLER), 'old-installer');
  const ran = runMirror(repo, { AFTER_PACK_LOC: mirror });
  const listing = fs.readdirSync(mirror).sort();
  const ok =
    ran.status === 0 &&
    listing.join(',') ===
      ['CONV2-Win-x64-Setup.exe', 'CONV2-macOS-universal.dmg', 'checksums'].sort().join(',') &&
    !fs.existsSync(path.join(release, 'win-unpacked')) &&
    fs.existsSync(path.join(release, '.build-session.json'));
  record('shared mirror merge', ok, { status: ran.status, listing });
  assert.equal(ran.status, 0, ran.output);
  assert.deepEqual(
    listing,
    ['CONV2-Win-x64-Setup.exe', 'CONV2-macOS-universal.dmg', 'checksums'].sort()
  );
  assert.equal(fs.readFileSync(path.join(mirror, INSTALLER), 'utf8'), 'installer-bytes');
  assert.equal(fs.existsSync(path.join(release, 'win-unpacked')), false);
  assert.equal(fs.existsSync(path.join(release, 'builder-debug.yml')), false);
  assert.equal(fs.existsSync(path.join(release, '.build-session.json')), true);
});

test('rejects unsafe AFTER_PACK_LOC values before cleaning release/', () => {
  const cases = [
    ['relative', () => (process.platform === 'win32' ? 'relative\\mirror' : 'Z:/CONV2')],
    ['repository-local', (repo) => path.join(repo, 'mirror')],
  ];
  if (process.platform !== 'win32') {
    cases.push([
      'symlink',
      () => {
        const base = tempDir('conv2-mirror-dest-');
        fs.mkdirSync(path.join(base, 'actual'));
        fs.symlinkSync(path.join(base, 'actual'), path.join(base, 'link'));
        return path.join(base, 'link');
      },
    ]);
  }
  const expected = {
    relative: /must be an absolute path/,
    'repository-local': /must be outside the repository/,
    symlink: /must not be a symbolic link/,
  };
  for (const [name, destinationFor] of cases) {
    const { repo, release } = setupRepo();
    const ran = runMirror(repo, { AFTER_PACK_LOC: destinationFor(repo) });
    const ok =
      ran.status !== 0 &&
      expected[name].test(ran.output) &&
      fs.existsSync(path.join(release, 'win-unpacked', 'CONV2.exe'));
    record(`rejects ${name} AFTER_PACK_LOC before clean`, ok, { status: ran.status });
    assert.notEqual(ran.status, 0, `${name}: ${ran.output}`);
    assert.match(ran.output, expected[name]);
    assert.equal(fs.existsSync(path.join(release, 'win-unpacked', 'CONV2.exe')), true, name);
  }
});

test('stable without AFTER_PACK_LOC fails; beta skips the mirror', () => {
  const stable = setupRepo(STABLE);
  const stableRun = runMirror(stable.repo, { AFTER_PACK_LOC: '' });
  const beta = setupRepo(BETA);
  const mirror = path.join(tempDir('conv2-mirror-dest-'), 'CONV2');
  const betaRun = runMirror(beta.repo, { AFTER_PACK_LOC: mirror });
  const ok = stableRun.status !== 0 && betaRun.status === 0 && !fs.existsSync(mirror);
  record('stable requires mirror; beta skips', ok, {
    stableStatus: stableRun.status,
    betaStatus: betaRun.status,
  });
  assert.notEqual(stableRun.status, 0);
  assert.match(stableRun.output, /requires AFTER_PACK_LOC/);
  assert.equal(betaRun.status, 0, betaRun.output);
  assert.equal(fs.existsSync(mirror), false);
});

test('writes the release mirror E2E artifact', () => {
  assert.ok(scenarios.length >= 8, 'expected every mirror scenario to run');
  assert.ok(
    scenarios.every((entry) => entry.ok),
    'every mirror scenario must pass'
  );
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(
    ARTIFACT_PATH,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), platform: process.platform, scenarios },
      null,
      2
    ) + '\n'
  );
  console.log('release-mirror E2E artifact: ' + ARTIFACT_PATH);
});
