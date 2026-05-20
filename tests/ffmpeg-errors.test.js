const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGPUError,
  shouldRetryWithSoftwareDecode,
  appendBoundedErrorOutput,
  isKnownColorValue,
  redactPaths,
} = require('../dist/main/ffmpeg.js');

test('detects NVIDIA encoder initialization errors', () => {
  const error = parseGPUError('No capable devices found', 'nvidia', 'h264');
  assert.ok(error);
  assert.equal(error.type, 'gpu_capability');
  assert.equal(error.canRetryWithCPU, true);
});

test('detects AMD AMF errors', () => {
  const error = parseGPUError('AMF failed', 'amd', 'h265');
  assert.ok(error);
  assert.equal(error.type, 'gpu_capability');
});

test('detects Intel QSV errors', () => {
  const error = parseGPUError('QSV not found', 'intel', 'h264');
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

// ── isKnownColorValue ───────────────────────────────────────────────────────

test('isKnownColorValue: rejects ffprobe sentinel strings', () => {
  assert.equal(isKnownColorValue('unknown'), false);
  assert.equal(isKnownColorValue('unspecified'), false);
  assert.equal(isKnownColorValue('reserved'), false);
  assert.equal(isKnownColorValue(''), false);
});

test('isKnownColorValue: accepts real colour-space values', () => {
  assert.equal(isKnownColorValue('bt709'), true);
  assert.equal(isKnownColorValue('smpte170m'), true);
  assert.equal(isKnownColorValue('bt2020'), true);
  assert.equal(isKnownColorValue('smpte2084'), true);
  assert.equal(isKnownColorValue('arib-std-b67'), true);
  assert.equal(isKnownColorValue('tv'), true);
  assert.equal(isKnownColorValue('pc'), true);
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
