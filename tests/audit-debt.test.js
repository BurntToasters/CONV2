const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('test-all does not parse Vitest summaries', () => {
  const source = read('build-scripts/test-all.js');
  assert.doesNotMatch(source, /vitest/i);
});

test('GPG signing does not put the passphrase on argv', () => {
  const source = read('build-scripts/gpg-sign.js');
  assert.doesNotMatch(source, /--passphrase['`,\s]/);
  assert.match(source, /passphrase-fd/);
});

test('beta release does not mutate tracked index.html', () => {
  const patch = read('build/patch-beta.js');
  const releaseBeta = read('build-scripts/release-beta.js');
  assert.doesNotMatch(patch, /writeFileSync\(indexPath/);
  assert.doesNotMatch(releaseBeta, /patch:beta/);
});

test('comment lint runs in CI', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run lint/);
});

test('one macOS keychain helper exists', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'mac-keychain-ssh.sh')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'build-scripts', 'mac-keychain-ssh.sh')), false);
});

test('keychain helper does not pass the password on security argv', () => {
  const source = read('scripts/mac-keychain-ssh.sh');
  assert.doesNotMatch(source, /unlock-keychain -p "/);
  assert.doesNotMatch(source, /set-key-partition-list .* -k "/);
});

test('dead husky installer is gone', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'build-scripts', 'install-hooks.js')), false);
});

test('yt-dlp leftovers from another project are gone', () => {
  for (const dir of ['build', 'build-scripts', 'scripts']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const full = path.join(ROOT, dir, name);
      if (!fs.statSync(full).isFile()) continue;
      assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /yt-dlp/, `${dir}/${name}`);
    }
  }
});

test('main process does not intercept TLS certificate errors', () => {
  const source = read('src/main/main.ts');
  assert.doesNotMatch(source, /certificate-error/);
});

test('Store AppX lives only in the Store config', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.appx, undefined);
});

test('drop zone is a region, not a nested button', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="dropZone"[\s\S]*?role="region"/);
  assert.match(html, /id="browseFilesBtn"/);
  assert.match(html, /id="selectedFileList"/);
});

test('retired updater channel alias is gone', () => {
  const source = read('src/main/updaterPolicy.ts');
  assert.doesNotMatch(source, /shouldAcceptUpdateForChannel/);
});

// 44.9.1+ blocks the compromised eMudhra intermediate CAs.
test('Electron is at least 44.9.1', () => {
  const pkg = JSON.parse(read('package.json'));
  const match = String(pkg.devDependencies.electron).match(/(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'electron version is not a plain semver range');
  const [major, minor, patch] = match.slice(1).map(Number);
  const floor = [44, 9, 1];
  const cmp = major - floor[0] || minor - floor[1] || patch - floor[2];
  assert.ok(cmp >= 0, `electron ${match[0]} is below 44.9.1`);
});

// Windows refuses to spawn npm.cmd without a shell (EINVAL since the CVE-2024-27980 fix).
test('release and smoke scripts spawn npm through a shell on Windows', () => {
  for (const file of ['build-scripts/release-beta.js', 'build-scripts/smoke-runtime.js']) {
    assert.match(read(file), /shell: process\.platform === 'win32'/, file);
  }
});

test('beta release only runs plain release:* script names', () => {
  const { isReleaseScriptName } = require('../build-scripts/release-beta.js');
  assert.equal(isReleaseScriptName('release:win'), true);
  assert.equal(isReleaseScriptName('release:linux:all'), true);
  assert.equal(isReleaseScriptName('release:win & calc'), false);
  assert.equal(isReleaseScriptName('build:win'), false);
});

// A bare Enter accelerator swallows Enter in text fields and on buttons and starts a run.
test('Start Conversion has no bare Enter menu accelerator', () => {
  assert.doesNotMatch(read('src/main/applicationMenu.ts'), /accelerator: 'Enter'/);
});

// Node 26 can deadlock in process.exit (exit joins a V8 compile thread waiting
// on a main-thread GC). Failure modes: a release-path script still calls it;
// a converted script loses its exit code; a converted script hangs on a
// leftover handle instead of exiting.
const EXIT_CODE_SCRIPTS = [
  'build-scripts/ensure-release-ffmpeg.js',
  'build/dist-tools.js',
  'build/update-metainfo.js',
  'build-scripts/windows-build.js',
  'build/finalize-release-assets.js',
  'build-scripts/test-all.js',
  'build-scripts/release-warning.js',
  'build-scripts/release-beta.js',
];

test('release-path scripts end with process.exitCode, not process.exit', () => {
  for (const script of EXIT_CODE_SCRIPTS) {
    assert.doesNotMatch(read(script), /process\.exit\(/, script);
  }
});

test('converted scripts keep their failure exit codes and exit promptly', () => {
  const { spawnSync } = require('node:child_process');
  const run = (script, args) =>
    spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });
  const distTools = run('build/dist-tools.js', ['bogus']);
  assert.equal(distTools.status, 1, distTools.stderr);
  assert.match(distTools.stderr, /Usage/);
  const beta = run('build-scripts/release-beta.js', ['bogus']);
  assert.equal(beta.status, 1, beta.stderr);
  const betaFlag = run('build-scripts/release-beta.js', ['release:linux', 'linux']);
  assert.equal(betaFlag.status, 1, betaFlag.stderr);
  assert.match(betaFlag.stderr, /Refusing release flag/);
  const warning = run('build-scripts/release-warning.js', []);
  assert.equal(warning.status, 0, warning.stderr);
  assert.match(warning.stderr, /DESTRUCTIVE/);
});
