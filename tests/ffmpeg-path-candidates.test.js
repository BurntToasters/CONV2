const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  ffmpegPlatformFolder,
  bundledFFmpegRelDirs,
  bundledBinaryFileName,
} = require('../dist/main/ffmpegPathCandidates.js');

test('platform folders match the repo resources/ffmpeg tree', () => {
  assert.equal(ffmpegPlatformFolder('win32'), 'win');
  assert.equal(ffmpegPlatformFolder('darwin'), 'mac');
  assert.equal(ffmpegPlatformFolder('linux'), 'linux');
  assert.equal(ffmpegPlatformFolder('sunos'), null);
});

test('search dirs include flat, arch, and platform/arch on every OS', () => {
  assert.deepEqual(bundledFFmpegRelDirs('linux', 'x64'), ['', 'x64', path.join('linux', 'x64')]);
  assert.deepEqual(bundledFFmpegRelDirs('darwin', 'arm64'), [
    '',
    'arm64',
    path.join('mac', 'arm64'),
  ]);
  assert.deepEqual(bundledFFmpegRelDirs('win32', 'x64'), ['', 'x64', path.join('win', 'x64')]);
});

test('Windows binaries use .exe', () => {
  assert.equal(bundledBinaryFileName('win32', 'ffmpeg'), 'ffmpeg.exe');
  assert.equal(bundledBinaryFileName('darwin', 'ffprobe'), 'ffprobe');
});
