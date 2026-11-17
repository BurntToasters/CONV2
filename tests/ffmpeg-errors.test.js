const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGPUError,
  shouldRetryWithSoftwareDecode,
  appendBoundedErrorOutput,
  redactPaths,
  MAX_FFPROBE_OUTPUT_BYTES,
  wouldExceedFFprobeOutputLimit,
} = require('../dist/main/ffmpeg.js');

test('detects NVIDIA encoder initialization errors', () => {
  const error = parseGPUError('No capable devices found', 'nvidia', 'h264');
  assert.ok(error);
  assert.equal(error.type, 'gpu_capability');
  assert.equal(error.canRetryWithCPU, true);
});

test('detects AMD AMF errors', () => {
  const error = parseGPUError('AMF failed', 'amd', 'h265', 'win32');
  assert.ok(error);
  assert.equal(error.type, 'gpu_capability');
});

test('detects Intel QSV errors', () => {
  const error = parseGPUError('QSV not found', 'intel', 'h264', 'win32');
  assert.ok(error);
  assert.equal(error.type, 'gpu_capability');
});

test('detects generic encoder not found errors', () => {
  const error = parseGPUError('Encoder abc not found', 'nvidia', 'h264');
  assert.ok(error);
  assert.equal(error.type, 'encoder_unavailable');
});

test('detects driver/library load errors', () => {
  const error = parseGPUError('LoadLibrary failed', 'nvidia', 'h264');
  assert.ok(error);
  assert.equal(error.type, 'driver_error');
});

test('returns null for unrelated errors', () => {
  const error = parseGPUError('Some unrelated error', 'nvidia', 'h264');
  assert.equal(error, null);
});

test('shouldRetryWithSoftwareDecode returns false for corrupted input files', () => {
  const moovError =
    '[mov,mp4,m4a,3gp,3g2,mj2 @ 0000019fc4c070c0] moov atom not found\n' +
    '[in#0 @ 0000019fc4bfc940] Error opening input: Invalid data found when processing input\n' +
    'Error opening input file test.mp4.\n' +
    'Error opening input files: Invalid data found when processing input';
  assert.equal(shouldRetryWithSoftwareDecode(moovError), false);
});

test('shouldRetryWithSoftwareDecode returns false for permission denied', () => {
  assert.equal(shouldRetryWithSoftwareDecode('permission denied: test.mp4'), false);
});

test('shouldRetryWithSoftwareDecode returns false for missing file', () => {
  assert.equal(shouldRetryWithSoftwareDecode('No such file or directory'), false);
});

test('shouldRetryWithSoftwareDecode returns true for hwaccel failures', () => {
  assert.equal(shouldRetryWithSoftwareDecode('hwaccel initialisation failed'), true);
});

test('shouldRetryWithSoftwareDecode returns true for device setup failures', () => {
  assert.equal(shouldRetryWithSoftwareDecode('device setup failed for decoder'), true);
});

test('shouldRetryWithSoftwareDecode does not false-positive on ffmpeg config string', () => {
  const configOutput =
    'configuration: --enable-vaapi --enable-amf --enable-libvpl --enable-ffnvcodec\n' +
    'Conversion error: out of memory';
  assert.equal(shouldRetryWithSoftwareDecode(configOutput), false);
});

// ── appendBoundedErrorOutput ────────────────────────────────────────────────

const MAX = 256 * 1024;

test('appendBoundedErrorOutput: returns combined string when under limit', () => {
  assert.equal(appendBoundedErrorOutput('hello ', 'world'), 'hello world');
});

test('appendBoundedErrorOutput: returns current unchanged when nextChunk is empty', () => {
  assert.equal(appendBoundedErrorOutput('existing', ''), 'existing');
});

test('appendBoundedErrorOutput: truncates to MAX_ERROR_OUTPUT_CHARS from the tail', () => {
  const a = 'a'.repeat(MAX);
  const b = 'b'.repeat(1000);
  const result = appendBoundedErrorOutput(a, b);
  assert.equal(result.length, MAX);
  assert.ok(result.endsWith('b'.repeat(1000)), 'result ends with newest chunk');
});

test('appendBoundedErrorOutput: exact boundary produces MAX-length result', () => {
  const a = 'x'.repeat(MAX - 1);
  const b = 'y';
  const result = appendBoundedErrorOutput(a, b);
  assert.equal(result.length, MAX);
});

test('appendBoundedErrorOutput: does not split a UTF-16 surrogate pair', () => {
  // U+1F600 😀 = surrogate pair 😀 = 2 code units
  // Place it so the default cut point lands on the low surrogate (\uDE00)
  const emoji = '😀';
  const filler = 'x'.repeat(MAX - 1);
  const combined = filler + emoji; // length = MAX + 1
  // Call with empty current so combined is the full string
  const result = appendBoundedErrorOutput('', combined);
  // Must not start with a lone low surrogate
  const first = result.charCodeAt(0);
  assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'result must not start with lone low surrogate');
});

