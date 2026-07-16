const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPrereleaseVersion,
  shouldAcceptUpdateForChannel,
} = require('../dist/main/updaterPolicy.js');

test('recognizes beta, alpha, and release-candidate versions', () => {
  assert.equal(isPrereleaseVersion('1.5.0-beta.2'), true);
  assert.equal(isPrereleaseVersion('1.5.0-alpha.1'), true);
  assert.equal(isPrereleaseVersion('1.5.0-rc.1'), true);
  assert.equal(isPrereleaseVersion('1.5.0'), false);
});

test('beta users can update to the matching stable release', () => {
  assert.equal(shouldAcceptUpdateForChannel('1.5.0', '1.5.0-beta.2', true), true);
});

test('beta users can update to a newer stable release', () => {
  assert.equal(shouldAcceptUpdateForChannel('1.5.1', '1.5.0-beta.2', true), true);
});

test('beta users do not move backward to an older stable release', () => {
  assert.equal(shouldAcceptUpdateForChannel('1.4.1', '1.5.0-beta.2', true), false);
});

test('beta channel keeps prerelease offers eligible', () => {
  assert.equal(shouldAcceptUpdateForChannel('1.5.0-beta.3', '1.5.0-beta.2', true), true);
});

test('stable channel leaves stable filtering to electron-updater', () => {
  assert.equal(shouldAcceptUpdateForChannel('1.4.1', '1.5.0', false), true);
});
