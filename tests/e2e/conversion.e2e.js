// Conversion matrix E2E: every preset plus edge-case sources through the real IPC path
// (start-conversion-queue -> performSingleConversion -> convertVideo) inside Electron.
// Artifact: coverage/e2e/conversion-matrix.json (input, preset, outcome, ffprobe of output).
//
// Failure modes pinned here:
//  - a preset's arguments are rejected by FFmpeg or produce the wrong codec/container/tag
//  - audio-only input into a video preset fails with raw FFmpeg text instead of "no video"
//  - unreadable input produces a cryptic error
//  - rotated phone video comes out sideways
//  - HDR10 into 8-bit H.264 keeps PQ transfer tags (washed-out, wrong on SDR players)
//  - HDR10 into CPU H.265 loses 10-bit or HDR tags
//  - 5.1 audio breaks the Opus/AAC encoders
//  - MKV text subtitles break MP4 remux; WebM remux of AAC is not explained up front
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchApp, returningUserSettings } = require('./app.js');
const {
  FFMPEG,
  ffmpegSkipReason,
  createFixtures,
  mkTemp,
  probe,
  writeArtifact,
} = require('./helpers.js');

const skip = ffmpegSkipReason();
const matrix = [];
let ctx;
let fixtures;
let fixtureDir;
let outDir;

before(async () => {
  if (skip) return;
  fixtureDir = mkTemp('matrix-fixtures');
  outDir = mkTemp('matrix-out');
  fixtures = createFixtures(fixtureDir);
  ctx = await launchApp({ settings: returningUserSettings(), label: 'matrix' });
  await ctx.window
    .locator('#presetCardList .preset-card')
    .first()
    .waitFor({ state: 'attached', timeout: 20_000 });
});