// ── redactPaths ─────────────────────────────────────────────────────────────

const os = require('os');
const HOME = os.homedir();

test('redactPaths: replaces home directory prefix with ~', () => {
  const input = `Running command: ffmpeg -i ${HOME}/Videos/input.mp4 ${HOME}/Videos/output.mp4`;
  const result = redactPaths(input);
  assert.ok(!result.includes(HOME), 'home dir should be redacted');
  assert.ok(result.includes('~/Videos/input.mp4'), 'path should use ~');
});

test('redactPaths: returns string unchanged when no home dir present', () => {
  const input = 'frame=100 fps=30 time=00:00:03.33 bitrate=500kbits/s speed=1.0x';
  assert.equal(redactPaths(input), input);
});

test('redactPaths: handles multiple occurrences of home dir in one string', () => {
  const input = `Input: ${HOME}/in.mp4 Output: ${HOME}/out.mp4`;
  const result = redactPaths(input);
  assert.equal(result, 'Input: ~/in.mp4 Output: ~/out.mp4');
});

test('ffprobe output limit accepts the boundary and rejects overflow', () => {
  assert.equal(wouldExceedFFprobeOutputLimit(0, MAX_FFPROBE_OUTPUT_BYTES), false);
  assert.equal(wouldExceedFFprobeOutputLimit(MAX_FFPROBE_OUTPUT_BYTES - 1, 1), false);
  assert.equal(wouldExceedFFprobeOutputLimit(MAX_FFPROBE_OUTPUT_BYTES, 1), true);
});

// Failure modes for VAAPI error reporting. Written before the change.
//  - a libva initialisation failure falls through to a generic message with no driver hint
//  - the Intel message names no driver package, or the AMD one names the wrong package
//  - the banner's "--enable-vaapi" configuration string is read as a failure
//  - a VAAPI message on an NVIDIA conversion is claimed as a VAAPI error
//  - libva's informational lines are read as a missing library

const VAAPI_INIT_FAILURES = [
  'Failed to initialise VAAPI connection: -1 (unknown libva error).',
  'vaInitialize failed: unknown libva error',
  'No VA display found for device /dev/dri/renderD128.',
  "Failed to create a VAAPI device for '/dev/dri/renderD128'.",
  'libva.so.2: cannot open shared object file: No such file or directory',
];

test('VAAPI initialisation failures on Intel name the Intel driver packages', () => {
  for (const line of VAAPI_INIT_FAILURES) {
    const error = parseGPUError(line, 'intel', 'h264');
    assert.ok(error, line);
    assert.equal(error.type, 'gpu_capability', line);
    assert.equal(error.canRetryWithCPU, true, line);
    assert.match(error.details, /intel-media-va-driver/, line);
    assert.match(error.details, /intel-media-driver/, line);
    assert.match(error.details, /libva2/, line);
  }
});

test('VAAPI initialisation failures on AMD name the Mesa VA driver package', () => {
  for (const line of VAAPI_INIT_FAILURES) {
    const error = parseGPUError(line, 'amd', 'av1');
    assert.ok(error, line);
    assert.match(error.details, /mesa-va-drivers/, line);
    assert.match(error.details, /libva2/, line);
    assert.doesNotMatch(error.details, /intel-media/, line);
  }
});

test('the FFmpeg banner mentioning --enable-vaapi is not a failure', () => {
  const banner = 'configuration: --enable-vaapi --enable-amf --enable-libvpl --enable-ffnvcodec\n';
  assert.equal(parseGPUError(banner, 'intel', 'h264'), null);
  assert.equal(parseGPUError(banner, 'amd', 'h264'), null);
});

test('libva informational lines are not treated as failures', () => {
  const info =
    'libva info: VA-API version 1.20.0\nlibva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so\n';
  assert.equal(parseGPUError(info, 'intel', 'h264'), null);
});

test('VAAPI messages on an NVIDIA conversion are not claimed as VAAPI errors', () => {
  assert.equal(parseGPUError('vaInitialize failed: unknown libva error', 'nvidia', 'h264'), null);
});

// Failure modes for VAAPI runtime errors and platform wording. Written before the change.
//  - a runtime VAAPI failure (profile, RC mode, surface, va* call) is unrecognised, so no CPU retry
//  - a Linux AMD or Intel error keeps the Windows AMF or Quick Sync wording
//  - a VAAPI-platform error matching neither VAAPI pattern returns AMF/QSV text instead of null
//  - AMF and Quick Sync wording is lost on Windows
//  - the banner's --enable-vaapi string is read as a runtime failure

