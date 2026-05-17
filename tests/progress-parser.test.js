const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProgress } = require('../dist/main/ffmpeg.js');

test('parses a complete ffmpeg progress line', () => {
  const line =
    'frame=  123 fps=30.5 q=28.0 size=    1024kB time=00:00:05.00 bitrate=1234.5kbits/s speed=1.20x';
  const result = parseProgress(line, 10);
  assert.ok(result, 'returns progress object');
  assert.equal(result.frame, 123);
  assert.equal(result.fps, 30.5);
  assert.equal(result.time, '00:00:05.00');
  assert.equal(result.bitrate, '1234.5kbits');
  assert.equal(result.speed, '1.20x');
  assert.ok(Math.abs(result.percent - 50) < 0.001, 'percent ~50');
});

test('clamps percent to 100 when time exceeds duration', () => {
  const line = 'frame=1000 fps=60.0 time=00:00:20.00 bitrate=1000.0kbits/s speed=2.0x';
  const result = parseProgress(line, 10);
  assert.ok(result);
  assert.equal(result.percent, 100);
});

test('returns 0 percent when totalDuration is zero', () => {
  const line = 'frame=10 fps=10.0 time=00:00:01.00 bitrate=500.0kbits/s speed=1.0x';
  const result = parseProgress(line, 0);
  assert.ok(result);
  assert.equal(result.percent, 0);
});

test('returns null when no time field present', () => {
  const line = 'frame=1 fps=10.0 bitrate=100.0kbits/s speed=1.0x';
  assert.equal(parseProgress(line, 10), null);
});

test('returns null for unrelated stderr lines', () => {
  assert.equal(parseProgress('built with Apple clang version 15.0.0', 10), null);
  assert.equal(parseProgress('', 10), null);
  assert.equal(parseProgress('Stream #0:0(und): Video: h264', 10), null);
});

test('defaults to safe values when fields are missing', () => {
  const line = 'time=00:00:01.00';
  const result = parseProgress(line, 10);
  assert.ok(result);
  assert.equal(result.frame, 0);
  assert.equal(result.fps, 0);
  assert.equal(result.bitrate, 'N/A');
  assert.equal(result.speed, 'N/A');
});

test('handles hours, minutes, sub-second time correctly', () => {
  const line = 'frame=1 fps=1.0 time=01:30:45.50 bitrate=1.0kbits/s speed=1.0x';
  const result = parseProgress(line, 7200);
  assert.ok(result);
  const expectedSeconds = 1 * 3600 + 30 * 60 + 45.5;
  const expectedPercent = (expectedSeconds / 7200) * 100;
  assert.ok(Math.abs(result.percent - expectedPercent) < 0.001);
});

test('tolerates extra whitespace between key and value', () => {
  const line = 'frame=    7 fps=  10.00 time=    00:00:02.00 bitrate=  200.0kbits/s speed=  1.0x';
  const result = parseProgress(line, 4);
  assert.ok(result);
  assert.equal(result.frame, 7);
  assert.equal(result.fps, 10);
  assert.ok(Math.abs(result.percent - 50) < 0.001);
});

test('does not crash on malformed time field', () => {
  const line = 'time=garbage bitrate=1.0kbits/s';
  const result = parseProgress(line, 10);
  assert.ok(result === null || Number.isNaN(result.percent) || typeof result.percent === 'number');
});
