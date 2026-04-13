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

test('gif category only appears when advanced presets are enabled', () => {
  assert.ok(ADVANCED_PRESET_CATEGORIES.includes('gif'));
  assert.equal(getVisiblePresetCategories(false).includes('gif'), false);
  assert.equal(getVisiblePresetCategories(true).includes('gif'), true);
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