const VAAPI_RUNTIME_FAILURES = [
  '[h264_vaapi @ 0x1] No usable encoding profile found.',
  '[h264_vaapi @ 0x1] Driver does not support the required rate control mode.',
  '[h264_vaapi @ 0x1] Driver does not support CQP RC mode.',
  '[h264_vaapi @ 0x1] Failed to upload frame: -1 (operation failed).',
  '[hevc_vaapi @ 0x2] Failed to create surface: 2 (resource allocation failed).',
  'Failed to create context: 1 (operation failed).',
  '[h264_vaapi @ 0x1] vaBeginPicture failed: 1 (operation failed).',
  'vaRenderPicture failed: 5',
  'vaEndPicture failed: 1',
  'vaCreateContext failed: 4',
  'vaCreateSurfaces failed: 2',
];

test('VAAPI runtime failures on Linux Intel and AMD are retryable capability errors', () => {
  for (const gpu of ['intel', 'amd']) {
    for (const line of VAAPI_RUNTIME_FAILURES) {
      const error = parseGPUError(line, gpu, 'h264', 'linux');
      assert.ok(error, `${gpu}: ${line}`);
      assert.equal(error.type, 'gpu_capability', `${gpu}: ${line}`);
      assert.equal(error.canRetryWithCPU, true, `${gpu}: ${line}`);
      assert.match(error.message, /VAAPI/, `${gpu}: ${line}`);
      assert.doesNotMatch(error.details, /RX 7000|Quick Sync/, `${gpu}: ${line}`);
      assert.match(error.suggestion, /CPU/, `${gpu}: ${line}`);
    }
  }
});

test('VAAPI platforms never receive AMF or Quick Sync wording', () => {
  assert.equal(parseGPUError('AMF failed', 'amd', 'h265', 'linux'), null);
  assert.equal(parseGPUError('not supported by the driver', 'amd', 'av1', 'linux'), null);
  assert.equal(parseGPUError('QSV not found', 'intel', 'h264', 'linux'), null);
});

test('Windows AMF and Quick Sync wording is unchanged', () => {
  const amf = parseGPUError('AMF failed', 'amd', 'h265', 'win32');
  assert.ok(amf);
  assert.match(amf.details, /AMF/);

  const av1 = parseGPUError('not supported', 'amd', 'av1', 'win32');
  assert.ok(av1);
  assert.match(av1.details, /RX 7000/);

  const qsv = parseGPUError('QSV not found', 'intel', 'h264', 'win32');
  assert.ok(qsv);
  assert.match(qsv.message, /Quick Sync/);
});

test('the --enable-vaapi banner is not a runtime failure', () => {
  assert.equal(
    parseGPUError('configuration: --enable-vaapi --enable-libvpl\n', 'amd', 'h264', 'linux'),
    null
  );
});

// Failure modes for Media Foundation errors. Written before the change.
//  - a Qualcomm Media Foundation failure is unrecognised, so no CPU retry is offered
//  - the Media Foundation pattern fires for NVIDIA, AMD or Intel and gives Qualcomm driver advice
//  - the generic DLL branch wins over the Media Foundation branch for mfplat.dll failures
//  - a success-path INFO line such as "MFT name:" is treated as a failure

const MF_FAILURE_LINES = [
  'could not find any MFT for the given media type',
  'could not set input type (-2147024809)',
  'could not set output type (-2147024809)',
  'format negotiation failed (1/2)',
  'hardware MFT is not async',
  'could not start streaming (-2147467259)',
  'Failed to set D3D manager: 0x80004005',
];

test('Qualcomm Media Foundation failures offer a driver update and CPU retry', () => {
  for (const line of MF_FAILURE_LINES) {
    const error = parseGPUError(line, 'qualcomm', 'h265');
    assert.ok(error, line);
    assert.equal(error.type, 'gpu_capability', line);
    assert.equal(error.canRetryWithCPU, true, line);
    assert.match(error.message, /Qualcomm Media Foundation/, line);
    assert.match(error.suggestion, /driver/i, line);
  }
});

test('mfplat.dll load failures are Media Foundation errors for Qualcomm', () => {
  const error = parseGPUError('DLL mfplat.dll failed to open', 'qualcomm', 'av1');
  assert.ok(error);
  assert.match(error.message, /Qualcomm Media Foundation/);
  assert.notEqual(error.type, 'driver_error');
});

test('Media Foundation strings do not change errors for other vendors', () => {
  for (const vendor of ['nvidia', 'amd', 'intel', 'apple']) {
    assert.equal(
      parseGPUError('could not find any MFT for the given media type', vendor, 'h264'),
      null,
      vendor
    );
  }
});

test('the success-path MFT name line is not an error for Qualcomm', () => {
  assert.equal(parseGPUError("MFT name: 'Qualcomm H.264 Encoder'", 'qualcomm', 'h264'), null);
});