after(async () => {
  if (ctx) await ctx.close();
  writeArtifact('conversion-matrix.json', {
    at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    ffmpeg: FFMPEG && { source: FFMPEG.source, version: FFMPEG.version },
    cases: matrix,
  });
  for (const dir of [fixtureDir, outDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function convert(input, presetId, gpu = 'cpu') {
  const started = Date.now();
  const snapshot = await ctx.window.evaluate(
    (payload) => window.electronAPI.startConversionQueue(payload),
    { inputPaths: [input], presetId, gpu, outputDirectory: outDir }
  );
  const item = snapshot.items[0];
  const entry = {
    input: path.basename(input),
    presetId,
    gpu,
    status: item.status,
    error: item.error,
    usedCpuFallback: item.usedCpuFallback === true,
    ms: Date.now() - started,
  };
  if (item.status === 'done') {
    entry.output = path.basename(item.outputPath);
    entry.bytes = fs.statSync(item.outputPath).size;
    entry.probe = probe(item.outputPath);
  }
  matrix.push(entry);
  return entry;
}

const expectDone = (entry) =>
  assert.equal(entry.status, 'done', `${entry.presetId} on ${entry.input}: ${entry.error}`);

const EXPECT = {
  av1: { videoCodec: 'av1', videoTag: 'av01' },
  h264: { videoCodec: 'h264', videoTag: 'avc1' },
  h265: { videoCodec: 'hevc', videoTag: 'hvc1' },
  avi: { formatName: 'avi' },
  gif: { videoCodec: 'gif' },
};
const AUDIO_CODEC = { 'audio-mp3': 'mp3', 'audio-aac': 'aac', 'audio-flac': 'flac' };

test('every preset converts the standard source', { skip, timeout: 900_000 }, async (t) => {
  const presets = await ctx.window.evaluate(() => window.electronAPI.getPresets());
  assert.ok(presets.length >= 20);
  for (const preset of presets) {
    await t.test(preset.id, async () => {
      const entry = await convert(fixtures.standard, preset.id);
      if (preset.id === 'remux-webm') {
        assert.equal(entry.status, 'failed');
        assert.match(entry.error, /WebM/i);
        return;
      }
      expectDone(entry);
      const info = entry.probe;
      const expected = EXPECT[preset.category];
      if (expected) {
        for (const [key, value] of Object.entries(expected)) assert.equal(info[key], value, key);
      }
      if (preset.category === 'audio') {
        assert.equal(info.videoCodec, undefined);
        assert.equal(info.audioCodec, AUDIO_CODEC[preset.id]);
      }
      if (preset.category === 'remux') assert.equal(info.videoCodec, 'h264');
      if (preset.category !== 'gif') assert.ok(info.duration > 1.5, `duration ${info.duration}`);
    });
  }
});

test(
  'audio-only source into a video preset says there is no video',
  { skip, timeout: 60_000 },
  async () => {
    const entry = await convert(fixtures.audioOnly, 'h264-fast');
    assert.equal(entry.status, 'failed');
    assert.match(entry.error, /no video/i, entry.error);
    expectDone(await convert(fixtures.audioOnly, 'audio-mp3'));
  }
);

test('unreadable source fails with a readable reason', { skip, timeout: 60_000 }, async () => {
  const entry = await convert(fixtures.corrupt, 'h264-fast');
  assert.equal(entry.status, 'failed');
  assert.match(entry.error, /couldn.t read|damaged|not a (?:supported )?video/i, entry.error);
});

test('rotated phone video stays upright', { skip, timeout: 120_000 }, async () => {
  for (const presetId of ['h264-fast', 'av1-balanced']) {
    const entry = await convert(fixtures.rotated, presetId);
    expectDone(entry);
    const { width, height, rotation } = entry.probe;
    const displayedPortrait = Math.abs(rotation) % 180 === 90 ? width > height : height > width;
    assert.ok(displayedPortrait, `${presetId}: ${width}x${height} rot ${rotation}`);
  }
});

test('HDR10 into 8-bit H.264 is tone-mapped to SDR', { skip, timeout: 120_000 }, async () => {
  const entry = await convert(fixtures.hdr10, 'h264-fast');
  expectDone(entry);
  assert.equal(entry.probe.pixFmt, 'yuv420p');
  assert.notEqual(entry.probe.colorTransfer, 'smpte2084');
  assert.equal(entry.probe.colorPrimaries, 'bt709');
});

test('HDR10 into AVI and GIF is tone-mapped too', { skip, timeout: 120_000 }, async () => {
  const avi = await convert(fixtures.hdr10, 'avi-balanced');
  expectDone(avi);
  assert.equal(avi.probe.pixFmt, 'yuv420p');
  assert.notEqual(avi.probe.colorTransfer, 'smpte2084');
  const gif = await convert(fixtures.hdr10, 'gif-balanced');
  expectDone(gif);
  assert.equal(gif.probe.videoCodec, 'gif');
});

test('HDR10 into CPU H.265 keeps 10-bit and HDR tags', { skip, timeout: 120_000 }, async () => {
  const entry = await convert(fixtures.hdr10, 'h265-quality');
  expectDone(entry);
  assert.equal(entry.probe.pixFmt, 'yuv420p10le');
  assert.equal(entry.probe.colorTransfer, 'smpte2084');
});

test('5.1 audio survives Opus (AV1) and AAC (H.264)', { skip, timeout: 120_000 }, async () => {
  for (const presetId of ['av1-balanced', 'h264-fast']) {
    const entry = await convert(fixtures.surround, presetId);
    expectDone(entry);
    assert.ok(entry.probe.audioChannels >= 2, `${presetId}: ${entry.probe.audioChannels} ch`);
  }
});

test('MKV text subtitles become mov_text in MP4 remux', { skip, timeout: 60_000 }, async () => {
  const entry = await convert(fixtures.subtitled, 'remux-mp4');
  expectDone(entry);
  assert.deepEqual(entry.probe.subtitleCodecs, ['mov_text']);
});

test(
  'Apple VideoToolbox H.264/H.265 encode on macOS',
  {
    skip: skip || (process.platform !== 'darwin' && 'macOS only'),
    timeout: 120_000,
  },
  async () => {
    const h264 = await convert(fixtures.standard, 'h264-fast', 'apple');
    expectDone(h264);
    assert.equal(h264.probe.videoTag, 'avc1');
    const h265 = await convert(fixtures.hdr10, 'h265-quality', 'apple');
    expectDone(h265);
    assert.equal(h265.probe.videoTag, 'hvc1');
  }
);
