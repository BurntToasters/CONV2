/**
 * End-to-end preset verification against the bundled FFmpeg.
 *
 * The rest of the suite asserts the *shape* of the arguments CONV2 builds. This
 * file asserts that FFmpeg actually accepts them and produces the streams we
 * expect. That distinction matters: the MKV-to-MP4 subtitle failure shipped with
 * a fully green unit suite, because every test checked argument strings and none
 * ran a conversion.
 *
 * Skipped automatically when the bundled binaries are missing or are the
 * placeholder files CI uses for untrusted builds, so contributors without a
 * payload are never blocked. Set CONV2_REQUIRE_FFMPEG_TESTS=1 to turn a skip
 * into a failure (used on trusted CI branches, where the real payload exists).
 *
 * Known harness gap: this drives preset.getArgs plus the MP4 container fixes,
 * which is the pure argument pipeline. The colour-metadata and 10-bit pix_fmt
 * injection lives inline in convertVideo and needs the Electron runtime, so it
 * is not exercised here.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { presets, getPresetById, getPresetGpuCodec } = require('../dist/main/presets');
const {
  ensureMp4PlaybackCompatibilityArgs,
  getRemuxIncompatibilityReason,
} = require('../dist/main/ffmpeg');

const ROOT = path.join(__dirname, '..');

// ── Binary discovery ────────────────────────────────────────────────────────
// ffmpegPath.ts resolves these through Electron's app paths, which are not
// available under `node --test`, so the bundled layout is resolved directly.

const PLATFORM_DIR = { win32: 'win', darwin: 'mac', linux: 'linux' };
const ARCH_DIR = { x64: 'x64', arm64: 'arm64' };

function bundledBinary(name) {
  const platform = PLATFORM_DIR[process.platform];
  const arch = ARCH_DIR[process.arch];
  if (!platform || !arch) return null;
  const fileName = process.platform === 'win32' ? `${name}.exe` : name;
  const full = path.join(ROOT, 'resources', 'ffmpeg', platform, arch, fileName);
  return fs.existsSync(full) ? full : null;
}

/** Placeholder payloads exist as files but cannot execute, so probe for real. */
function isRunnable(binary) {
  if (!binary) return false;
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG = bundledBinary('ffmpeg');
const FFPROBE = bundledBinary('ffprobe');
const AVAILABLE = isRunnable(FFMPEG) && isRunnable(FFPROBE);
const ENFORCED = process.env.CONV2_REQUIRE_FFMPEG_TESTS === '1';
const skip = AVAILABLE
  ? false
  : 'bundled FFmpeg not executable (placeholder or missing payload); see resources/ffmpeg/README.md';

let work = '';
const fixtures = {};

const ffmpeg = (args) =>
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });

/** Mirrors getVideoInfo's stream extraction so preset context matches production. */
function probe(file) {
  const raw = execFileSync(
    FFPROBE,
    ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
  ).toString();
  const data = JSON.parse(raw);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    videoCodec: video?.codec_name,
    videoTag: video?.codec_tag_string,
    audioCodec: audio?.codec_name,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
    subtitleCodecs: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => s.codec_name || 'unknown'),
    attachments: streams.filter((s) => s.codec_type === 'attachment').length,
    duration: Number(data.format?.duration || 0),
  };
}

/** Builds arguments exactly as convertVideo does for a CPU conversion, then runs them. */
function runPreset(presetId, inputPath, outputName) {
  const preset = getPresetById(presetId);
  assert.ok(preset, `unknown preset ${presetId}`);
  const info = probe(inputPath);
  // Outputs are prefixed so they can never collide with a fixture path; writing
  // over an input would make later tests fail for the wrong reason.
  const output = path.join(work, `out_${outputName || `${presetId}.${preset.extension}`}`);
  assert.notEqual(path.resolve(output), path.resolve(inputPath), 'output must not overwrite input');
  fs.rmSync(output, { force: true });

  const args = ensureMp4PlaybackCompatibilityArgs(
    preset,
    preset.getArgs(inputPath, output, 'cpu', {
      sourceStreams: {
        videoCodec: info.videoCodec,
        audioCodec: info.audioCodec,
        subtitleCodecs: info.subtitleCodecs,
      },
    }),
    info.videoCodec
  );

  try {
    ffmpeg(args);
  } catch (err) {
    const stderr = String(err.stderr || err.message)
      .trim()
      .split('\n')
      .slice(-3)
      .join(' | ');
    assert.fail(`${presetId} failed: ${stderr}\n  args: ffmpeg ${args.join(' ')}`);
  }

  assert.ok(fs.existsSync(output), `${presetId} produced no output`);
  assert.ok(fs.statSync(output).size > 0, `${presetId} produced an empty file`);
  return { output, result: probe(output), source: info };
}

