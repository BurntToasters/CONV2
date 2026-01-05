const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGPUError } = require('../dist/main/ffmpeg.js');

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
