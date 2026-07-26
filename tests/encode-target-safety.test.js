const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getQualityArgs,
  resolveEncodeVendor,
  isTextSubtitleCodec,
  presets,
} = require('../dist/main/presets');
const { GPU_ENCODERS } = require('../dist/main/gpuEncoders');
const { getRemuxIncompatibilityReason } = require('../dist/main/ffmpeg');

// ── Encoder map single source of truth ──────────────────────────────────────

test('preset argument building resolves encoders from the shared map', () => {
  // A second copy of this map would let the capability probe validate one
  // encoder while the conversion invokes a different one.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'presets.ts'), 'utf8');
  assert.match(source, /import \{ GPU_ENCODERS \} from '\.\/gpuEncoders'/);
  assert.doesNotMatch(source, /nvidia: 'h264_nvenc'/, 'encoder names must not be redeclared');
  assert.doesNotMatch(source, /cpu: 'libx264'/, 'encoder names must not be redeclared');
});

test('every preset encoder name comes from GPU_ENCODERS', () => {
  const known = new Set(Object.values(GPU_ENCODERS).flatMap((byVendor) => Object.values(byVendor)));
  for (const preset of presets) {
    for (const gpu of ['nvidia', 'amd', 'intel', 'apple', 'cpu']) {
      const args = preset.getArgs('in.mp4', `out.${preset.extension}`, gpu);
      const codecIdx = args.indexOf('-c:v');
      if (codecIdx === -1) continue;
      assert.ok(
        known.has(args[codecIdx + 1]),
        `${preset.id}/${gpu}: encoder ${args[codecIdx + 1]} is not in GPU_ENCODERS`
      );
    }
  }
});

// ── Vendor fallback ─────────────────────────────────────────────────────────

test('a vendor without a hardware encoder resolves to CPU', () => {
  // Apple has no AV1 encoder, so av1/apple maps to libsvtav1.
  assert.equal(resolveEncodeVendor('av1', 'apple'), 'cpu');
  assert.equal(resolveEncodeVendor('h264', 'apple'), 'apple');
  assert.equal(resolveEncodeVendor('h265', 'nvidia'), 'nvidia');
  assert.equal(resolveEncodeVendor('av1', 'cpu'), 'cpu');
});

test('Apple AV1 gets CPU arguments, never VideoToolbox flags', () => {
  // Emitting -q:v/-allow_sw/-realtime for libsvtav1 would fail the encode.
  const args = getQualityArgs('apple', 30, 'av1');
  assert.deepEqual(args, ['-crf', '30']);

  const preset = presets.find((p) => p.id === 'av1-balanced');
  const presetArgs = preset.getArgs('in.mp4', 'out.mp4', 'apple');
  assert.equal(presetArgs.includes('-allow_sw'), false);
  assert.equal(presetArgs.includes('-realtime'), false);
  assert.ok(presetArgs.includes('-crf'), 'should use CRF like any CPU encode');
  assert.ok(presetArgs.includes('-svtav1-params'), 'should apply SVT-AV1 tuning');
});

// ── Quality range clamping ──────────────────────────────────────────────────

test('hardware encoders never receive a QP above 51', () => {
  // AV1 tiers allow up to 63 for libsvtav1's CRF range, but NVENC -cq,
  // AMF -qp_i/-qp_p and QSV -global_quality are 0-51 scales and reject 52+.
  const nvidia = getQualityArgs('nvidia', 63, 'av1');
  assert.equal(nvidia[nvidia.indexOf('-cq') + 1], '51');

  const amd = getQualityArgs('amd', 63, 'av1');
  assert.equal(amd[amd.indexOf('-qp_i') + 1], '51');
  assert.equal(amd[amd.indexOf('-qp_p') + 1], '51');

  const intel = getQualityArgs('intel', 63, 'av1');
  assert.equal(intel[intel.indexOf('-global_quality') + 1], '51');
});

test('CPU encoders keep the full requested CRF range', () => {
  assert.deepEqual(getQualityArgs('cpu', 63, 'av1'), ['-crf', '63']);
  assert.deepEqual(getQualityArgs('cpu', 18, 'h264'), ['-crf', '18']);
});

test('Apple quality mapping stays inside VideoToolbox bounds', () => {
  for (const quality of [1, 18, 51, 63]) {
    const args = getQualityArgs('apple', quality, 'h264');
    const value = Number(args[args.indexOf('-q:v') + 1]);
    assert.ok(value >= 1 && value <= 100, `q:v ${value} out of range for quality ${quality}`);
  }
});

test('in-range hardware quality values are passed through unchanged', () => {
  const args = getQualityArgs('nvidia', 24, 'h265');
  assert.equal(args[args.indexOf('-cq') + 1], '24');
});

// ── Remux preflight ─────────────────────────────────────────────────────────

test('WebM remux rejects audio the container cannot store', () => {
  // Measured against the bundled build: WebM copies only Opus/Vorbis audio.
  const reason = getRemuxIncompatibilityReason('vp9', 'webm', 'aac');
  assert.match(reason, /AAC audio/);
  assert.match(reason, /Opus or Vorbis/);
});

test('WebM remux accepts supported audio', () => {
  assert.equal(getRemuxIncompatibilityReason('vp9', 'webm', 'opus'), null);
  assert.equal(getRemuxIncompatibilityReason('av1', 'webm', 'vorbis'), null);
});

test('WebM video check still applies and takes precedence', () => {
  const reason = getRemuxIncompatibilityReason('h264', 'webm', 'aac');
  assert.match(reason, /VP8, VP9, or AV1 video/);
});

