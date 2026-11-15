const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureMp4PlaybackCompatibilityArgs,
  resolveUniqueOutputPath,
} = require('../dist/main/ffmpeg.js');
const { presets, getPresetGpuCodec } = require('../dist/main/presets.js');

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

    // Write content to the atomically-reserved placeholder so the next call sees it as occupied
    fs.writeFileSync(firstPath, 'occupied');

    const secondPath = resolveUniqueOutputPath(tempDir, 'sample', 'mp4');
    assert.equal(secondPath, path.join(tempDir, 'sample_converted_1.mp4'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveUniqueOutputPath atomically creates a placeholder file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-atomic-'));

  try {
    const outputPath = resolveUniqueOutputPath(tempDir, 'video', 'mp4');
    assert.ok(fs.existsSync(outputPath), 'placeholder file should exist after reservation');
    const stat = fs.statSync(outputPath);
    assert.equal(stat.size, 0, 'placeholder file should be empty');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveUniqueOutputPath skips suffix already claimed by concurrent reservation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-race-'));

  try {
    // Simulate external process creating the base path before our reservation attempt
    const basePath = path.join(tempDir, 'clip_converted.mp4');
    fs.writeFileSync(basePath, '');

    const result = resolveUniqueOutputPath(tempDir, 'clip', 'mp4');
    assert.equal(result, path.join(tempDir, 'clip_converted_1.mp4'));
    assert.ok(fs.existsSync(result), '_1 placeholder should be reserved');
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
  assert.ok(filter.includes('min(source_fps,22)'));
  assert.ok(filter.includes('min(480,iw)'));
  assert.ok(filter.includes('max_colors=48'));
  assert.ok(filter.includes('dither=floyd_steinberg'));
  assert.equal(args[args.indexOf('-loop') + 1], '-1');
});

// Shared frame stage: fps and downscale are capped at the tier values and never
// raise the source. The graph is compared exactly so any drift is visible.
const frameStage = (fps, maxDimension) =>
  `fps='if(gt(source_fps,0),min(source_fps,${fps}),${fps})',` +
  `scale='min(${maxDimension},iw)':'min(${maxDimension},ih)':flags=bicubic:force_original_aspect_ratio=decrease`;

const gifGraph = ({ fps, maxDimension, maxColors, dither }) => {
  const bscale = dither === 'bayer' ? ':bayer_scale=5' : '';
  return (
    `[0:v]${frameStage(fps, maxDimension)},split[v0][v1];` +
    `[v0]palettegen=max_colors=${maxColors}:stats_mode=full[palette];` +
    `[v1][palette]paletteuse=dither=${dither}${bscale}:diff_mode=rectangle[gifout]`
  );
};

test('gif presets map to expected default tier values', () => {
  const expectedByPreset = {
    'gif-best-quality': {
      fps: 15,
      maxDimension: 720,
      maxColors: 256,
      dither: 'bayer',
    },
    'gif-quality': {
      fps: 12,
      maxDimension: 600,
      maxColors: 192,
      dither: 'bayer',
    },
    'gif-balanced': {
      fps: 12,
      maxDimension: 480,
      maxColors: 128,
      dither: 'bayer',
    },
    'gif-best-compression': {
      fps: 10,
      maxDimension: 360,
      maxColors: 64,
      dither: 'none',
    },
  };

  for (const [presetId, expected] of Object.entries(expectedByPreset)) {
    const preset = presets.find((entry) => entry.id === presetId);
    assert.ok(preset, `missing ${presetId}`);
    const args = preset.getArgs('input.mp4', 'output.gif', 'cpu');
    const filter = args[args.indexOf('-filter_complex') + 1];
    assert.equal(filter, gifGraph(expected), `${presetId} graph`);
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
  assert.ok(filter.includes(`min(source_fps,50)`), 'fps must clamp to 50');
  assert.ok(filter.includes(`min(160,iw)`), 'dimension must clamp to 160');
  assert.ok(filter.includes('max_colors=256'));
  assert.ok(filter.includes('dither=bayer'));
  assert.equal(args[args.indexOf('-loop') + 1], '0');
});

// Failure modes for GIF and animated WebP output, written before the change.
//  - a small source is upscaled to the tier dimension (scale=D:D)
//  - the fps filter duplicates frames when the source runs below the tier fps
//  - the WebP loop flag is mapped with the GIF convention (-1/0) instead of 1/0
//  - WebP gets a GPU encoder or audio/pix_fmt flags it must not carry
//  - the four WebP presets drift from their tier settings or lose the libwebp_anim args
test('gif graph never upscales and keeps frame rate at or below the source', () => {
  const preset = presets.find((entry) => entry.id === 'gif-best-quality');
  const args = preset.getArgs('input.mp4', 'output.gif', 'cpu');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.startsWith('[0:v]fps='), 'graph must start with [0:v] for tone-mapping');
  assert.ok(filter.includes('min(source_fps,15)'), 'fps must not exceed the source');
  assert.ok(filter.includes('min(720,iw)') && filter.includes('min(720,ih)'));
  assert.ok(!filter.includes('lanczos'), 'lanczos ringing is replaced by bicubic');
});

const WEBP_PRESETS = [
  { id: 'webp-best-quality', fps: 30, maxDimension: 720, quality: 90 },
  { id: 'webp-quality', fps: 24, maxDimension: 600, quality: 80 },
  { id: 'webp-balanced', fps: 20, maxDimension: 480, quality: 70 },
  { id: 'webp-best-compression', fps: 15, maxDimension: 360, quality: 50 },
];

test('webp presets exist, in order after gif, and map to their tier values', () => {
  const webp = presets.filter((entry) => entry.category === 'webp');
  assert.deepEqual(
    webp.map((entry) => entry.id),
    WEBP_PRESETS.map((entry) => entry.id)
  );
  for (const expected of WEBP_PRESETS) {
    const preset = presets.find((entry) => entry.id === expected.id);
    assert.equal(preset.extension, 'webp');
    const args = preset.getArgs('input.mp4', 'output.webp', 'cpu');
    assert.equal(args[args.indexOf('-c:v') + 1], 'libwebp_anim');
    assert.equal(args[args.indexOf('-quality') + 1], String(expected.quality), expected.id);
    assert.equal(args[args.indexOf('-compression_level') + 1], '4');
    assert.equal(args[args.indexOf('-vf') + 1], frameStage(expected.fps, expected.maxDimension));
    assert.equal(args[args.length - 1], 'output.webp');
  }
});

test('webp output carries no audio, subtitles, data or stream maps', () => {
  for (const { id } of WEBP_PRESETS) {
    const args = presets.find((entry) => entry.id === id).getArgs('input.mp4', 'o.webp', 'cpu');
    for (const flag of ['-an', '-sn', '-dn']) {
      assert.ok(args.includes(flag), `${id} missing ${flag}`);
    }
    assert.equal(args.includes('-map'), false, `${id} must not map streams`);
    assert.equal(args.includes('-c:a'), false, `${id} must not select an audio codec`);
    assert.equal(args.includes('-pix_fmt'), false, `${id} must not force pix_fmt`);
  }
});

test('webp loop flag is 0 for forever and 1 for once, unlike GIF', () => {
  const forever = presets.find((entry) => entry.id === 'webp-quality');
  const foreverArgs = forever.getArgs('input.mp4', 'o.webp', 'cpu');
  assert.equal(foreverArgs[foreverArgs.indexOf('-loop') + 1], '0');

  const once = forever.getArgs('input.mp4', 'o.webp', 'cpu', {
    advancedFormatSettings: { webp: { loopMode: 'once' } },
  });
  assert.equal(once[once.indexOf('-loop') + 1], '1');
});

test('webp presets use advanced tier settings and normalize malformed values', () => {
  const preset = presets.find((entry) => entry.id === 'webp-best-compression');
  const args = preset.getArgs('input.mp4', 'o.webp', 'cpu', {
    advancedFormatSettings: {
      webp: {
        loopMode: 'bogus',
        tiers: { bestCompression: { fps: 999, maxDimension: 99, quality: 500 } },
      },
    },
  });
  // WebP fps clamps to 60 (GIF clamps to 50); dimension clamps to 160.
  assert.equal(args[args.indexOf('-vf') + 1], frameStage(60, 160));
  assert.equal(args[args.indexOf('-quality') + 1], '100');
  assert.equal(args[args.indexOf('-loop') + 1], '0', 'unknown loop mode falls back to forever');
});

test('webp presets have no GPU codec and no GPU arguments', () => {
  for (const { id } of WEBP_PRESETS) {
    const preset = presets.find((entry) => entry.id === id);
    assert.equal(getPresetGpuCodec(preset), null, `${id} must be CPU only`);
    const nvidia = preset.getArgs('input.mp4', 'o.webp', 'nvidia');
    assert.deepEqual(nvidia, preset.getArgs('input.mp4', 'o.webp', 'cpu'), `${id} ignores vendor`);
  }
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

test('av1 CPU encodes are 10-bit and apply svtav1-params on every tier', () => {
  const av1CpuPresetIds = [
    'av1-balanced',
    'av1-quality',
    'av1-best-quality',
    'av1-best-compression',
    'av1-compression',
  ];
  for (const id of av1CpuPresetIds) {
    const preset = presets.find((entry) => entry.id === id);
    assert.ok(preset, `missing ${id}`);
    const args = preset.getArgs('input.mp4', 'output.mp4', 'cpu');
    assert.ok(args.includes('-svtav1-params'), `${id}: missing -svtav1-params`);
    assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p10le', `${id}: must encode 10-bit`);
  }
});

test('av1 GPU encodes do not force libsvtav1-only flags', () => {
  const preset = presets.find((entry) => entry.id === 'av1-best-quality');
  const args = preset.getArgs('input.mp4', 'output.mp4', 'nvidia');
  assert.ok(!args.includes('-svtav1-params'), 'GPU AV1 must not pass -svtav1-params');
  assert.ok(!args.includes('-pix_fmt'), 'GPU AV1 must not force pix_fmt in preset');
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
  const args = preset.getArgs('input.mp4', 'output.mp4', 'amd', { platform: 'win32' });
  assert.ok(args.includes('-rc'), 'missing -rc');
  assert.equal(args[args.indexOf('-rc') + 1], 'cqp');
  assert.ok(args.includes('-qp_i'));
  assert.ok(args.includes('-qp_p'));
});

test('Intel GPU encodes use -global_quality', () => {
  const preset = presets.find((p) => p.id === 'h265-best-quality');
  assert.ok(preset);
  const args = preset.getArgs('input.mp4', 'output.mp4', 'intel', { platform: 'win32' });
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
    assert.ok(args.includes('0:a?'), `${id}: missing -map 0:a?`);
  }
});

test('remux presets always stream copy', () => {
  const remuxIds = ['remux-mp4', 'remux-mkv', 'remux-webm'];

  for (const id of remuxIds) {
    const preset = presets.find((p) => p.id === id);
    assert.ok(preset, `missing preset ${id}`);
    const args = preset.getArgs('input.mp4', `output.${preset.extension}`, 'cpu');
    assert.ok(args.indexOf('-map') >= 0, `${id}: missing -map`);
    assert.ok(args.includes('-c'), `${id}: missing -c`);
    assert.equal(args[args.indexOf('-c') + 1], 'copy', `${id}: must use stream copy`);
  }
});

test('MKV remux copies every stream wholesale', () => {
  // MKV can carry any stream FFmpeg copies, including bitmap subs and attachments.
  const preset = presets.find((p) => p.id === 'remux-mkv');
  const args = preset.getArgs('input.mkv', 'output.mkv', 'cpu', {
    sourceStreams: { subtitleCodecs: ['subrip', 'hdmv_pgs_subtitle'] },
  });
  assert.equal(args[args.indexOf('-map') + 1], '0');
  assert.equal(args.includes('-c:s'), false, 'MKV needs no subtitle conversion');
});

test('MP4 remux converts text subtitles instead of failing on them', () => {
  // Copying subrip into MP4 fails with "Could not find tag for codec subrip",
  // and -map 0 additionally drags in MKV attachments that MP4 rejects.
  const preset = presets.find((p) => p.id === 'remux-mp4');
  const args = preset.getArgs('input.mkv', 'output.mp4', 'cpu', {
    sourceStreams: { videoCodec: 'h264', audioCodec: 'aac', subtitleCodecs: ['subrip'] },
  });
  const mapValues = args.filter((arg, index) => args[index - 1] === '-map');
  assert.equal(mapValues.includes('0'), false, 'must not blanket-map every stream');
  assert.ok(args.includes('0:v:0?'), 'should map the first video stream');
  assert.ok(args.includes('0:a?'), 'should map all audio streams');
  assert.ok(args.includes('0:s:0'), 'should map the text subtitle stream');
  assert.equal(args[args.indexOf('-c:s') + 1], 'mov_text');
});

test('MP4 remux skips bitmap subtitles that cannot become text', () => {
  const preset = presets.find((p) => p.id === 'remux-mp4');
  const args = preset.getArgs('input.mkv', 'output.mp4', 'cpu', {
    sourceStreams: { subtitleCodecs: ['hdmv_pgs_subtitle', 'subrip'] },
  });
  assert.equal(args.includes('0:s:0'), false, 'bitmap subtitle must not be mapped');
  assert.ok(args.includes('0:s:1'), 'text subtitle at index 1 should be mapped');
  assert.equal(args[args.indexOf('-c:s') + 1], 'mov_text');
});

test('remux without probe info maps no subtitles', () => {
  // No stream info means we cannot tell text from bitmap; copying blind is what
  // used to break, so subtitles are simply left out.
  const preset = presets.find((p) => p.id === 'remux-mp4');
  const args = preset.getArgs('input.mkv', 'output.mp4', 'cpu');
  assert.equal(
    args.some((arg) => String(arg).startsWith('0:s')),
    false
  );
  assert.equal(args.includes('-c:s'), false);
});

test('WebM remux converts text subtitles to WebVTT', () => {
  const preset = presets.find((p) => p.id === 'remux-webm');
  const args = preset.getArgs('input.mkv', 'output.webm', 'cpu', {
    sourceStreams: { videoCodec: 'vp9', audioCodec: 'opus', subtitleCodecs: ['ass'] },
  });
  assert.ok(args.includes('0:s:0'));
  assert.equal(args[args.indexOf('-c:s') + 1], 'webvtt');
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

// Failure modes for AV1, H.265, audio and description changes, written before the change.
//  - SVT-AV1 keeps scm=0 or the removed no-op keys
//  - libopus receives an unsupported layout such as 5.1(side), or -af lands after -c:a
//  - GPU AV1 gains -af or SVT params (GPU args must stay byte-identical)
//  - the x265 string drifts, or AVI H.265 loses its previous params
//  - CPU H.265 lacks 10-bit when advanced params are on, or AVI/8-bit tiers gain it
//  - two -pix_fmt flags reach the argv (preset plus pipeline)
//  - multichannel bitrate missing, applied to stereo, on the wrong index, or above 640k
//  - descriptions keep CRF or x26x preset numbers
//  - FLAC lacks -compression_level 8

const SVTAV1_TUNING = 'tune=0:enable-overlays=1:enable-qm=1:qm-min=0:keyint=10s';
const X265_TUNING = 'aq-mode=3:psy-rd=2.0:psy-rdoq=1.0:rc-lookahead=60:bframes=8';
const AVI_X265_TUNING =
  'aq-mode=3:rd=6:psy-rd=2.0:psy-rdoq=1.0:rdoq-level=2:rc-lookahead=60:bframes=8:ref=6';
const AFORMAT = 'aformat=channel_layouts=mono|stereo|3.0|quad|5.0|5.1|6.1|7.1';

const byId = (id) => presets.find((entry) => entry.id === id);

test('AV1 CPU uses the revised SVT-AV1 tuning string', () => {
  const args = byId('av1-balanced').getArgs('input.mp4', 'output.mp4', 'cpu');
  assert.equal(args[args.indexOf('-svtav1-params') + 1], SVTAV1_TUNING);
  assert.equal(args[args.indexOf('-preset') + 1], '6');
});

test('AV1 routes audio through aformat right before libopus on CPU and GPU', () => {
  for (const gpu of ['cpu', 'nvidia', 'amd', 'intel']) {
    const args = byId('av1-quality').getArgs('input.mp4', 'output.mp4', gpu, { platform: 'win32' });
    const codec = args.indexOf('-c:a');
    assert.equal(args[codec + 1], 'libopus', gpu);
    assert.equal(args[codec - 2], '-af', `${gpu}: -af must precede -c:a`);
    assert.equal(args[codec - 1], AFORMAT, gpu);
  }
});

test('H.265 CPU uses the revised x265 string and 10-bit only with advanced params', () => {
  const best = byId('h265-best-quality').getArgs('input.mp4', 'output.mp4', 'cpu');
  assert.equal(best[best.indexOf('-x265-params') + 1], X265_TUNING);
  assert.equal(best[best.indexOf('-pix_fmt') + 1], 'yuv420p10le');

  const balanced = byId('h265-balanced').getArgs('input.mp4', 'output.mp4', 'cpu');
  assert.equal(balanced.includes('-x265-params'), false);
  assert.equal(balanced.includes('-pix_fmt'), false, 'plain tier stays 8-bit');
});

test('H.265 GPU encodes gain no CPU-only flags', () => {
  const args = byId('h265-best-quality').getArgs('input.mp4', 'output.mp4', 'nvidia');
  assert.equal(args.includes('-x265-params'), false);
  assert.equal(args.includes('-pix_fmt'), false);
  assert.equal(args.includes('-af'), false);
});

test('AVI H.265 keeps its previous x265 params and gets no 10-bit flag', () => {
  const args = byId('avi-balanced').getArgs('input.mp4', 'output.avi', 'cpu', {
    advancedFormatSettings: {
      avi: { tiers: { balanced: { codec: 'h265', useAdvancedParams: true } } },
    },
  });
  assert.equal(args[args.indexOf('-x265-params') + 1], AVI_X265_TUNING);
  assert.equal(args.includes('-pix_fmt'), false);
});

test('multichannel sources get scaled per-stream AAC or Opus bitrates', () => {
  // 128k base x2.5 = 320k for 3-6 channels; 256k base x2.5 = 640k (cap).
  const surround = { sourceStreams: { audioChannels: [6, 2] } };
  const h264 = byId('h264-fast').getArgs('input.mp4', 'output.mp4', 'cpu', surround);
  assert.equal(h264[h264.indexOf('-b:a:0') + 1], '320k');
  assert.equal(h264.indexOf('-b:a:1'), -1, 'stereo stream keeps only the generic bitrate');
  assert.ok(h264.indexOf('-b:a:0') < h264.length - 1, 'per-stream bitrate precedes output');
  assert.equal(h264[h264.length - 1], 'output.mp4');

  const av1 = byId('av1-balanced').getArgs('input.mp4', 'output.mp4', 'cpu', surround);
  assert.equal(av1[av1.indexOf('-b:a:0') + 1], '320k');

  const capped = byId('h265-best-quality').getArgs('input.mp4', 'output.mp4', 'nvidia', {
    sourceStreams: { audioChannels: [6] },
  });
  assert.equal(capped[capped.indexOf('-b:a:0') + 1], '640k');

  const eightChannel = byId('h264-fast').getArgs('input.mp4', 'output.mp4', 'cpu', {
    sourceStreams: { audioChannels: [8] },
  });
  assert.equal(eightChannel[eightChannel.indexOf('-b:a:0') + 1], '448k', '128k x3.5');
});

test('multichannel bitrates are absent when stereo, unknown, or not applicable', () => {
  const cases = [
    { id: 'h264-fast', context: undefined },
    { id: 'h264-fast', context: { sourceStreams: { audioChannels: [2, 2] } } },
    { id: 'h264-fast', context: { sourceStreams: { audioChannels: [] } } },
    { id: 'h264-fast', context: { sourceStreams: {} } },
    { id: 'avi-balanced', context: { sourceStreams: { audioChannels: [6] } } },
    { id: 'audio-aac', context: { sourceStreams: { audioChannels: [6] } } },
    { id: 'gif-balanced', context: { sourceStreams: { audioChannels: [6] } } },
  ];
  for (const { id, context } of cases) {
    const args = byId(id).getArgs('input.mp4', 'output.out', 'cpu', context);
    assert.equal(
      args.some((arg) => /^-b:a:\d+$/.test(arg)),
      false,
      `${id} ${JSON.stringify(context)} must not add per-stream bitrates`
    );
  }
});

test('a pipeline -pix_fmt is dropped when the preset already sets one', () => {
  const { spliceOutputArgs } = require('../dist/main/ffmpeg.js');
  const preset = ['-i', 'in.mp4', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', 'out.mp4'];
  const merged = spliceOutputArgs(preset, [
    '-color_primaries',
    'bt2020',
    '-pix_fmt',
    'yuv420p10le',
  ]);
  assert.equal(merged.filter((arg) => arg === '-pix_fmt').length, 1);
  assert.equal(merged[merged.indexOf('-color_primaries') + 1], 'bt2020');
  assert.equal(merged[merged.length - 1], 'out.mp4', 'output stays last');

  const added = spliceOutputArgs(['-i', 'in.mp4', 'out.mp4'], ['-pix_fmt', 'yuv420p']);
  assert.deepEqual(added, ['-i', 'in.mp4', '-pix_fmt', 'yuv420p', 'out.mp4']);

  const untouched = ['-i', 'in.mp4', 'out.mp4'];
  assert.equal(spliceOutputArgs(untouched, []), untouched);
});

test('every preset argv carries at most one -pix_fmt once spliced', () => {
  const { spliceOutputArgs } = require('../dist/main/ffmpeg.js');
  const tenBitPipeline = ['-pix_fmt', 'yuv420p10le'];
  for (const preset of presets) {
    const args = preset.getArgs('input.mp4', `output.${preset.extension}`, 'cpu');
    const merged = spliceOutputArgs(args, tenBitPipeline);
    assert.ok(merged.filter((arg) => arg === '-pix_fmt').length <= 1, `${preset.id} duplicates`);
  }
});

test('FLAC extraction sets compression level 8 after the codec', () => {
  const args = byId('audio-flac').getArgs('input.mp4', 'output.flac');
  assert.equal(args[args.indexOf('-c:a') + 1], 'flac');
  assert.equal(args[args.indexOf('-compression_level') + 1], '8');
});

test('preset descriptions describe intent, not CRF or x26x preset numbers', () => {
  for (const preset of presets) {
    assert.doesNotMatch(
      preset.description,
      /CRF|\b(ultrafast|superfast|veryfast|veryslow|slower|placebo)\b|preset \d|\(\d/,
      `${preset.id} description carries a hard-coded tuning number`
    );
  }
  for (const preset of presets.filter((entry) => entry.category === 'webp')) {
    assert.doesNotMatch(preset.description, /\d/, `${preset.id} must not hard-code numbers`);
  }
});

// Failure modes for VAAPI wiring in ffmpeg.ts. Written before the change.
//  - a Linux Intel/AMD conversion runs without -vaapi_device, so the upload filter has no device
//  - -vaapi_device lands after -i, where FFmpeg ignores it
//  - the decode-fallback retry drops the device, because it rebuilds the argument list
//  - a missing render node still spawns an encoder that cannot initialise
//  - a Linux Intel/AMD probe is cached under the bare encoder name, so two nodes share a result
//  - Linux Intel or AMD still gets hardware decode arguments (QSV or D3D)
//  - a Windows or macOS Intel/AMD request is sent to a render-node lookup

const {
  resolveVaapiDevice,
  insertBeforeInput,
  buildHwProbeArgs,
  vaapiProbeOptions,
  checkGPUEncoderSupport,
  getHardwareDecodeArgs,
} = require('../dist/main/ffmpeg.js');

test('resolveVaapiDevice picks a render node only for Linux Intel and AMD', () => {
  const node = () => '/dev/dri/renderD128';
  assert.deepEqual(resolveVaapiDevice('intel', 'linux', node), {
    gpu: 'intel',
    renderNode: '/dev/dri/renderD128',
  });
  assert.deepEqual(resolveVaapiDevice('amd', 'linux', node), {
    gpu: 'amd',
    renderNode: '/dev/dri/renderD128',
  });
  assert.deepEqual(resolveVaapiDevice('nvidia', 'linux', node), {
    gpu: 'nvidia',
    renderNode: null,
  });
  assert.deepEqual(resolveVaapiDevice('cpu', 'linux', node), { gpu: 'cpu', renderNode: null });
  assert.deepEqual(resolveVaapiDevice('intel', 'win32', node), { gpu: 'intel', renderNode: null });
});

test('resolveVaapiDevice falls back to CPU when no render node exists', () => {
  const seen = [];
  const find = (gpu) => {
    seen.push(gpu);
    return null;
  };
  assert.deepEqual(resolveVaapiDevice('intel', 'linux', find), { gpu: 'cpu', renderNode: null });
  assert.deepEqual(resolveVaapiDevice('amd', 'linux', find), { gpu: 'cpu', renderNode: null });
  assert.deepEqual(seen, ['intel', 'amd']);
});

test('insertBeforeInput puts the VAAPI device before -i and keeps the rest in order', () => {
  const args = [
    '-protocol_whitelist',
    'file,pipe,crypto,data',
    '-i',
    'in.mkv',
    '-c:v',
    'h264_vaapi',
    'out.mp4',
  ];
  assert.deepEqual(insertBeforeInput(args, ['-vaapi_device', '/dev/dri/renderD128']), [
    '-protocol_whitelist',
    'file,pipe,crypto,data',
    '-vaapi_device',
    '/dev/dri/renderD128',
    '-i',
    'in.mkv',
    '-c:v',
    'h264_vaapi',
    'out.mp4',
  ]);
});

test('insertBeforeInput leaves arguments alone when there is nothing to add or no input', () => {
  const args = ['-i', 'in.mkv', 'out.mp4'];
  assert.deepEqual(insertBeforeInput(args, []), args);
  const noInput = ['-c:v', 'h264_vaapi', 'out.mp4'];
  assert.deepEqual(insertBeforeInput(noInput, ['-vaapi_device', '/dev/dri/renderD128']), noInput);
});

test('vaapiProbeOptions keys the probe cache by encoder and render node', () => {
  assert.deepEqual(vaapiProbeOptions('hevc_vaapi', '/dev/dri/renderD129'), {
    inputArgs: ['-vaapi_device', '/dev/dri/renderD129'],
    outputArgs: ['-vf', 'format=nv12,hwupload'],
    cacheKey: 'hevc_vaapi@/dev/dri/renderD129',
  });
});

test('buildHwProbeArgs puts the device before the input and the upload filter before the encoder', () => {
  const args = buildHwProbeArgs(
    'h264_vaapi',
    vaapiProbeOptions('h264_vaapi', '/dev/dri/renderD128')
  );
  assert.equal(args[args.indexOf('-vaapi_device') + 1], '/dev/dri/renderD128');
  assert.ok(args.indexOf('-vaapi_device') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-vf') + 1], 'format=nv12,hwupload');
  assert.ok(args.indexOf('-vf') < args.indexOf('-c:v'));
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi');
});

test('buildHwProbeArgs without options keeps the plain Quick Sync probe command', () => {
  const args = buildHwProbeArgs('h264_qsv');
  assert.equal(args.includes('-vaapi_device'), false);
  assert.equal(args.includes('-vf'), false);
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_qsv');
});

test('a Linux Intel or AMD GPU with no render node is unsupported, with a clear reason', async () => {
  for (const gpu of ['intel', 'amd']) {
    const result = await checkGPUEncoderSupport(gpu, 'h264', undefined, {
      platform: 'linux',
      findRenderNode: () => null,
    });
    assert.equal(result.available, false, gpu);
    assert.match(result.error.message, /render node found/, gpu);
    assert.equal(result.error.canRetryWithCPU, true, gpu);
  }
});

test('Linux Intel and AMD never get hardware decode arguments', async () => {
  for (const gpu of ['intel', 'amd']) {
    for (const codec of ['h264', 'h265', 'av1']) {
      assert.deepEqual(await getHardwareDecodeArgs(gpu, codec, 'linux'), [], `${gpu}/${codec}`);
    }
  }
});

// Failure modes for Qualcomm gating and probing. Written before the change.
//  - Qualcomm passes the gate on x64, Linux or macOS, where no Media Foundation encoder exists
//  - the MF probe runs without -pix_fmt nv12 or hardware forcing, so a software MFT passes
//  - the MF probe shares the bare encoder cache key, so a software result is reused
//  - Qualcomm gets hardware decode arguments that feed GPU frames into the MF encoder
//  - Qualcomm stays on the GPU path after the gate fails, so the encoder cannot start
//  - adding Qualcomm to the CPU fallback breaks the Apple AV1 mapping

const {
  qualcommProbeOptions,
  buildHwProbeArgs: buildMfProbeArgs,
  checkGPUEncoderSupport: checkQualcommSupport,
  getHardwareDecodeArgs: getQualcommDecodeArgs,
} = require('../dist/main/ffmpeg.js');
const { effectiveConversionGpu, supportsQualcomm } = require('../dist/main/gpuEncoders.js');

test('Qualcomm is offered only on Windows on Arm', () => {
  assert.equal(supportsQualcomm('win32', 'arm64'), true);
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['win32', 'ia32'],
    ['linux', 'arm64'],
    ['darwin', 'arm64'],
  ]) {
    assert.equal(supportsQualcomm(platform, arch), false, `${platform}/${arch}`);
  }
});

test('Qualcomm probe forces hardware NV12 output under its own cache key', () => {
  const options = qualcommProbeOptions('h264_mf');
  assert.deepEqual(options.outputArgs, [
    '-pix_fmt',
    'nv12',
    '-hw_encoding',
    '1',
    '-rate_control',
    'quality',
    '-quality',
    '50',
  ]);
  assert.equal(options.cacheKey, 'h264_mf@hw');
  assert.notEqual(options.cacheKey, 'h264_mf');

  const args = buildMfProbeArgs('h264_mf', options);
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'nv12');
  assert.ok(args.indexOf('-pix_fmt') < args.indexOf('-c:v'));
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_mf');
});

test('Qualcomm is unavailable outside Windows on Arm, with a clear reason', async () => {
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'arm64'],
  ]) {
    const result = await checkQualcommSupport('qualcomm', 'h264', undefined, { platform, arch });
    assert.equal(result.available, false, `${platform}/${arch}`);
    assert.equal(result.encoder, 'h264_mf');
    assert.equal(result.error.type, 'encoder_unavailable');
    assert.match(result.error.message, /Windows on Arm/, `${platform}/${arch}`);
    assert.equal(result.error.canRetryWithCPU, true);
  }
});

test('Qualcomm never gets hardware decode arguments', async () => {
  for (const codec of ['h264', 'h265', 'av1']) {
    assert.deepEqual(await getQualcommDecodeArgs('qualcomm', codec, 'win32'), [], codec);
  }
});

test('effectiveConversionGpu sends Qualcomm to CPU outside Windows on Arm', () => {
  assert.equal(effectiveConversionGpu('qualcomm', 'h264', 'win32', 'arm64'), 'qualcomm');
  assert.equal(effectiveConversionGpu('qualcomm', 'h265', 'win32', 'x64'), 'cpu');
  assert.equal(effectiveConversionGpu('qualcomm', 'av1', 'linux', 'arm64'), 'cpu');
  assert.equal(effectiveConversionGpu('apple', 'av1', 'darwin', 'arm64'), 'cpu');
  assert.equal(effectiveConversionGpu('apple', 'h264', 'darwin', 'arm64'), 'apple');
  assert.equal(effectiveConversionGpu('nvidia', 'av1', 'win32', 'x64'), 'nvidia');
});
