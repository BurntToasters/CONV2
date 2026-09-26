const test = require('node:test');
const assert = require('node:assert/strict');
const { describeFFmpegFailure, ffmpegErrorDetail } = require('../dist/main/ffmpegFailure.js');

// Failure modes for turning FFmpeg stderr into a message a user can act on.
// Samples are real FFmpeg 9.0.2 stderr tails. Written before ffmpegFailure.ts.

const BANNER = [
  'ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers',
  '  built with Apple clang version 21.0.0 (clang-2100.3.34.2)',
  '  configuration: --prefix=/opt/homebrew/Cellar/ffmpeg-full/9.0.2 --enable-gpl',
  '  libavutil      61.  1.102 / 61.  1.102',
].join('\n');

const SAMPLES = {
  corrupt: `${BANNER}
[in#0 @ 0x7717060000] Format mov,mp4,m4a,3gp,3g2,mj2 detected only with low score of 1, misdetection possible!
[in#0 @ 0x7717060000] moov atom not found
[in#0 @ 0x7717060000] Error opening input: Invalid data found when processing input
Error opening input file /Users/someone/Videos/corrupt.mp4.
Error opening input files: Invalid data found when processing input`,
  noVideo: `${BANNER}
Stream map '' matches no streams.
To ignore this, add a trailing '?' to the map.
Failed to set value '0:v:0' for option 'map': Invalid argument
Error parsing options for output file o2.mp4.
Error opening output files: Invalid argument`,
  missing: `[in#0 @ 0x79d5048000] Error opening input: No such file or directory
Error opening input file nope.mp4.
Error opening input files: No such file or directory`,
  unknownEncoder: `[vost#0:0 @ 0x7abf08c000] Unknown encoder 'libsvtav1'
[vost#0:0 @ 0x7abf08c000] Error selecting an encoder
Error opening output file o4.mp4.
Error opening output files: Encoder not found`,
  readOnlyOutput: `[out#0/mp4 @ 0x7c4ec603c0] Error opening output /Volumes/Share/o5.mp4: Permission denied
Error opening output file /Volumes/Share/o5.mp4.
Error opening output files: Permission denied`,
  containerMismatch: `[webm @ 0x7977047700] Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM.
[out#0/webm @ 0x79770943c0] Could not write header (incorrect codec parameters ?): Invalid argument
Conversion failed!`,
  diskFull: `[out#0/mp4 @ 0x7c4ec603c0] Error writing trailer: No space left on device
[aost#0:1/aac @ 0x7c4ec60a00] Error submitting a packet to the muxer: No space left on device
Conversion failed!`,
  encoderOpen: `[h264_nvenc @ 0x600] OpenEncodeSessionEx failed: unsupported device (2): (no details)
[vost#0:0/h264_nvenc @ 0x600] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
Conversion failed!`,
  unknown: `${BANNER}
[matroska @ 0x1] Something exotic went wrong in the demuxer state machine
Conversion failed!`,
};

const RAW = /ffmpeg version|configuration:|libavutil|0x[0-9a-f]{4,}|\[in#|\[out#|\[vost#/i;

test('damaged or non-media input says the file could not be read', () => {
  assert.match(describeFFmpegFailure(SAMPLES.corrupt), /couldn.t read this file.*damaged/i);
});

test('missing video stream says there is no video and points to Audio presets', () => {
  const message = describeFFmpegFailure(SAMPLES.noVideo);
  assert.match(message, /no video/i);
  assert.match(message, /audio preset/i);
});

test('missing input file, permission, and full disk each get their own message', () => {
  assert.match(describeFFmpegFailure(SAMPLES.missing), /could not be found/i);
  assert.match(describeFFmpegFailure(SAMPLES.readOnlyOutput), /permission/i);
  assert.match(describeFFmpegFailure(SAMPLES.diskFull), /full|space/i);
});

test('missing encoder names the encoder', () => {
  assert.match(describeFFmpegFailure(SAMPLES.unknownEncoder), /libsvtav1/);
});

test('container that cannot hold a stream suggests MKV', () => {
  assert.match(describeFFmpegFailure(SAMPLES.containerMismatch), /MKV/);
});

test('encoder start failure suggests CPU encoding', () => {
  assert.match(describeFFmpegFailure(SAMPLES.encoderOpen), /CPU/);
});

test('unknown failures fall back to the last meaningful FFmpeg line, not the banner', () => {
  const message = describeFFmpegFailure(SAMPLES.unknown);
  assert.match(message, /Something exotic went wrong/);
});

test('no message leaks banner text, pointer addresses, or stream tags', () => {
  for (const [name, sample] of Object.entries(SAMPLES)) {
    const message = describeFFmpegFailure(sample);
    assert.doesNotMatch(message, RAW, `${name}: ${message}`);
    assert.ok(message.length <= 200, `${name} too long: ${message.length}`);
  }
});

test('empty or whitespace stderr still returns a usable message', () => {
  for (const input of ['', '   \n\n', undefined]) {
    assert.match(describeFFmpegFailure(input), /\w{3,}/);
  }
});

test('detail keeps the tail of real errors and drops the banner', () => {
  const detail = ffmpegErrorDetail(SAMPLES.corrupt);
  assert.match(detail, /moov atom not found/);
  assert.doesNotMatch(detail, /ffmpeg version|configuration:|libavutil/);
  const long = `${BANNER}\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}`;
  const tail = ffmpegErrorDetail(long).split('\n');
  assert.ok(tail.length <= 40);
  assert.equal(tail.at(-1), 'line 199');
});