test('MP4 remux accepts the audio codecs the muxer supports', () => {
  // All of these were verified to copy into MP4 with the bundled build.
  for (const audio of ['aac', 'mp3', 'ac3', 'eac3', 'flac', 'opus', 'vorbis', 'alac']) {
    assert.equal(getRemuxIncompatibilityReason('h264', 'mp4', audio), null, `mp4 + ${audio}`);
  }
});

test('MP4 remux still rejects incompatible video', () => {
  assert.match(getRemuxIncompatibilityReason('vp9', 'mp4', 'aac'), /MP4 container/);
});

test('unknown or missing codecs do not block a remux', () => {
  assert.equal(getRemuxIncompatibilityReason(undefined, 'webm', undefined), null);
  assert.equal(getRemuxIncompatibilityReason('unknown', 'webm', 'unknown'), null);
  assert.equal(getRemuxIncompatibilityReason('vp9', 'webm', ''), null);
});

// ── Subtitle classification ─────────────────────────────────────────────────

test('text and bitmap subtitle codecs are distinguished', () => {
  for (const codec of ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'SubRip']) {
    assert.equal(isTextSubtitleCodec(codec), true, `${codec} should be text`);
  }
  for (const codec of ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', undefined, '']) {
    assert.equal(isTextSubtitleCodec(codec), false, `${codec} should not be text`);
  }
});

// ── MP4 container tagging ───────────────────────────────────────────────────

const { ensureMp4PlaybackCompatibilityArgs } = require('../dist/main/ffmpeg');

test('HEVC remuxed into MP4 gets the hvc1 tag Apple players require', () => {
  // Without it the stream is tagged hev1, which QuickTime/Safari/iOS will not play.
  const preset = presets.find((p) => p.id === 'remux-mp4');
  const args = ensureMp4PlaybackCompatibilityArgs(
    preset,
    preset.getArgs('in.mkv', 'out.mp4', 'cpu', { sourceStreams: { videoCodec: 'hevc' } }),
    'hevc'
  );
  assert.equal(args[args.indexOf('-tag:v') + 1], 'hvc1');
  assert.ok(args.includes('+faststart'));
  assert.equal(args[args.length - 1], 'out.mp4', 'output must stay last');
});

test('non-HEVC remuxes are not mistagged', () => {
  const preset = presets.find((p) => p.id === 'remux-mp4');
  for (const codec of ['h264', 'av1', undefined]) {
    const args = ensureMp4PlaybackCompatibilityArgs(
      preset,
      preset.getArgs('in.mkv', 'out.mp4', 'cpu', { sourceStreams: { videoCodec: codec } }),
      codec
    );
    assert.equal(args.includes('-tag:v'), false, `${codec} must not be tagged hvc1`);
  }
});

test('H.265 encode presets still get the hvc1 tag', () => {
  const preset = presets.find((p) => p.id === 'h265-balanced');
  const args = ensureMp4PlaybackCompatibilityArgs(
    preset,
    preset.getArgs('in.mp4', 'out.mp4', 'cpu'),
    'h264'
  );
  assert.equal(args[args.indexOf('-tag:v') + 1], 'hvc1');
});

test('MKV remux is left untouched by MP4 compatibility handling', () => {
  const preset = presets.find((p) => p.id === 'remux-mkv');
  const original = preset.getArgs('in.mkv', 'out.mkv', 'cpu');
  assert.deepEqual(ensureMp4PlaybackCompatibilityArgs(preset, original, 'hevc'), original);
});

// ── GIF palette bounds ──────────────────────────────────────────────────────

const { normalizeGifTierSettings } = require('../dist/main/advancedFormats');

test('GIF colour count is clamped to a value palettegen accepts', () => {
  // FFmpeg rejects max_colors=2 outright: "only allowed without reserving a
  // transparent color slot". palettegen reserves that slot by default, and the
  // transparency is what lets static regions compress, so the floor is 3.
  const fallback = { fps: 12, maxDimension: 480, maxColors: 128, dither: 'bayer' };
  for (const requested of [-10, 0, 1, 2]) {
    const tier = normalizeGifTierSettings({ ...fallback, maxColors: requested }, fallback);
    assert.ok(tier.maxColors >= 3, `maxColors ${requested} clamped to ${tier.maxColors}`);
  }
  assert.equal(normalizeGifTierSettings({ ...fallback, maxColors: 3 }, fallback).maxColors, 3);
  assert.equal(normalizeGifTierSettings({ ...fallback, maxColors: 999 }, fallback).maxColors, 256);
});

test('the GIF colour inputs advertise the same floor as the clamp', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const colourInputs = [...html.matchAll(/id="gif\w*MaxColors"\s+min="(\d+)"\s+max="(\d+)"/g)];
  assert.equal(colourInputs.length, 4, 'expected one colour input per GIF tier');
  for (const [, min, max] of colourInputs) {
    assert.equal(min, '3', 'UI must not offer a colour count FFmpeg rejects');
    assert.equal(max, '256');
  }
});

test('shipped GIF defaults are inside the accepted range', () => {
  const { createDefaultGifAdvancedSettings } = require('../dist/main/advancedFormats');
  for (const [name, tier] of Object.entries(createDefaultGifAdvancedSettings().tiers)) {
    assert.ok(tier.maxColors >= 3 && tier.maxColors <= 256, `${name}: ${tier.maxColors}`);
    assert.ok(tier.fps >= 1 && tier.fps <= 60, `${name}: fps ${tier.fps}`);
  }
});
