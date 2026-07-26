const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runConversionQueue,
  shouldRetryWithCpu,
  createEmptyQueueSnapshot,
} = require('../dist/main/conversionQueue.js');

test('shouldRetryWithCpu detects nvenc failures', () => {
  assert.equal(
    shouldRetryWithCpu(
      { success: false, outputPath: '', error: 'Cannot load nvencodeapi' },
      'nvidia',
      true
    ),
    true
  );
  assert.equal(
    shouldRetryWithCpu(
      { success: false, outputPath: '', error: 'no such file or directory' },
      'nvidia',
      true
    ),
    false
  );
  assert.equal(
    shouldRetryWithCpu({ success: false, outputPath: '', error: 'nvenc failed' }, 'cpu', true),
    false
  );
});

test('runConversionQueue sequential statuses and cpu fallback', async () => {
  let attempt = 0;
  const snapshots = [];
  const result = await runConversionQueue(
    {
      inputPaths: ['/tmp/a.mp4', '/tmp/b.mp4'],
      presetId: 'h264-quality',
      gpu: 'nvidia',
      showDebugOutput: false,
    },
    {
      onSnapshot: (s) => snapshots.push(s),
      onProgress: () => {},
      convertOne: async ({ gpu }) => {
        attempt += 1;
        if (gpu === 'nvidia' && attempt === 1) {
          return {
            success: false,
            outputPath: '',
            error: 'nvenc init failed',
            retryWithCpuSuggested: true,
          };
        }
        return { success: true, outputPath: `/out/${attempt}.mp4` };
      },
      shouldRetryWithCpu,
      hasVideoCodec: true,
      isCancelled: () => false,
    }
  );

  assert.equal(result.total, 2);
  assert.equal(result.active, false);
  assert.equal(result.items[0].status, 'done');
  assert.equal(result.items[0].usedCpuFallback, true);
  assert.equal(result.items[1].status, 'done');
  assert.ok(snapshots.length >= 3);
});

test('runConversionQueue cancels pending items when isCancelled before next file', async () => {
  let index = 0;
  const result = await runConversionQueue(
    {
      inputPaths: ['/tmp/a.mp4', '/tmp/b.mp4'],
      presetId: 'h264-quality',
      gpu: 'cpu',
      showDebugOutput: false,
    },
    {
      onSnapshot: () => {},
      onProgress: () => {},
      convertOne: async () => {
        index += 1;
        return { success: true, outputPath: `/out/${index}.mp4` };
      },
      shouldRetryWithCpu,
      hasVideoCodec: true,
      isCancelled: () => index >= 1,
    }
  );

  assert.equal(result.items[0].status, 'done');
  assert.equal(result.items[1].status, 'cancelled');
});

test('runConversionQueue cancels remainder after a cancelled item', async () => {
  let index = 0;
  const result = await runConversionQueue(
    {
      inputPaths: ['/tmp/a.mp4', '/tmp/b.mp4', '/tmp/c.mp4'],
      presetId: 'h264-quality',
      gpu: 'cpu',
      showDebugOutput: false,
    },
    {
      onSnapshot: () => {},
      onProgress: () => {},
      convertOne: async () => {
        index += 1;
        if (index === 1) {
          return { success: true, outputPath: '/out/1.mp4' };
        }
        return { success: false, outputPath: '', error: 'Conversion cancelled' };
      },
      shouldRetryWithCpu,
      hasVideoCodec: true,
      isCancelled: () => false,
    }
  );

  assert.equal(result.items[0].status, 'done');
  assert.equal(result.items[1].status, 'cancelled');
  assert.equal(result.items[2].status, 'cancelled');
  assert.equal(result.active, false);
});

test('createEmptyQueueSnapshot defaults', () => {
  const empty = createEmptyQueueSnapshot();
  assert.equal(empty.active, false);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
});
