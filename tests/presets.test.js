const test = require('node:test');
const assert = require('node:assert/strict');

const {
  presets,
  getPresetById,
  ADVANCED_PRESET_CATEGORIES,
  getVisiblePresetCategories,
  getPresetGpuCodec,
  PRESET_CATEGORY_ORDER,
  PRESET_CATEGORY_LABELS,
} = require('../dist/main/presets.js');
const { GPU_ENCODERS } = require('../dist/main/ffmpeg.js');

const requiredVendors = ['nvidia', 'amd', 'intel', 'apple', 'cpu'];

test('preset ids are unique', () => {
  const ids = presets.map((preset) => preset.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length);
});

test('getPresetById returns the matching preset', () => {
  const first = presets[0];
  assert.ok(first);
  const found = getPresetById(first.id);
  assert.ok(found);
  assert.equal(found.id, first.id);
});

test('all GPU encoder mappings exist', () => {
  for (const codec of Object.keys(GPU_ENCODERS)) {
    for (const vendor of requiredVendors) {
      assert.ok(GPU_ENCODERS[codec][vendor], `${codec}.${vendor} is missing`);
    }
  }
});

test('video presets include expected encoders in args', () => {
  for (const preset of presets) {
    const codec = getPresetGpuCodec(preset);
    if (!codec) {
      continue;
    }
    const cpuArgs = preset.getArgs('input.mp4', `output.${preset.extension}`, 'cpu');
    assert.ok(cpuArgs.includes(GPU_ENCODERS[codec].cpu), `${preset.id} missing CPU encoder`);
    const nvidiaArgs = preset.getArgs('input.mp4', `output.${preset.extension}`, 'nvidia');
    assert.ok(
      nvidiaArgs.includes(GPU_ENCODERS[codec].nvidia),
      `${preset.id} missing NVIDIA encoder`
    );
  }
});

test('preset args end with the output path', () => {
  for (const preset of presets) {
    const output = `output.${preset.extension}`;
    const args = preset.getArgs('input.mp4', output, 'cpu');
    assert.equal(args[args.length - 1], output);
  }
});

test('gif presets exist with expected order and extension', () => {
  const gifPresets = presets.filter((preset) => preset.category === 'gif');
  assert.deepEqual(
    gifPresets.map((preset) => preset.id),
    ['gif-best-quality', 'gif-quality', 'gif-balanced', 'gif-best-compression']
  );
  assert.ok(gifPresets.every((preset) => preset.extension === 'gif'));
});

test('gif category is visible by default', () => {
  assert.equal(ADVANCED_PRESET_CATEGORIES.includes('gif'), false);
  assert.equal(getVisiblePresetCategories(false).includes('gif'), true);
  assert.equal(getVisiblePresetCategories(true).includes('gif'), true);
});

test('avi category still requires advanced presets', () => {
  assert.ok(ADVANCED_PRESET_CATEGORIES.includes('avi'));
  assert.equal(getVisiblePresetCategories(false).includes('avi'), false);
  assert.equal(getVisiblePresetCategories(true).includes('avi'), true);
});

test('preset categories export labels and stable ordering', () => {
  assert.ok(PRESET_CATEGORY_ORDER.includes('gif'));
  assert.equal(PRESET_CATEGORY_LABELS.gif, 'GIF');
  assert.equal(PRESET_CATEGORY_LABELS.h265, 'H.265/HEVC');
});

test('avi gpu codec resolution follows advanced format settings context', () => {
  const preset = presets.find((entry) => entry.id === 'avi-balanced');
  assert.ok(preset);

  const defaultCodec = getPresetGpuCodec(preset);
  assert.equal(defaultCodec, 'h264');

  const overriddenCodec = getPresetGpuCodec(preset, {
    advancedFormatSettings: {
      avi: {
        tiers: {
          balanced: {
            codec: 'h265',
          },
        },
      },
    },
  });
  assert.equal(overriddenCodec, 'h265');
});

test('avi presets carry explicit tier metadata', () => {
  const aviPresets = presets.filter((entry) => entry.category === 'avi');
  const tierById = Object.fromEntries(aviPresets.map((entry) => [entry.id, entry.aviTier]));
  assert.deepEqual(tierById, {
    'avi-best-quality': 'bestQuality',
    'avi-best-compression': 'bestCompression',
    'avi-balanced': 'balanced',
  });
});

// getQualityArgs GPU-specific flags

const { getQualityArgs } = require('../dist/main/presets.js');

test('getQualityArgs: NVENC H.264 has cq, p7 preset, multipass, tune hq, spatial/temporal aq', () => {
  const args = getQualityArgs('nvidia', 23, 'h264');
  assert.ok(args.includes('-cq'));
  assert.equal(args[args.indexOf('-preset') + 1], 'p7');
  assert.equal(args[args.indexOf('-multipass') + 1], 'fullres');
  assert.equal(args[args.indexOf('-tune') + 1], 'hq');
  assert.ok(args.includes('-spatial_aq'));
  assert.ok(args.includes('-temporal_aq'));
});

test('getQualityArgs: NVENC AV1 omits tune/spatial_aq/temporal_aq', () => {
  const args = getQualityArgs('nvidia', 30, 'av1');
  assert.ok(!args.includes('-tune'));
  assert.ok(!args.includes('-spatial_aq'));
  assert.ok(!args.includes('-temporal_aq'));
  assert.ok(args.includes('-multipass'));
});

test('getQualityArgs: AMF includes -quality quality preset', () => {
  const args = getQualityArgs('amd', 22, 'h265');
  assert.ok(args.includes('-quality'));
  assert.equal(args[args.indexOf('-quality') + 1], 'quality');
});

