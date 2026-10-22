const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

let latestChild = null;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'child_process') {
    return {
      spawn: (binary, args) => {
        const child = new FakeChildProcess();
        // The -version status check exits at once; only the ffprobe run is tracked.
        if (args[0] === '-version') {
          setImmediate(() => child.emit('close', 0));
          return child;
        }
        latestChild = child;
        return child;
      },
      spawnSync: () => ({ status: 0 }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ffmpegPathModulePath = require.resolve('../dist/main/ffmpegPath.js');
const originalFFmpegPathModule = require.cache[ffmpegPathModulePath];
require.cache[ffmpegPathModulePath] = {
  id: ffmpegPathModulePath,
  filename: ffmpegPathModulePath,
  loaded: true,
  exports: {
    getFFmpegPath: () => '/fake/ffmpeg',
    getFFprobePath: () => '/fake/ffprobe',
    isUsingBundledFFmpeg: () => false,
  },
};

const ffmpegModulePath = require.resolve('../dist/main/ffmpeg.js');
delete require.cache[ffmpegModulePath];
const { getVideoInfo, MAX_FFPROBE_OUTPUT_BYTES } = require(ffmpegModulePath);
Module._load = originalLoad;

test.after(() => {
  delete require.cache[ffmpegModulePath];
  if (originalFFmpegPathModule) {
    require.cache[ffmpegPathModulePath] = originalFFmpegPathModule;
  } else {
    delete require.cache[ffmpegPathModulePath];
  }
});

// ffprobe spawns only after the async status gate, so wait for the child to exist.
const nextChild = async () => {
  latestChild = null;
  while (!latestChild) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return latestChild;
};

test('aborting video inspection kills ffprobe and rejects as cancelled', async () => {
  const controller = new AbortController();
  const inspection = getVideoInfo('/input.mp4', controller.signal);
  const child = await nextChild();

  controller.abort();

  await assert.rejects(inspection, /Conversion cancelled/);
  assert.equal(child.killed, true);
});

test('oversized ffprobe output kills the child and rejects', async () => {
  const inspection = getVideoInfo('/input.mp4');
  const child = await nextChild();

  child.stdout.emit('data', Buffer.alloc(MAX_FFPROBE_OUTPUT_BYTES + 1));

  await assert.rejects(inspection, /output exceeded .* safety limit/);
  assert.equal(child.killed, true);
});
