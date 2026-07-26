const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SETTINGS_SCHEMA_VERSION,
  MAX_RECENT_PRESET_IDS,
  isSettingsCorrupted,
  isSettingsSchemaOutdated,
  normalizeCustomTheme,
  normalizeRecentPresetIds,
  normalizeSetupWizardCompleted,
  normalizeTheme,
  normalizeUiPanels,
} = require('../dist/main/settingsSchema');
const { normalizeAdvancedFormatSettings } = require('../dist/main/advancedFormats');

test('an outdated schema version is detected and the current one is not', () => {
  assert.equal(isSettingsSchemaOutdated({ settingsSchemaVersion: 1 }), true);
  assert.equal(isSettingsSchemaOutdated({}), true, 'a missing version counts as outdated');
  assert.equal(isSettingsSchemaOutdated({ settingsSchemaVersion: SETTINGS_SCHEMA_VERSION }), false);
});

test('upgrading a legacy settings file keeps valid user choices', () => {
  // Simulates a v1-era file: the upgrade path must not reset deliberate choices.
  const legacy = {
    settingsSchemaVersion: 1,
    theme: 'dark',
    customTheme: 'high-contrast-dark',
    recentPresetIds: ['h265-quality', 'av1-balanced'],
    uiPanels: { presetExpanded: true, gpuExpanded: false },
  };

  assert.equal(isSettingsCorrupted(legacy), false);
  assert.equal(normalizeTheme(legacy.theme), 'dark');
  assert.equal(normalizeCustomTheme(legacy.customTheme), 'high-contrast-dark');
  assert.deepEqual(normalizeRecentPresetIds(legacy.recentPresetIds), [
    'h265-quality',
    'av1-balanced',
  ]);
  assert.deepEqual(normalizeUiPanels(legacy.uiPanels), {
    presetExpanded: true,
    gpuExpanded: false,
  });
});

test('a legacy file without the wizard key is treated as already onboarded', () => {
  // Existing users must not be shown the first-run tour after an upgrade.
  assert.equal(normalizeSetupWizardCompleted(undefined, false), true);
  // A fresh install writes the key explicitly and starts incomplete.
  assert.equal(normalizeSetupWizardCompleted(undefined, true), false);
  assert.equal(normalizeSetupWizardCompleted(true, true), true);
});

test('customised advanced format values survive an upgrade', () => {
  const legacy = {
    av1: { tiers: { balanced: { quality: 27, cpuPreset: 5, audioBitrateKbps: 160 } } },
    gif: { loopMode: 'once', tiers: { balanced: { fps: 20, maxColors: 200 } } },
  };
  const upgraded = normalizeAdvancedFormatSettings(legacy);

  assert.equal(upgraded.av1.tiers.balanced.quality, 27);
  assert.equal(upgraded.av1.tiers.balanced.cpuPreset, 5);
  assert.equal(upgraded.av1.tiers.balanced.audioBitrateKbps, 160);
  assert.equal(upgraded.gif.loopMode, 'once');
  assert.equal(upgraded.gif.tiers.balanced.fps, 20);
  assert.equal(upgraded.gif.tiers.balanced.maxColors, 200);
  // Tiers absent from the legacy file are filled in from defaults.
  assert.ok(upgraded.h265.tiers.balanced.quality > 0);
  assert.ok(upgraded.avi.tiers.balanced.codec);
});

test('out-of-range and hostile values fall back instead of propagating', () => {
  const upgraded = normalizeAdvancedFormatSettings({
    av1: { tiers: { balanced: { quality: 9999, cpuPreset: -5 } } },
    gif: { tiers: { balanced: { fps: 'not-a-number', dither: 'bogus' } } },
  });
  assert.ok(upgraded.av1.tiers.balanced.quality <= 63);
  assert.ok(upgraded.av1.tiers.balanced.cpuPreset >= 0);
  assert.equal(Number.isFinite(upgraded.gif.tiers.balanced.fps), true);
  assert.ok(
    ['sierra2_4a', 'floyd_steinberg', 'bayer', 'none'].includes(upgraded.gif.tiers.balanced.dither)
  );
});

test('recent preset history stays bounded and deduplicated on upgrade', () => {
  const many = Array.from({ length: MAX_RECENT_PRESET_IDS + 10 }, (_, i) => `preset-${i}`);
  assert.equal(normalizeRecentPresetIds(many).length, MAX_RECENT_PRESET_IDS);
  assert.deepEqual(normalizeRecentPresetIds(['a', 'a', 'b', '', '  ']), ['a', 'b']);
  assert.deepEqual(normalizeRecentPresetIds('not-an-array'), []);
});

test('an outdated file is re-persisted at the current version', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(source, /isSettingsSchemaOutdated\(parsed\)/);
  assert.match(source, /shouldPersist = true/);
  // Corrupt files are backed up rather than silently discarded.
  assert.match(source, /corrupt-\$\{Date\.now\(\)\}/);
});
