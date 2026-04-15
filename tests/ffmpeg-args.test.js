const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureMp4PlaybackCompatibilityArgs,
  resolveUniqueOutputPath,
} = require('../dist/main/ffmpeg.js');
const { presets } = require('../dist/main/presets.js');

test('adds faststart and hvc1 for H.265 MP4 output', () => {
  const preset = {
    id: 'h265-test',
    name: 'h265',
    description: 'test',
    category: 'h265',
    extension: 'mp4',
    getArgs: () => [],
  };

  const args = ensureMp4PlaybackCompatibilityArgs(preset, [
    '-i',
    'input.mp4',
    '-c:v',
    'hevc_nvenc',
    'output.mp4',
  ]);

  assert.equal(args[args.length - 1], 'output.mp4');
  assert.ok(args.includes('-movflags'));
  assert.ok(args.includes('+faststart'));
  assert.ok(args.includes('-tag:v'));
  assert.ok(args.includes('hvc1'));
});

test('adds faststart for non-H.265 MP4 output', () => {
  const preset = {
    id: 'h264-test',
    name: 'h264',
    description: 'test',
    category: 'h264',
    extension: 'mp4',
    getArgs: () => [],
  };

  const args = ensureMp4PlaybackCompatibilityArgs(preset, [
    '-i',
    'input.mp4',
    '-c:v',
    'h264_nvenc',
    'output.mp4',
  ]);

  assert.ok(args.includes('-movflags'));
  assert.ok(args.includes('+faststart'));
  assert.equal(args.includes('-tag:v'), false);
});

test('preserves existing movflags and appends faststart once', () => {
  const preset = {
    id: 'h265-test-movflags',
    name: 'h265',
    description: 'test',
    category: 'h265',
    extension: 'mp4',
    getArgs: () => [],
  };

  const args = ensureMp4PlaybackCompatibilityArgs(preset, [
    '-i',
    'input.mp4',
    '-movflags',
    'frag_keyframe',
    '-c:v',
    'hevc_nvenc',
    'output.mp4',
  ]);

  const movflagsIndex = args.indexOf('-movflags');
  assert.ok(movflagsIndex >= 0);
  assert.equal(args[movflagsIndex + 1], 'frag_keyframe+faststart');
  assert.equal(args.filter((arg) => arg === '-movflags').length, 1);
});

test('does not modify non-MP4 args', () => {
  const preset = {
    id: 'mkv-test',
    name: 'mkv',
    description: 'test',
    category: 'h265',
    extension: 'mkv',
    getArgs: () => [],
  };

  const inputArgs = ['-i', 'input.mp4', '-c:v', 'hevc_nvenc', 'output.mkv'];
  const args = ensureMp4PlaybackCompatibilityArgs(preset, inputArgs);

  assert.deepEqual(args, inputArgs);
});

test('resolveUniqueOutputPath increments suffix when output exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-output-path-'));

  try {
    const firstPath = resolveUniqueOutputPath(tempDir, 'sample', 'mp4');
    assert.equal(firstPath, path.join(tempDir, 'sample_converted.mp4'));

    fs.writeFileSync(firstPath, 'occupied');

    const secondPath = resolveUniqueOutputPath(tempDir, 'sample', 'mp4');
    assert.equal(secondPath, path.join(tempDir, 'sample_converted_1.mp4'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gif preset includes palette workflow args and loop flag', () => {
  const preset = presets.find((entry) => entry.id === 'gif-best-quality');
  assert.ok(preset);

  const args = preset.getArgs('input.mp4', 'output.gif', 'cpu');
  assert.equal(args[args.length - 1], 'output.gif');
  assert.ok(args.includes('-filter_complex'));
  assert.ok(args.includes('-loop'));

  const filterIndex = args.indexOf('-filter_complex');
  assert.ok(filterIndex >= 0);
  const filter = args[filterIndex + 1];
  assert.ok(filter.includes('palettegen'));
  assert.ok(filter.includes('paletteuse'));
  assert.ok(args.includes('-map'));
  assert.ok(args.includes('[gifout]'));
  assert.ok(args.includes('-an'));
  assert.ok(args.includes('-sn'));
  assert.ok(args.includes('-dn'));
});

test('gif preset uses custom advanced settings in generated args', () => {
  const preset = presets.find((entry) => entry.id === 'gif-best-compression');
  assert.ok(preset);

  const args = preset.getArgs('input.mp4', 'output.gif', 'cpu', {
    advancedFormatSettings: {
      gif: {
        loopMode: 'once',
        tiers: {
          bestQuality: { fps: 15, maxDimension: 1080, maxColors: 256, dither: 'sierra2_4a' },
          quality: { fps: 12, maxDimension: 900, maxColors: 224, dither: 'sierra2_4a' },
          balanced: { fps: 10, maxDimension: 720, maxColors: 192, dither: 'bayer' },
          bestCompression: {
            fps: 22,
            maxDimension: 480,
            maxColors: 48,
            dither: 'floyd_steinberg',
          },
        },
      },
    },
  });

  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('fps=22'));
  assert.ok(filter.includes('scale=480:480'));
  assert.ok(filter.includes('max_colors=48'));
  assert.ok(filter.includes('dither=floyd_steinberg'));
  assert.equal(args[args.indexOf('-loop') + 1], '-1');
});

