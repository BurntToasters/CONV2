const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  copyReleaseAssets,
  pathsEqual,
  run,
  verifyCopiedPath,
} = require('../build/post-release-assets.js');

const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-finalize-'));
  temporaryDirectories.push(directory);
  return directory;
}

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('recognizes Windows paths without case sensitivity', () => {
  assert.equal(
    pathsEqual('C:/Users/Main/CONV2/release', 'c:/users/main/conv2/release', 'win32'),
    true
  );
});

test('mirrors and verifies release entries', () => {
  const root = makeTemporaryDirectory();
  const releaseDir = path.join(root, 'release');
  const destination = path.join(root, 'mirror');
  fs.mkdirSync(path.join(releaseDir, 'checksums'), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'CONV2-Win-x64-Setup.exe'), 'installer');
  fs.writeFileSync(path.join(releaseDir, 'checksums', 'SHA256SUMS.txt'), 'checksum');

  assert.deepEqual(run({ releaseDir, env: { AFTER_PACK_LOC: destination } }), {
    mirrored: true,
    destination,
    copiedEntries: 2,
  });
  assert.equal(
    fs.readFileSync(path.join(destination, 'CONV2-Win-x64-Setup.exe'), 'utf8'),
    'installer'
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'checksums', 'SHA256SUMS.txt'), 'utf8'),
    'checksum'
  );
});

test('fails when the release directory is missing', () => {
  const root = makeTemporaryDirectory();
  assert.throws(
    () => copyReleaseAssets(path.join(root, 'missing'), path.join(root, 'mirror')),
    /release directory does not exist/
  );
});

test('fails when the release directory is empty', () => {
  const root = makeTemporaryDirectory();
  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir);
  assert.throws(
    () => copyReleaseAssets(releaseDir, path.join(root, 'mirror')),
    /release directory is empty/
  );
});

test('rejects the release directory as its own mirror', () => {
  const root = makeTemporaryDirectory();
  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir);
  fs.writeFileSync(path.join(releaseDir, 'artifact.exe'), 'artifact');
  assert.throws(() => copyReleaseAssets(releaseDir, releaseDir), /cannot be the release directory/);
});

test('rejects a mirror inside the release directory', () => {
  const root = makeTemporaryDirectory();
  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir);
  fs.writeFileSync(path.join(releaseDir, 'artifact.exe'), 'artifact');
  assert.throws(
    () => copyReleaseAssets(releaseDir, path.join(releaseDir, 'mirror')),
    /cannot be inside the release directory/
  );
});

test('detects a mirrored file with the wrong size', () => {
  const root = makeTemporaryDirectory();
  const source = path.join(root, 'source.exe');
  const destination = path.join(root, 'destination.exe');
  fs.writeFileSync(source, 'expected');
  fs.writeFileSync(destination, 'bad');
  assert.throws(() => verifyCopiedPath(source, destination), /mirrored file size differs/);
});
