const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGPUError, shouldRetryWithSoftwareDecode } = require('../dist/main/ffmpeg.js');

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
