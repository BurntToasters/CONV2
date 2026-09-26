const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDevOverrides } = require('../dist/main/devOverrides.js');

// Failure modes for test-only env overrides. Written before devOverrides.ts.

const withFiles = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-dev-'));
  const bin = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(bin, '');
  try {
    return fn(dir, bin);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('packaged builds ignore every override', () => {
  withFiles((dir, bin) => {
    const env = { CONV2_USER_DATA_DIR: dir, CONV2_FFMPEG_PATH: bin, CONV2_FFPROBE_PATH: bin };
    assert.deepEqual(resolveDevOverrides(env, true), {});
  });
});

test('unpackaged builds accept absolute, existing paths', () => {
  withFiles((dir, bin) => {
    const env = { CONV2_USER_DATA_DIR: dir, CONV2_FFMPEG_PATH: bin, CONV2_FFPROBE_PATH: bin };
    assert.deepEqual(resolveDevOverrides(env, false), {
      userDataDir: dir,
      ffmpegPath: bin,
      ffprobePath: bin,
    });
  });
});

test('relative paths are rejected (no PATH or cwd lookups)', () => {
  const env = { CONV2_FFMPEG_PATH: 'ffmpeg', CONV2_USER_DATA_DIR: 'data' };
  assert.deepEqual(resolveDevOverrides(env, false), {});
});

test('missing files and wrong kinds are rejected', () => {
  withFiles((dir, bin) => {
    const env = {
      CONV2_FFMPEG_PATH: path.join(dir, 'nope'),
      CONV2_FFPROBE_PATH: dir,
      CONV2_USER_DATA_DIR: bin,
    };
    assert.deepEqual(resolveDevOverrides(env, false), {});
  });
});

test('empty values are ignored', () => {
  assert.deepEqual(resolveDevOverrides({ CONV2_FFMPEG_PATH: '' }, false), {});
});