test('gif presets map to expected default tier values', () => {
  const expectedByPreset = {
    'gif-best-quality': {
      fps: 15,
      maxDimension: 1080,
      maxColors: 256,
      dither: 'sierra2_4a',
    },
    'gif-quality': {
      fps: 12,
      maxDimension: 900,
      maxColors: 224,
      dither: 'sierra2_4a',
    },
    'gif-balanced': {
      fps: 10,
      maxDimension: 720,
      maxColors: 192,
      dither: 'bayer',
    },
    'gif-best-compression': {
      fps: 8,
      maxDimension: 540,
      maxColors: 128,
      dither: 'none',
    },
  };

  for (const [presetId, expected] of Object.entries(expectedByPreset)) {
    const preset = presets.find((entry) => entry.id === presetId);
    assert.ok(preset, `missing ${presetId}`);
    const args = preset.getArgs('input.mp4', 'output.gif', 'cpu');
    const filter = args[args.indexOf('-filter_complex') + 1];
    assert.ok(filter.includes(`fps=${expected.fps}`), `${presetId} missing fps`);
    assert.ok(
      filter.includes(`scale=${expected.maxDimension}:${expected.maxDimension}`),
      `${presetId} missing scale`
    );
    assert.ok(
      filter.includes(`max_colors=${expected.maxColors}`),
      `${presetId} missing max colors`
    );
    assert.ok(filter.includes(`dither=${expected.dither}`), `${presetId} missing dither`);
  }
});

test('gif presets normalize malformed advanced settings at arg boundary', () => {
  const preset = presets.find((entry) => entry.id === 'gif-best-quality');
  assert.ok(preset);

  const args = preset.getArgs('input.mp4', 'output.gif', 'cpu', {
    advancedFormatSettings: {
      gif: {
        loopMode: 'bogus',
        tiers: {
          bestQuality: {
            fps: 999,
            maxDimension: 99,
            maxColors: 9999,
            dither: 'invalid',
          },
        },
      },
    },
  });

  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('fps=60'));
  assert.ok(filter.includes('scale=160:160'));
  assert.ok(filter.includes('max_colors=256'));
  assert.ok(filter.includes('dither=sierra2_4a'));
  assert.equal(args[args.indexOf('-loop') + 1], '0');
});

test('av1 preset uses advanced quality, cpu preset, and audio bitrate', () => {
  const preset = presets.find((entry) => entry.id === 'av1-best-quality');
  assert.ok(preset);

  const args = preset.getArgs('input.mp4', 'output.mp4', 'cpu', {
    advancedFormatSettings: {
      av1: {
        tiers: {
          bestQuality: {
            quality: 12,
            cpuPreset: 3,
            audioBitrateKbps: 320,
          },
        },
      },
    },
  });

  assert.ok(args.includes('-crf'));
  assert.equal(args[args.indexOf('-crf') + 1], '12');
  assert.equal(args[args.indexOf('-preset') + 1], '3');
  assert.equal(args[args.indexOf('-b:a') + 1], '320k');
});

test('h264 preset uses advanced quality, preset, and audio bitrate', () => {
  const preset = presets.find((entry) => entry.id === 'h264-fast');
  assert.ok(preset);

  const args = preset.getArgs('input.mp4', 'output.mp4', 'cpu', {
    advancedFormatSettings: {
      h264: {
        tiers: {
          fast: {
            quality: 19,
            preset: 'veryslow',
            audioBitrateKbps: 160,
          },
        },
      },
    },
  });

  assert.equal(args[args.indexOf('-crf') + 1], '19');
  assert.equal(args[args.indexOf('-preset') + 1], 'veryslow');
  assert.equal(args[args.indexOf('-b:a') + 1], '160k');
});

test('h265 preset toggles advanced x265 params based on settings', () => {
  const preset = presets.find((entry) => entry.id === 'h265-best-quality');
  assert.ok(preset);

  const args = preset.getArgs('input.mp4', 'output.mp4', 'cpu', {
    advancedFormatSettings: {
      h265: {
        tiers: {
          bestQuality: {
            quality: 14,
            preset: 'slow',
            audioBitrateKbps: 224,
            useAdvancedParams: false,
          },
        },
      },
    },
  });

  assert.equal(args[args.indexOf('-crf') + 1], '14');
  assert.equal(args[args.indexOf('-preset') + 1], 'slow');
  assert.equal(args[args.indexOf('-b:a') + 1], '224k');
  assert.equal(args.includes('-x265-params'), false);
});

