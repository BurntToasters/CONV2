const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SETTINGS_SCHEMA_VERSION,
  MAX_RECENT_PRESET_IDS,
  normalizeRecentPresetIds,
  shouldHardResetSettings,
} = require('../dist/main/settingsSchema.js');
const {
  getAutoVendorPriority,
  recommendGpuVendorFromAvailability,
} = require('../dist/main/gpuRecommendation.js');
const { presets } = require('../dist/main/presets.js');
const { mapPresetsForRenderer } = require('../dist/main/presetProjection.js');

test('settings schema hard reset check is version-gated', () => {
  assert.equal(shouldHardResetSettings(null), true);
  assert.equal(shouldHardResetSettings({}), true);
  assert.equal(shouldHardResetSettings({ settingsSchemaVersion: 1 }), true);
  assert.equal(
    shouldHardResetSettings({
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      outputDirectory: '/tmp',
    }),
    false
  );
});

test('recent preset normalization dedupes, trims, and caps size', () => {
  const result = normalizeRecentPresetIds([
    ' av1-balanced ',
    'h264-fast',
    'av1-balanced',
    '',
    '   ',
    'h265-quality',
    'audio-mp3',
    'audio-aac',
    'audio-flac',
    'remux-mp4',
    'remux-mkv',
    'remux-webm',
    'gif-quality',
  ]);

  assert.equal(result.length, MAX_RECENT_PRESET_IDS);
  assert.deepEqual(result.slice(0, 4), ['av1-balanced', 'h264-fast', 'h265-quality', 'audio-mp3']);
});

test('auto priority order follows platform heuristic', () => {
  assert.deepEqual(getAutoVendorPriority('darwin'), ['apple', 'intel', 'amd', 'nvidia', 'cpu']);
  assert.deepEqual(getAutoVendorPriority('win32'), ['nvidia', 'intel', 'amd', 'apple', 'cpu']);
  assert.deepEqual(getAutoVendorPriority('linux'), ['nvidia', 'intel', 'amd', 'apple', 'cpu']);
});

test('recommendation selects first available vendor by platform priority', () => {
  const darwinPick = recommendGpuVendorFromAvailability('darwin', 'h265', {
    nvidia: false,
    amd: true,
    intel: true,
    apple: false,
    cpu: true,
  });
  assert.equal(darwinPick.vendor, 'intel');

  const winPick = recommendGpuVendorFromAvailability('win32', 'h264', {
    nvidia: true,
    amd: true,
    intel: true,
    apple: false,
    cpu: true,
  });
  assert.equal(winPick.vendor, 'nvidia');

  const cpuPick = recommendGpuVendorFromAvailability('linux', 'av1', {
    nvidia: false,
    amd: false,
    intel: false,
    apple: false,
    cpu: true,
  });
  assert.equal(cpuPick.vendor, 'cpu');

  const nonVideoPick = recommendGpuVendorFromAvailability('linux', null, {
    nvidia: true,
    amd: true,
    intel: true,
    apple: true,
    cpu: true,
  });
  assert.equal(nonVideoPick.vendor, 'cpu');
});

test('renderer preset projection includes extension and aviTier with stable ids', () => {
  const projected = mapPresetsForRenderer(presets);

  assert.equal(projected.length, presets.length);
  assert.deepEqual(
    projected.map((entry) => entry.id),
    presets.map((entry) => entry.id)
  );
  projected.forEach((entry) => {
    assert.equal(typeof entry.extension, 'string');
    assert.ok(entry.extension.length > 0);
    assert.ok(entry.aviTier === null || typeof entry.aviTier === 'string');
  });

  const aviProjected = projected.find((entry) => entry.id === 'avi-balanced');
  assert.ok(aviProjected);
  assert.equal(aviProjected.aviTier, 'balanced');
});
