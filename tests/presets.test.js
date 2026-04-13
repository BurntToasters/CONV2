const test = require('node:test');
const assert = require('node:assert/strict');

const {
  presets,
  getPresetById,
  ADVANCED_PRESET_CATEGORIES,
  getVisiblePresetCategories,
} = require('../dist/main/presets.js');
const { GPU_ENCODERS } = require('../dist/main/ffmpeg.js');

const videoCategories = new Set(['av1', 'h264', 'h265']);
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
    if (!videoCategories.has(preset.category)) {
      continue;
    }
    const cpuArgs = preset.getArgs('input.mp4', `output.${preset.extension}`, 'cpu');
    assert.ok(
      cpuArgs.includes(GPU_ENCODERS[preset.category].cpu),
      `${preset.id} missing CPU encoder`
    );
    const nvidiaArgs = preset.getArgs('input.mp4', `output.${preset.extension}`, 'nvidia');
    assert.ok(
      nvidiaArgs.includes(GPU_ENCODERS[preset.category].nvidia),
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
