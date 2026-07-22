const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  copyExecutableToPrivateDirectory,
  createPrivateExecutableDirectory,
  removePrivateExecutableDirectory,
} = require('../dist/main/executableTemp.js');

const temporaryRoots = [];

const makeTemporaryRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-executable-test-'));
  temporaryRoots.push(root);
  return root;
};

test.afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('creates a unique private executable directory', () => {
  const root = makeTemporaryRoot();
  const first = createPrivateExecutableDirectory(root);
  const second = createPrivateExecutableDirectory(root);

  assert.notEqual(first, second);
  assert.equal(fs.lstatSync(first).isDirectory(), true);
  assert.equal(fs.lstatSync(first).mode & 0o777, 0o700);
});

test('copies a regular file exclusively and marks it executable', () => {
  const root = makeTemporaryRoot();
  const source = path.join(root, 'ffmpeg');
  fs.writeFileSync(source, 'binary');
  const destinationDirectory = createPrivateExecutableDirectory(root);

  const destination = copyExecutableToPrivateDirectory(source, destinationDirectory);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'binary');
  assert.equal(fs.lstatSync(destination).mode & 0o777, 0o700);
  assert.throws(() => copyExecutableToPrivateDirectory(source, destinationDirectory), /EEXIST/);
});

test('rejects symbolic-link sources and cache directories', () => {
  const root = makeTemporaryRoot();
  const source = path.join(root, 'ffmpeg');
  fs.writeFileSync(source, 'binary');
  const sourceLink = path.join(root, 'ffmpeg-link');
  fs.symlinkSync(source, sourceLink);
  const destinationDirectory = createPrivateExecutableDirectory(root);

  assert.throws(
    () => copyExecutableToPrivateDirectory(sourceLink, destinationDirectory),
    /non-regular executable source/
  );

  const directoryLink = path.join(root, 'cache-link');
  fs.symlinkSync(destinationDirectory, directoryLink);
  assert.throws(
    () => copyExecutableToPrivateDirectory(source, directoryLink),
    /unsafe executable cache directory/
  );
});

test('removes only the generated private directory', () => {
  const root = makeTemporaryRoot();
  const directory = createPrivateExecutableDirectory(root);
  removePrivateExecutableDirectory(directory);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(root), true);
});