test('avi preset uses advanced codec and parameters', () => {
  const preset = presets.find((entry) => entry.id === 'avi-balanced');
  assert.ok(preset);

  const args = preset.getArgs('input.mp4', 'output.avi', 'cpu', {
    advancedFormatSettings: {
      avi: {
        tiers: {
          balanced: {
            codec: 'h265',
            quality: 24,
            preset: 'slow',
            audioBitrateKbps: 144,
            useAdvancedParams: true,
          },
        },
      },
    },
  });

  assert.equal(args[args.indexOf('-c:v') + 1], 'libx265');
  assert.equal(args[args.indexOf('-crf') + 1], '24');
  assert.equal(args[args.indexOf('-preset') + 1], 'slow');
  assert.equal(args[args.indexOf('-b:a') + 1], '144k');
  assert.ok(args.includes('-x265-params'));
});

test('nvidia GPU encodes use -cq with -b:v 0 for proper CQ mode', () => {
  const av1Preset = presets.find((p) => p.id === 'av1-best-quality');
  const h265Preset = presets.find((p) => p.id === 'h265-best-quality');
  const h264Preset = presets.find((p) => p.id === 'h264-quality');

  for (const preset of [av1Preset, h265Preset, h264Preset]) {
    assert.ok(preset, `missing preset ${preset?.id}`);
    const args = preset.getArgs('input.mp4', 'output.mp4', 'nvidia');
    assert.ok(args.includes('-cq'), `${preset.id}: missing -cq`);
    assert.ok(args.includes('-b:v'), `${preset.id}: missing -b:v (required for NVENC CQ mode)`);
    assert.equal(args[args.indexOf('-b:v') + 1], '0', `${preset.id}: -b:v must be 0`);
    assert.ok(!args.includes('-crf'), `${preset.id}: should not use -crf for GPU`);
  }
});

test('AMD GPU encodes use CQP rate control', () => {
  const preset = presets.find((p) => p.id === 'av1-best-quality');
  assert.ok(preset);
  const args = preset.getArgs('input.mp4', 'output.mp4', 'amd');
  assert.ok(args.includes('-rc'), 'missing -rc');
  assert.equal(args[args.indexOf('-rc') + 1], 'cqp');
  assert.ok(args.includes('-qp_i'));
  assert.ok(args.includes('-qp_p'));
});

test('Intel GPU encodes use -global_quality', () => {
  const preset = presets.find((p) => p.id === 'h265-best-quality');
  assert.ok(preset);
  const args = preset.getArgs('input.mp4', 'output.mp4', 'intel');
  assert.ok(args.includes('-global_quality'), 'missing -global_quality');
  assert.ok(!args.includes('-cq'), 'should not use -cq for Intel');
});

test('video presets include -map 0:v:0 and -map 0:a for multi-track preservation', () => {
  const videoPresetIds = [
    'av1-balanced',
    'av1-quality',
    'av1-best-quality',
    'av1-best-compression',
    'av1-compression',
    'h264-fast',
    'h264-quality',
    'h265-balanced',
    'h265-quality',
    'h265-best-quality',
    'h265-best-compression',
    'avi-best-quality',
    'avi-best-compression',
    'avi-balanced',
  ];

  for (const id of videoPresetIds) {
    const preset = presets.find((p) => p.id === id);
    assert.ok(preset, `missing preset ${id}`);
    const args = preset.getArgs('input.mp4', 'output.mp4', 'cpu');
    const mapArgs = args.filter((a) => a === '-map');
    assert.ok(mapArgs.length >= 2, `${id}: expected at least 2 -map flags`);
    assert.ok(args.includes('0:v:0'), `${id}: missing -map 0:v:0`);
    assert.ok(args.includes('0:a'), `${id}: missing -map 0:a`);
  }
});

test('remux presets include -map 0 to copy all streams', () => {
  const remuxIds = ['remux-mp4', 'remux-mkv', 'remux-webm'];

  for (const id of remuxIds) {
    const preset = presets.find((p) => p.id === id);
    assert.ok(preset, `missing preset ${id}`);
    const args = preset.getArgs('input.mp4', `output.${preset.extension}`, 'cpu');
    const mapIdx = args.indexOf('-map');
    assert.ok(mapIdx >= 0, `${id}: missing -map`);
    assert.equal(args[mapIdx + 1], '0', `${id}: -map must be 0`);
    assert.ok(args.includes('-c'), `${id}: missing -c`);
    assert.equal(args[args.indexOf('-c') + 1], 'copy', `${id}: must use stream copy`);
  }
});

test('audio extract presets strip video and produce no -map', () => {
  const audioIds = ['audio-mp3', 'audio-aac', 'audio-flac'];

  for (const id of audioIds) {
    const preset = presets.find((p) => p.id === id);
    assert.ok(preset, `missing preset ${id}`);
    const args = preset.getArgs('input.mp4', `output.${preset.extension}`, 'cpu');
    assert.ok(args.includes('-vn'), `${id}: missing -vn`);
    assert.ok(!args.includes('-map'), `${id}: should not have -map`);
  }
});