before(() => {
  if (!AVAILABLE) return;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-integration-'));

  // Small fixtures keep the suite quick while still exercising every code path.
  fixtures.base = path.join(work, 'base.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    fixtures.base,
  ]);

  // The regression fixture: h264 + aac + SubRip + an attachment, which is what
  // a typical downloaded MKV looks like and what used to break MP4 remux.
  const srt = path.join(work, 'sub.srt');
  const font = path.join(work, 'font.ttf');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nintegration\n\n');
  fs.writeFileSync(font, 'not-a-real-font');
  fixtures.subsMkv = path.join(work, 'subs.mkv');
  ffmpeg([
    '-i',
    fixtures.base,
    '-i',
    srt,
    '-attach',
    font,
    '-metadata:s:t',
    'mimetype=application/x-truetype-font',
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    '-c:s',
    'srt',
    fixtures.subsMkv,
  ]);

  fixtures.hevcMkv = path.join(work, 'hevc.mkv');
  ffmpeg(['-i', fixtures.base, '-c:v', 'libx265', '-crf', '30', '-c:a', 'aac', fixtures.hevcMkv]);

  fixtures.vp9Opus = path.join(work, 'vp9_opus.mkv');
  ffmpeg([
    '-i',
    fixtures.base,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '60k',
    '-c:a',
    'libopus',
    fixtures.vp9Opus,
  ]);

  fixtures.vp9Aac = path.join(work, 'vp9_aac.mkv');
  ffmpeg([
    '-i',
    fixtures.base,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '60k',
    '-c:a',
    'aac',
    fixtures.vp9Aac,
  ]);

  fixtures.twoAudio = path.join(work, 'two_audio.mkv');
  ffmpeg([
    '-i',
    fixtures.base,
    '-i',
    fixtures.base,
    '-map',
    '0:v',
    '-map',
    '0:a',
    '-map',
    '1:a',
    '-c',
    'copy',
    fixtures.twoAudio,
  ]);

  fixtures.tenBit = path.join(work, 'ten_bit.mkv');
  ffmpeg([
    '-i',
    fixtures.base,
    '-c:v',
    'libx265',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p10le',
    '-c:a',
    'aac',
    fixtures.tenBit,
  ]);
});

