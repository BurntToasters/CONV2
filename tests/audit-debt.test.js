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

test('Electron stays on the 44.5 patch line', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(String(pkg.devDependencies.electron), /\^?44\.5\./);
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
