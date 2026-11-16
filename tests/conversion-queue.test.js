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

test('runConversionQueue cancels every item when cancelled before the first convert', async () => {
  let calls = 0;
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
        calls += 1;
        return { success: true, outputPath: '/out/x.mp4' };
      },
      shouldRetryWithCpu,
      hasVideoCodec: true,
      isCancelled: () => true,
    }
  );

  assert.equal(calls, 0);
  assert.equal(result.items[0].status, 'cancelled');
  assert.equal(result.items[1].status, 'cancelled');
});

test('createEmptyQueueSnapshot defaults', () => {
  const empty = createEmptyQueueSnapshot();
  assert.equal(empty.active, false);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
});

// A bare "gpu" substring used to trigger CPU retries for unrelated failures.
test('shouldRetryWithCpu ignores unrelated text that merely contains "gpu"', () => {
  const unrelated = {
    success: false,
    outputPath: '',
    error: 'FFmpeg error: Invalid argument',
    errorDetail: 'Error opening output /Users/gpuser/out.mp4: Is a directory',
  };
  assert.equal(shouldRetryWithCpu(unrelated, 'nvidia', true), false);
});

test('shouldRetryWithCpu still retries real hardware failures found only in errorDetail', () => {
  const nvenc = {
    success: false,
    outputPath: '',
    error: 'The encoder could not start with these settings.',
    errorDetail: '[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2)',
  };
  assert.equal(shouldRetryWithCpu(nvenc, 'nvidia', true), true);
});

// Failure modes for VAAPI and Media Foundation CPU retries. Written before the change.
//  - a VAAPI runtime failure is not retried, because only NVENC/AMF/QSV markers exist
//  - a Media Foundation runtime failure is not retried on Windows on Arm
//  - the banner's --enable-vaapi alone is treated as a retry reason
//  - an input error in the detail still wins over a VAAPI marker

const RETRYABLE_HARDWARE_ERRORS = [
  ['amd', 'No usable encoding profile found.'],
  ['intel', '[h264_vaapi @ 0x1] Driver does not support the required rate control mode.'],
  ['amd', '[h264_vaapi @ 0x1] Failed to upload frame: -1 (operation failed).'],
  ['intel', 'Failed to create surface: 2 (resource allocation failed).'],
  ['amd', 'vaBeginPicture failed: 1'],
  ['intel', 'vaCreateContext failed: 4'],
  ['qualcomm', 'could not find any MFT for the given media type'],
  ['qualcomm', 'format negotiation failed (1/2)'],
  ['qualcomm', 'hardware MFT is not async'],
  ['qualcomm', 'DLL mfplat.dll failed to open'],
];

test('shouldRetryWithCpu retries VAAPI and Media Foundation failures without a suggestion', () => {
  for (const [gpu, error] of RETRYABLE_HARDWARE_ERRORS) {
    const result = { success: false, outputPath: '', error };
    assert.equal(shouldRetryWithCpu(result, gpu, true), true, `${gpu}: ${error}`);
    assert.equal(result.retryWithCpuSuggested, undefined, `${gpu}: ${error}`);
  }
});

test('shouldRetryWithCpu keeps input errors ahead of VAAPI markers', () => {
  const result = {
    success: false,
    outputPath: '',
    error: 'Error opening input: Invalid data found when processing input',
    errorDetail: 'No usable encoding profile found.',
  };
  assert.equal(shouldRetryWithCpu(result, 'intel', true), false);
});

test('shouldRetryWithCpu ignores the --enable-vaapi banner', () => {
  const result = {
    success: false,
    outputPath: '',
    error: 'Conversion error: out of memory',
    errorDetail: 'configuration: --enable-vaapi --enable-libvpl --enable-ffnvcodec',
  };
  assert.equal(shouldRetryWithCpu(result, 'intel', true), false);
});

// Failure modes for the requested-GPU mapping. Written before the change.
//  - Linux AMD is still forced to CPU, so the AMD encoder never gets checked
//  - Apple AV1 stops mapping to CPU and receives VideoToolbox flags
//  - a CPU or unknown-codec request is turned into a GPU request

const { effectiveConversionGpu } = require('../dist/main/gpuEncoders.js');

test('effectiveConversionGpu keeps AMD on AMD and maps only Apple AV1 to CPU', () => {
  assert.equal(effectiveConversionGpu('amd', 'h264'), 'amd');
  assert.equal(effectiveConversionGpu('amd', 'h265'), 'amd');
  assert.equal(effectiveConversionGpu('intel', 'av1'), 'intel');
  assert.equal(effectiveConversionGpu('apple', 'av1'), 'cpu');
  assert.equal(effectiveConversionGpu('apple', 'h264'), 'apple');
  assert.equal(effectiveConversionGpu('cpu', null), 'cpu');
  assert.equal(effectiveConversionGpu('nvidia', null), 'nvidia');
});
