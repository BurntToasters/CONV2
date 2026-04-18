const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SETTINGS_SCHEMA_VERSION,
  MAX_RECENT_PRESET_IDS,
  normalizeRecentPresetIds,
  normalizeUiPanels,
  isSettingsCorrupted,
  isSettingsSchemaOutdated,
} = require('../dist/main/settingsSchema.js');
const {
  getAutoVendorPriority,
  recommendGpuVendorFromAvailability,
} = require('../dist/main/gpuRecommendation.js');
const { presets } = require('../dist/main/presets.js');
const { mapPresetsForRenderer } = require('../dist/main/presetProjection.js');

test('settings schema hard reset check is version-gated', () => {
  assert.equal(isSettingsCorrupted(null), true);
  assert.equal(isSettingsCorrupted({}), false);
  assert.equal(isSettingsSchemaOutdated({ settingsSchemaVersion: 1 }), true);
  assert.equal(
    isSettingsSchemaOutdated({
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

test('ui panel normalization defaults to collapsed for missing values', () => {
  assert.deepEqual(normalizeUiPanels(undefined), {
    presetExpanded: false,
    gpuExpanded: false,
  });
  assert.deepEqual(normalizeUiPanels({}), {
    presetExpanded: false,
    gpuExpanded: false,
  });
});

test('ui panel normalization only accepts true values', () => {
  assert.deepEqual(
    normalizeUiPanels({
      presetExpanded: true,
      gpuExpanded: false,
    }),
    {
      presetExpanded: true,
      gpuExpanded: false,
    }
  );
  assert.deepEqual(
    normalizeUiPanels({
      presetExpanded: 'yes',
      gpuExpanded: 1,
    }),
    {
      presetExpanded: false,
      gpuExpanded: false,
    }
  );
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

// --- GPU vendor filtering tests (mirrors renderer getAvailableVendors logic) ---

const GPU_VENDORS = ['nvidia', 'amd', 'intel', 'apple', 'cpu'];
const GPU_CODECS = ['h264', 'h265', 'av1'];

const getAvailableVendors = (payload) => {
  return GPU_VENDORS.filter((vendor) => {
    if (vendor === 'cpu') return true;
    return GPU_CODECS.some((codec) => payload.matrix[codec]?.[vendor]?.available === true);
  });
};

test('getAvailableVendors returns all vendors when all are available', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: true },
        amd: { available: true },
        intel: { available: true },
        apple: { available: true },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['nvidia', 'amd', 'intel', 'apple', 'cpu']);
});

test('getAvailableVendors filters to nvidia + cpu on typical Windows NVIDIA-only system', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
      h265: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
      av1: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['nvidia', 'cpu']);
});

test('getAvailableVendors includes vendor if available for any codec', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: true },
        apple: { available: false },
        cpu: { available: true },
      },
      h265: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
      av1: {
        nvidia: { available: false },
        amd: { available: true },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['nvidia', 'amd', 'intel', 'cpu']);
});

test('getAvailableVendors returns only cpu when no hardware encoders available', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: false },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['cpu']);
});

test('getAvailableVendors handles empty matrix gracefully', () => {
  const payload = { matrix: {} };
  assert.deepEqual(getAvailableVendors(payload), ['cpu']);
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