test('getQualityArgs: Intel QSV H.264 includes look-ahead and extbrc', () => {
  const args = getQualityArgs('intel', 23, 'h264');
  assert.ok(args.includes('-look_ahead'));
  assert.ok(args.includes('-look_ahead_depth'));
  assert.ok(args.includes('-extbrc'));
});

test('getQualityArgs: Intel QSV AV1 omits look-ahead and extbrc', () => {
  const args = getQualityArgs('intel', 30, 'av1');
  assert.ok(!args.includes('-look_ahead'));
  assert.ok(!args.includes('-extbrc'));
  assert.ok(args.includes('-global_quality'));
});

test('getQualityArgs: Apple VT uses -q:v, -allow_sw 1, -realtime 0', () => {
  const args = getQualityArgs('apple', 23, 'h264');
  assert.ok(args.includes('-q:v'));
  assert.equal(args[args.indexOf('-allow_sw') + 1], '1');
  assert.equal(args[args.indexOf('-realtime') + 1], '0');
  assert.ok(!args.includes('-crf'));
});

test('getQualityArgs: CPU uses -crf', () => {
  const args = getQualityArgs('cpu', 23, 'h264');
  assert.equal(args[args.indexOf('-crf') + 1], '23');
});

// pix_fmt for H.264 CPU

test('H.264 CPU preset includes -pix_fmt yuv420p', () => {
  const preset = presets.find((p) => p.id === 'h264-fast');
  const args = preset.getArgs('/input.mp4', '/output.mp4', 'cpu');
  assert.ok(args.includes('-pix_fmt'));
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('H.264 NVENC preset does NOT include -pix_fmt', () => {
  const preset = presets.find((p) => p.id === 'h264-fast');
  const args = preset.getArgs('/input.mp4', '/output.mp4', 'nvidia');
  assert.ok(!args.includes('-pix_fmt'));
});

test('AVI balanced (H.264 CPU) includes -pix_fmt yuv420p', () => {
  const preset = presets.find((p) => p.id === 'avi-balanced');
  const args = preset.getArgs('/input.mp4', '/output.avi', 'cpu');
  assert.ok(args.includes('-pix_fmt'), 'avi-balanced H.264 CPU must force yuv420p');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('AVI best-quality (H.264 CPU) includes -pix_fmt yuv420p', () => {
  const preset = presets.find((p) => p.id === 'avi-best-quality');
  const args = preset.getArgs('/input.mp4', '/output.avi', 'cpu');
  assert.ok(
    args.includes('-pix_fmt'),
    'avi-best-quality now defaults to H.264 and must force yuv420p'
  );
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
});

test('AVI presets use MP3 audio (libmp3lame), not AAC', () => {
  for (const id of ['avi-best-quality', 'avi-best-compression', 'avi-balanced']) {
    const preset = presets.find((p) => p.id === id);
    assert.ok(preset, `missing ${id}`);
    const args = preset.getArgs('/input.mp4', '/output.avi', 'cpu');
    assert.equal(args[args.indexOf('-c:a') + 1], 'libmp3lame', `${id}: AVI audio must be MP3`);
    assert.ok(!args.includes('aac'), `${id}: AVI must not use AAC audio`);
  }
});

// GIF filter quality

test('GIF best-quality filter includes stats_mode=full', () => {
  const preset = presets.find((p) => p.id === 'gif-best-quality');
  const args = preset.getArgs('/input.mp4', '/output.gif', 'cpu');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('stats_mode=full'));
});

test('GIF filter includes diff_mode=rectangle', () => {
  const preset = presets.find((p) => p.id === 'gif-balanced');
  const args = preset.getArgs('/input.mp4', '/output.gif', 'cpu');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('diff_mode=rectangle'));
});

test('GIF bayer tier includes bayer_scale=5', () => {
  for (const preset of presets.filter((p) => p.category === 'gif')) {
    const args = preset.getArgs('/input.mp4', '/output.gif', 'cpu');
    const filter = args[args.indexOf('-filter_complex') + 1];
    if (filter.includes('dither=bayer')) {
      assert.ok(filter.includes('bayer_scale=5'), `${preset.id}: bayer dither needs bayer_scale=5`);
    }
  }
});

// Remux + audio metadata

test('remux-mp4 preserves metadata with -map_metadata 0', () => {
  const preset = presets.find((p) => p.id === 'remux-mp4');
  const args = preset.getArgs('/in.mkv', '/out.mp4', 'cpu');
  assert.ok(args.includes('-map_metadata'));
  assert.equal(args[args.indexOf('-map_metadata') + 1], '0');
});

test('remux-mkv and remux-webm preserve metadata', () => {
  for (const id of ['remux-mkv', 'remux-webm']) {
    const preset = presets.find((p) => p.id === id);
    const args = preset.getArgs('/in.mp4', '/out.' + preset.extension, 'cpu');
    assert.ok(args.includes('-map_metadata'), `${id} needs -map_metadata`);
  }
});

test('audio-mp3 uses VBR (-q:a 2) not CBR', () => {
  const preset = presets.find((p) => p.id === 'audio-mp3');
  const args = preset.getArgs('/in.mp4', '/out.mp3', 'cpu');
  assert.ok(args.includes('-q:a'));
  assert.equal(args[args.indexOf('-q:a') + 1], '2');
  assert.ok(!args.includes('-b:a'));
});

test('all audio presets preserve metadata with -map_metadata 0', () => {
  for (const id of ['audio-mp3', 'audio-aac', 'audio-flac']) {
    const preset = presets.find((p) => p.id === id);
    const args = preset.getArgs('/in.mp4', '/out.' + preset.extension, 'cpu');
    assert.ok(args.includes('-map_metadata'), `${id} needs -map_metadata`);
  }
});
