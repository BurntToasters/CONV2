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
  spliceOutputArgs,
} = require('../dist/main/ffmpeg');
const { planVideoPipeline } = require('../dist/main/videoPipeline');

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
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  return {
    videoCodec: video?.codec_name,
    videoTag: video?.codec_tag_string,
    pixFmt: video?.pix_fmt,
    audioCodec: audio?.codec_name,
    audioStreams: audioStreams.length,
    audioChannels: audioStreams.map((s) => (typeof s.channels === 'number' ? s.channels : 0)),
    audioBitrates: audioStreams.map((s) => Number(s.bit_rate) || 0),
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
        audioChannels: info.audioChannels,
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

  // 5.1(side) is the layout libopus refuses; FLAC keeps it, Matroska PCM does not.
  fixtures.side51 = path.join(work, 'side51.mkv');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25:duration=1',
    '-f',
    'lavfi',
    '-i',
    // Noise, not silence: a silent track encodes to nearly nothing, so bitrates would not show.
    'aevalsrc=random(0)*2-1|random(1)*2-1|random(2)*2-1|random(3)*2-1|random(4)*2-1|random(5)*2-1:d=1:c=5.1(side)',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'flac',
    fixtures.side51,
  ]);

  // 10 fps, 320x180: small and low-rate, the case the GIF graph used to upscale and pad.
  fixtures.smallLowFps = path.join(work, 'small_10fps.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=10:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    fixtures.smallLowFps,
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

// ffprobe reports animated WebP as webp_anim, not webp.
const EXPECTED_VIDEO_CODEC = {
  av1: 'av1',
  h264: 'h264',
  h265: 'hevc',
  avi: 'h264',
  gif: 'gif',
  webp: 'webp_anim',
};

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
      if (preset.category === 'gif' || preset.category === 'webp') {
        assert.equal(result.audioCodec, undefined, `${preset.id} must not carry audio`);
      } else {
        assert.ok(result.audioCodec, `${preset.id} lost the audio track`);
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

// Failure modes for the GIF, WebP, AV1 audio and 10-bit changes, written before the change.
//  - GIF upscales a small source, or pads its frame rate above the source's
//  - WebP writes the wrong codec, or loops with the GIF convention (-1/0)
//  - AV1 with 5.1(side) audio fails because libopus rejects the layout
//  - a 10-bit H.265 run gets two -pix_fmt flags from preset and pipeline

const WEBP_IDS = ['webp-best-quality', 'webp-quality', 'webp-balanced', 'webp-best-compression'];

/** Reads the ANIM chunk loop count of an animated WebP (0 = forever). */
function webpLoopCount(file) {
  const bytes = fs.readFileSync(file);
  const anim = bytes.indexOf('ANIM');
  assert.notEqual(anim, -1, 'animated WebP has no ANIM chunk');
  return bytes.readUInt16LE(anim + 12);
}

/** Width, height and decoded frame count of the first video stream. */
function videoGeometry(file) {
  const out = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,nb_read_frames',
      '-of',
      'csv=p=0',
      file,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
    .toString()
    .trim();
  const [width, height, frames] = out.split(',').map(Number);
  return { width, height, frames };
}

test(
  'every WebP preset writes animated WebP that loops forever by default',
  { skip },
  async (t) => {
    for (const id of WEBP_IDS) {
      await t.test(id, () => {
        const { result, output } = runPreset(id, fixtures.base);
        assert.equal(result.videoCodec, 'webp_anim');
        assert.equal(result.audioCodec, undefined);
        assert.equal(webpLoopCount(output), 0, 'forever must map to loop count 0');
      });
    }
  }
);

test('WebP loop mode once writes loop count 1', { skip }, () => {
  const output = path.join(work, 'out_webp_once.webp');
  const args = getPresetById('webp-quality').getArgs(fixtures.base, output, 'cpu', {
    advancedFormatSettings: { webp: { loopMode: 'once' } },
  });
  ffmpeg(args);
  assert.equal(webpLoopCount(output), 1);
});

test('GIF from a small low-fps source keeps its size and frame count', { skip }, () => {
  const source = videoGeometry(fixtures.smallLowFps);
  assert.deepEqual([source.width, source.height, source.frames], [320, 180, 10]);

  const { output } = runPreset('gif-best-quality', fixtures.smallLowFps, 'small_source.gif');
  const out = videoGeometry(output);
  assert.equal(out.width, 320, 'must not upscale to the tier dimension');
  assert.equal(out.height, 180);
  assert.ok(out.frames <= source.frames, `frames ${out.frames} exceed source ${source.frames}`);
});

test('AV1 encodes a 5.1(side) source that libopus rejects without aformat', { skip }, () => {
  const source = probe(fixtures.side51);
  assert.deepEqual(source.audioChannels, [6], 'fixture should carry one 6-channel track');

  const { result } = runPreset('av1-balanced', fixtures.side51, 'side51_av1.mp4');
  assert.equal(result.videoCodec, 'av1');
  assert.equal(result.audioCodec, 'opus');
  assert.deepEqual(result.audioChannels, [6], 'surround layout must survive the aformat mapping');
});

test('a surround track gets its scaled bitrate in a real encode', { skip }, () => {
  // Failure mode: the per-stream -b:a:0 is ignored, leaving the track at the 128k base.
  const { result } = runPreset('h264-fast', fixtures.side51, 'side51_h264.mp4');
  assert.equal(result.audioCodec, 'aac');
  assert.ok(result.audioBitrates[0] > 250_000, `surround bitrate ${result.audioBitrates[0]}`);
});

test('a 10-bit H.265 run carries exactly one -pix_fmt after the pipeline merge', { skip }, () => {
  // The preset sets yuv420p10le for advanced params and the pipeline adds it for a 10-bit
  // source; the merge must keep one copy or FFmpeg receives a repeated option.
  const source = probe(fixtures.tenBit);
  const plan = planVideoPipeline({
    category: 'h265',
    encodeVendor: 'cpu',
    source: { pixFmt: source.pixFmt },
    decodeArgs: [],
    canTonemap: false,
  });
  const output = path.join(work, 'h265_10bit_merged.mp4');
  const preset = getPresetById('h265-best-quality');
  const args = ensureMp4PlaybackCompatibilityArgs(
    preset,
    spliceOutputArgs(preset.getArgs(fixtures.tenBit, output, 'cpu'), plan.outputArgs),
    source.videoCodec
  );
  assert.equal(args.filter((arg) => arg === '-pix_fmt').length, 1);
  ffmpeg(args);
  assert.equal(probe(output).pixFmt, 'yuv420p10le');
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
    if (['gif', 'webp', 'audio'].includes(preset.category)) {
      assert.equal(codec, null, `${preset.id} should not report a GPU codec`);
    }
  }
});