after(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

test('bundled FFmpeg is executable when integration tests are enforced', () => {
  if (!ENFORCED) return;
  assert.ok(AVAILABLE, 'CONV2_REQUIRE_FFMPEG_TESTS=1 but the bundled FFmpeg could not be executed');
});

// ── Every preset actually runs ───────────────────────────────────────────────

const EXPECTED_VIDEO_CODEC = { av1: 'av1', h264: 'h264', h265: 'hevc', avi: 'h264', gif: 'gif' };

test('every encoding preset completes and produces the expected codec', { skip }, async (t) => {
  const encodePresets = presets.filter((p) => p.category in EXPECTED_VIDEO_CODEC);
  assert.ok(encodePresets.length > 0);

  for (const preset of encodePresets) {
    await t.test(preset.id, () => {
      const { result } = runPreset(preset.id, fixtures.base);
      assert.equal(
        result.videoCodec,
        EXPECTED_VIDEO_CODEC[preset.category],
        `${preset.id} produced ${result.videoCodec}`
      );
      if (preset.category !== 'gif') {
        assert.ok(result.audioCodec, `${preset.id} lost the audio track`);
      } else {
        assert.equal(result.audioCodec, undefined, 'GIF output must not carry audio');
      }
    });
  }
});

test('audio extraction presets produce audio-only output', { skip }, async (t) => {
  const expected = { 'audio-mp3': 'mp3', 'audio-aac': 'aac', 'audio-flac': 'flac' };
  for (const [id, codec] of Object.entries(expected)) {
    await t.test(id, () => {
      const { result } = runPreset(id, fixtures.base);
      assert.equal(result.videoCodec, undefined, 'must not carry a video stream');
      assert.equal(result.audioCodec, codec);
    });
  }
});

test('audio extraction from a multi-audio source picks one stream', { skip }, () => {
  // The mp3 muxer accepts only a single audio stream; default selection must
  // narrow a two-track source down rather than failing.
  assert.equal(probe(fixtures.twoAudio).audioStreams, 2, 'fixture should have two audio tracks');
  const { result } = runPreset('audio-mp3', fixtures.twoAudio, 'multi.mp3');
  assert.equal(result.audioStreams, 1);
});

// ── Remux: the regression this suite exists for ──────────────────────────────

test('MKV with subtitles and an attachment remuxes to MP4', { skip }, () => {
  // Regression: copying SubRip into MP4 failed with "Could not find tag for
  // codec subrip", and -map 0 additionally dragged in an attachment MP4 rejects.
  const source = probe(fixtures.subsMkv);
  assert.deepEqual(source.subtitleCodecs, ['subrip'], 'fixture should carry SubRip');
  assert.equal(source.attachments, 1, 'fixture should carry an attachment');

  const { result } = runPreset('remux-mp4', fixtures.subsMkv, 'subs.mp4');
  assert.equal(result.videoCodec, 'h264');
  assert.equal(result.audioCodec, 'aac');
  assert.deepEqual(
    result.subtitleCodecs,
    ['mov_text'],
    'subtitles should be converted, not dropped'
  );
  assert.equal(result.attachments, 0, 'attachment must be left out of MP4');
});

test('MKV remux preserves every stream untouched', { skip }, () => {
  const { result } = runPreset('remux-mkv', fixtures.subsMkv, 'subs.mkv');
  assert.equal(result.videoCodec, 'h264');
  assert.deepEqual(result.subtitleCodecs, ['subrip'], 'MKV needs no subtitle conversion');
  assert.equal(result.attachments, 1, 'MKV should keep the attachment');
});

test('WebM remux works when the source codecs are supported', { skip }, () => {
  const { result } = runPreset('remux-webm', fixtures.vp9Opus, 'ok.webm');
  assert.equal(result.videoCodec, 'vp9');
  assert.equal(result.audioCodec, 'opus');
});

test('WebM remux converts text subtitles to WebVTT', { skip }, () => {
  const withSubs = path.join(work, 'vp9_opus_subs.mkv');
  ffmpeg([
    '-i',
    fixtures.vp9Opus,
    '-i',
    path.join(work, 'sub.srt'),
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    '-c:s',
    'srt',
    withSubs,
  ]);
  const { result } = runPreset('remux-webm', withSubs, 'subs.webm');
  assert.deepEqual(result.subtitleCodecs, ['webvtt']);
});

test('HEVC remuxed to MP4 is tagged hvc1 for Apple players', { skip }, () => {
  const { result } = runPreset('remux-mp4', fixtures.hevcMkv, 'hevc.mp4');
  assert.equal(result.videoCodec, 'hevc');
  assert.equal(result.videoTag, 'hvc1', 'hev1 will not play in QuickTime/Safari/iOS');
});

test('H.265 encodes into MP4 are tagged hvc1', { skip }, () => {
  const { result } = runPreset('h265-balanced', fixtures.base, 'h265_tag.mp4');
  assert.equal(result.videoTag, 'hvc1');
});

// ── Preflight rejections must match real muxer behaviour ────────────────────

test('the remux preflight matches what the muxer actually refuses', { skip }, async (t) => {
  const cases = [
    {
      label: 'vp9+aac into webm',
      file: () => fixtures.vp9Aac,
      extension: 'webm',
      presetId: 'remux-webm',
    },
    {
      label: 'h264+aac into webm',
      file: () => fixtures.subsMkv,
      extension: 'webm',
      presetId: 'remux-webm',
    },
  ];

  for (const { label, file, extension, presetId } of cases) {
    await t.test(label, () => {
      const source = probe(file());
      const reason = getRemuxIncompatibilityReason(source.videoCodec, extension, source.audioCodec);
      assert.ok(reason, 'preflight should reject this source');
      assert.match(reason, /without re-encoding/);

      // Confirm the preflight is not over-cautious: FFmpeg must genuinely fail.
      const preset = getPresetById(presetId);
      const output = path.join(work, `should_fail.${preset.extension}`);
      assert.throws(
        () =>
          ffmpeg(
            preset.getArgs(file(), output, 'cpu', {
              sourceStreams: {
                videoCodec: source.videoCodec,
                audioCodec: source.audioCodec,
                subtitleCodecs: source.subtitleCodecs,
              },
            })
          ),
        'FFmpeg was expected to reject this combination'
      );
    });
  }
});

test('supported remux combinations are not blocked by the preflight', { skip }, () => {
  const opus = probe(fixtures.vp9Opus);
  assert.equal(getRemuxIncompatibilityReason(opus.videoCodec, 'webm', opus.audioCodec), null);
  const h264 = probe(fixtures.subsMkv);
  assert.equal(getRemuxIncompatibilityReason(h264.videoCodec, 'mp4', h264.audioCodec), null);
});

// ── Advanced settings at their limits ───────────────────────────────────────

test('AV1 accepts the top of its allowed CRF range on CPU', { skip }, () => {
  // Tier settings clamp AV1 quality to 63 because libsvtav1's CRF range is 0-63;
  // hardware encoders stop at 51 and are clamped separately.
  const preset = getPresetById('av1-balanced');
  const output = path.join(work, 'av1_crf63.mp4');
  const args = preset.getArgs(fixtures.base, output, 'cpu', {
    advancedFormatSettings: {
      av1: { tiers: { balanced: { quality: 63, cpuPreset: 8, audioBitrateKbps: 96 } } },
    },
  });
  assert.equal(args[args.indexOf('-crf') + 1], '63');
  ffmpeg(args);
  assert.equal(probe(output).videoCodec, 'av1');
});

test('GIF tier settings at their clamped bounds still render', { skip }, async (t) => {
  // Regression: the colour floor used to be 2, which palettegen rejects because
  // it reserves a transparent slot. Both extremes of the clamp must encode.
  const { normalizeGifTierSettings } = require('../dist/main/advancedFormats');
  const bounds = [
    {
      label: 'minimum colours',
      requested: { fps: 60, maxDimension: 160, maxColors: 1, dither: 'none' },
    },
    {
      label: 'maximum colours',
      requested: { fps: 1, maxDimension: 2160, maxColors: 999, dither: 'bayer' },
    },
  ];

  for (const { label, requested } of bounds) {
    await t.test(label, () => {
      const tier = normalizeGifTierSettings(requested, {
        fps: 12,
        maxDimension: 480,
        maxColors: 128,
        dither: 'bayer',
      });
      const preset = getPresetById('gif-balanced');
      const output = path.join(work, `out_gif_${label.replace(/\s+/g, '_')}.gif`);
      const args = preset.getArgs(fixtures.base, output, 'cpu', {
        advancedFormatSettings: { gif: { loopMode: 'once', tiers: { balanced: tier } } },
      });
      ffmpeg(args);
      assert.equal(probe(output).videoCodec, 'gif');
    });
  }
});

test('10-bit sources convert without error', { skip }, async (t) => {
  assert.match(
    execFileSync(
      FFPROBE,
      [
        '-v',
        'quiet',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=pix_fmt',
        '-of',
        'csv=p=0',
        fixtures.tenBit,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString(),
    /10le/,
    'fixture should be 10-bit'
  );

  for (const id of ['h264-fast', 'h265-balanced', 'av1-balanced']) {
    await t.test(id, () => {
      const { result } = runPreset(id, fixtures.tenBit, `tenbit_${id}.mp4`);
      assert.ok(result.videoCodec);
    });
  }
});

test('output naming and extensions match each preset', { skip }, () => {
  for (const preset of presets) {
    const codec = getPresetGpuCodec(preset);
    assert.ok(
      typeof preset.extension === 'string' && preset.extension.length > 0,
      `${preset.id} has no extension`
    );
    if (preset.category === 'gif' || preset.category === 'audio') {
      assert.equal(codec, null, `${preset.id} should not report a GPU codec`);
    }
  }
});
