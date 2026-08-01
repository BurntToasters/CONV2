const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPrereleaseVersion,
  compareVersions,
  shouldAcceptUpdate,
  shouldAcceptUpdateForChannel,
} = require('../dist/main/updaterPolicy.js');

test('recognizes beta, alpha, and release-candidate versions', () => {
  assert.equal(isPrereleaseVersion('1.5.0-beta.2'), true);
  assert.equal(isPrereleaseVersion('1.5.0-alpha.1'), true);
  assert.equal(isPrereleaseVersion('1.5.0-rc.1'), true);
  assert.equal(isPrereleaseVersion('1.5.0'), false);
});

test('beta users can update to the matching stable release', () => {
  assert.equal(shouldAcceptUpdate('1.5.0', '1.5.0-beta.2'), true);
});

test('beta users can update to a newer stable release', () => {
  assert.equal(shouldAcceptUpdate('1.5.1', '1.5.0-beta.2'), true);
});

test('beta users do not move backward to an older stable release', () => {
  assert.equal(shouldAcceptUpdate('1.4.1', '1.5.0-beta.2'), false);
});

test('beta channel keeps newer prerelease offers eligible', () => {
  assert.equal(shouldAcceptUpdate('1.5.0-beta.3', '1.5.0-beta.2'), true);
});

test('stable channel rejects older stable when current is newer beta', () => {
  assert.equal(shouldAcceptUpdate('1.5.1', '1.6.0-beta.2'), false);
  assert.equal(shouldAcceptUpdateForChannel('1.5.1', '1.6.0-beta.2', false), false);
});

test('stable channel accepts matching or newer stable from beta', () => {
  assert.equal(shouldAcceptUpdate('1.6.0', '1.6.0-beta.2'), true);
  assert.equal(shouldAcceptUpdate('1.6.1', '1.6.0-beta.2'), true);
});

test('rejects older prerelease and equal versions', () => {
  assert.equal(shouldAcceptUpdate('1.6.0-beta.1', '1.6.0-beta.2'), false);
  assert.equal(shouldAcceptUpdate('1.6.0', '1.6.0'), false);
  assert.equal(shouldAcceptUpdate('1.6.0-beta.2', '1.6.0'), false);
});

test('compareVersions ignores build metadata', () => {
  assert.ok(compareVersions('1.5.1+build.9', '1.5.0') > 0);
  assert.equal(shouldAcceptUpdate('1.5.1+meta', '1.5.0'), true);
  assert.equal(shouldAcceptUpdate('1.5.0+meta', '1.5.0'), false);
});
