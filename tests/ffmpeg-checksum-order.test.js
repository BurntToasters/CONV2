const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { runtimeFfmpegTarget } = require('../dist/main/ffmpegIntegrity.js');

// Failure modes for the bundled FFmpeg check:
//  - a tampered bundled binary is executed (`-version`) before its checksum is rejected
//  - a matching binary is reported missing
//  - a system FFmpeg is held to the bundled checksum

const spawned = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'child_process') {
    return {
      spawn: (binary, args) => {
        spawned.push(binary);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        setImmediate(() => child.emit('close', 0));
        return child;
      },
      spawnSync: () => ({ status: 0 }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-order-'));
const ffmpegPath = path.join(dir, 'ffmpeg');
const ffprobePath = path.join(dir, 'ffprobe');
let usingBundled = true;

const ffmpegPathModulePath = require.resolve('../dist/main/ffmpegPath.js');
require.cache[ffmpegPathModulePath] = {
  id: ffmpegPathModulePath,
  filename: ffmpegPathModulePath,
  loaded: true,
  exports: {
    getFFmpegPath: () => ffmpegPath,
    getFFprobePath: () => ffprobePath,
    isUsingBundledFFmpeg: () => usingBundled,
  },
};
const ffmpegModulePath = require.resolve('../dist/main/ffmpeg.js');
delete require.cache[ffmpegModulePath];
const { checkFFmpegInstalled, clearFFmpegCaches } = require(ffmpegModulePath);
Module._load = originalLoad;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const stage = (ffmpegBytes, ffprobeBytes) => {
  fs.writeFileSync(ffmpegPath, ffmpegBytes);
  fs.writeFileSync(ffprobePath, ffprobeBytes);
  fs.writeFileSync(
    path.join(dir, 'checksums.json'),
    JSON.stringify({
      [runtimeFfmpegTarget(process.platform, process.arch)]: {
        binaries: {
          ffmpeg: { sha256: sha('good-ffmpeg') },
          ffprobe: { sha256: sha('good-ffprobe') },
        },
      },
    })
  );
  spawned.length = 0;
  clearFFmpegCaches();
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a tampered bundled binary is never executed', async () => {
  stage('evil-ffmpeg', 'good-ffprobe');
  assert.equal(await checkFFmpegInstalled(), false);
  assert.deepEqual(spawned, [], 'tampered binary was run before verification');
});

test('matching bundled binaries are verified, then run', async () => {
  stage('good-ffmpeg', 'good-ffprobe');
  assert.equal(await checkFFmpegInstalled(), true);
  assert.deepEqual(spawned.sort(), [ffmpegPath, ffprobePath].sort());
});

test('a system FFmpeg is not held to the bundled checksums', async () => {
  usingBundled = false;
  try {
    stage('other-ffmpeg', 'other-ffprobe');
    assert.equal(await checkFFmpegInstalled(), true);
  } finally {
    usingBundled = true;
  }
});
