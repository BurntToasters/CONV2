const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureMp4PlaybackCompatibilityArgs } = require('../dist/main/ffmpeg.js');

test('adds faststart and hvc1 for H.265 MP4 output', () => {
  const preset = {
    id: 'h265-test',
    name: 'h265',
    description: 'test',
    category: 'h265',
    extension: 'mp4',
    getArgs: () => [],
  };

  const args = ensureMp4PlaybackCompatibilityArgs(preset, [
    '-i',
    'input.mp4',
    '-c:v',
    'hevc_nvenc',
    'output.mp4',
  ]);

  assert.equal(args[args.length - 1], 'output.mp4');
  assert.ok(args.includes('-movflags'));
  assert.ok(args.includes('+faststart'));
  assert.ok(args.includes('-tag:v'));
  assert.ok(args.includes('hvc1'));
});

test('adds faststart for non-H.265 MP4 output', () => {
  const preset = {
    id: 'h264-test',
    name: 'h264',
    description: 'test',
    category: 'h264',
    extension: 'mp4',
    getArgs: () => [],
  };

  const args = ensureMp4PlaybackCompatibilityArgs(preset, [
    '-i',
    'input.mp4',
    '-c:v',
    'h264_nvenc',
    'output.mp4',
  ]);

  assert.ok(args.includes('-movflags'));
  assert.ok(args.includes('+faststart'));
  assert.equal(args.includes('-tag:v'), false);
});

test('preserves existing movflags and appends faststart once', () => {
  const preset = {
    id: 'h265-test-movflags',
    name: 'h265',
    description: 'test',
    category: 'h265',
    extension: 'mp4',
    getArgs: () => [],
  };

  const args = ensureMp4PlaybackCompatibilityArgs(preset, [
    '-i',
    'input.mp4',
    '-movflags',
    'frag_keyframe',
    '-c:v',
    'hevc_nvenc',
    'output.mp4',
  ]);

  const movflagsIndex = args.indexOf('-movflags');
  assert.ok(movflagsIndex >= 0);
  assert.equal(args[movflagsIndex + 1], 'frag_keyframe+faststart');
  assert.equal(args.filter((arg) => arg === '-movflags').length, 1);
});

test('does not modify non-MP4 args', () => {
  const preset = {
    id: 'mkv-test',
    name: 'mkv',
    description: 'test',
    category: 'h265',
    extension: 'mkv',
    getArgs: () => [],
  };

  const inputArgs = ['-i', 'input.mp4', '-c:v', 'hevc_nvenc', 'output.mkv'];
  const args = ensureMp4PlaybackCompatibilityArgs(preset, inputArgs);

  assert.deepEqual(args, inputArgs);
});
