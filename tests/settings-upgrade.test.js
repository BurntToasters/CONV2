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
const {
  createDefaultAdvancedFormatSettings,
  normalizeAdvancedFormatSettings,
} = require('../dist/main/advancedFormats');
const { migrateLegacyTierDefaults } = require('../dist/main/advancedFormatMigration.js');

// Failure modes for migrateLegacyTierDefaults. Written before advancedFormatMigration.ts.
//  - a customised tier is overwritten by the new default
//  - an untouched legacy tier is not upgraded
//  - a legacy value is matched against a different tier key
//  - a partial tier or a wrong-typed field counts as a match
//  - the input object is mutated
//  - hostile shapes (null, arrays, strings, numbers inside tiers) throw
//  - gif, h264, webp or top-level settings are lost

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

// Re-save of outdated files and corrupt-file backups are covered behaviourally in settings-store.test.js.

const fresh = () => createDefaultAdvancedFormatSettings();
const legacyV6 = (advancedFormatSettings) => ({ settingsSchemaVersion: 6, advancedFormatSettings });
const clone = (value) => JSON.parse(JSON.stringify(value));

test('untouched AV1 tiers from v1.3.x are replaced with the current defaults', () => {
  const input = legacyV6({
    av1: {
      tiers: {
        bestQuality: { quality: 15, cpuPreset: 2, audioBitrateKbps: 256 },
        quality: { quality: 20, cpuPreset: 4, audioBitrateKbps: 192 },
        balanced: { quality: 30, cpuPreset: 6, audioBitrateKbps: 128 },
        bestCompression: { quality: 38, cpuPreset: 2, audioBitrateKbps: 96 },
        compression: { quality: 40, cpuPreset: 6, audioBitrateKbps: 96 },
      },
    },
  });
  const out = migrateLegacyTierDefaults(input);
  assert.deepEqual(out.advancedFormatSettings.av1.tiers, fresh().av1.tiers);
});

test('untouched AV1 tiers from v1.4.0 to v1.6.1 are replaced with the current defaults', () => {
  const input = legacyV6({
    av1: {
      tiers: {
        bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 },
        quality: { quality: 24, cpuPreset: 4, audioBitrateKbps: 192 },
        balanced: { quality: 30, cpuPreset: 6, audioBitrateKbps: 128 },
        bestCompression: { quality: 38, cpuPreset: 2, audioBitrateKbps: 96 },
        compression: { quality: 44, cpuPreset: 6, audioBitrateKbps: 96 },
      },
    },
  });
  const out = migrateLegacyTierDefaults(input);
  assert.deepEqual(out.advancedFormatSettings.av1.tiers, fresh().av1.tiers);
});

test('untouched H.265 tiers from any version are replaced, other tiers left alone', () => {
  const input = legacyV6({
    h265: {
      tiers: {
        bestQuality: {
          quality: 16,
          preset: 'veryslow',
          audioBitrateKbps: 256,
          useAdvancedParams: true,
        },
        quality: { quality: 22, preset: 'slow', audioBitrateKbps: 192, useAdvancedParams: false },
        balanced: {
          quality: 28,
          preset: 'medium',
          audioBitrateKbps: 128,
          useAdvancedParams: false,
        },
        bestCompression: {
          quality: 32,
          preset: 'veryslow',
          audioBitrateKbps: 96,
          useAdvancedParams: true,
        },
      },
    },
  });
  const out = migrateLegacyTierDefaults(input);
  assert.deepEqual(out.advancedFormatSettings.h265.tiers, fresh().h265.tiers);
});

test('untouched AVI tiers from v1.4.x and v1.5.0 to v1.6.1 are replaced', () => {
  const v14 = legacyV6({
    avi: {
      tiers: {
        bestQuality: {
          codec: 'h265',
          quality: 16,
          preset: 'veryslow',
          audioBitrateKbps: 256,
          useAdvancedParams: true,
        },
        bestCompression: {
          codec: 'h265',
          quality: 26,
          preset: 'veryslow',
          audioBitrateKbps: 128,
          useAdvancedParams: true,
        },
        balanced: {
          codec: 'h264',
          quality: 20,
          preset: 'slow',
          audioBitrateKbps: 192,
          useAdvancedParams: false,
        },
      },
    },
  });
  assert.deepEqual(
    migrateLegacyTierDefaults(v14).advancedFormatSettings.avi.tiers,
    fresh().avi.tiers
  );

  const v15 = legacyV6({
    avi: {
      tiers: {
        bestQuality: {
          codec: 'h264',
          quality: 16,
          preset: 'veryslow',
          audioBitrateKbps: 256,
          useAdvancedParams: false,
        },
        bestCompression: {
          codec: 'h264',
          quality: 26,
          preset: 'veryslow',
          audioBitrateKbps: 128,
          useAdvancedParams: false,
        },
        balanced: {
          codec: 'h264',
          quality: 20,
          preset: 'slow',
          audioBitrateKbps: 192,
          useAdvancedParams: false,
        },
      },
    },
  });
  assert.deepEqual(
    migrateLegacyTierDefaults(v15).advancedFormatSettings.avi.tiers,
    fresh().avi.tiers
  );
});

test('customised tiers are kept, including ones that differ by a single field', () => {
  const input = legacyV6({
    av1: {
      tiers: {
        bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 200 },
        balanced: { quality: 27, cpuPreset: 5, audioBitrateKbps: 160 },
      },
    },
    h265: {
      tiers: {
        bestQuality: {
          quality: 16,
          preset: 'veryslow',
          audioBitrateKbps: 256,
          useAdvancedParams: false,
        },
      },
    },
  });
  const out = migrateLegacyTierDefaults(input);
  assert.deepEqual(out.advancedFormatSettings.av1.tiers, input.advancedFormatSettings.av1.tiers);
  assert.deepEqual(out.advancedFormatSettings.h265.tiers, input.advancedFormatSettings.h265.tiers);
});

test('a legacy value under a different tier key is not migrated', () => {
  const input = legacyV6({
    av1: {
      tiers: {
        quality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 },
        bestQuality: { quality: 20, cpuPreset: 4, audioBitrateKbps: 192 },
      },
    },
    h265: {
      tiers: {
        balanced: {
          quality: 16,
          preset: 'veryslow',
          audioBitrateKbps: 256,
          useAdvancedParams: true,
        },
      },
    },
    avi: {
      tiers: {
        bestCompression: {
          codec: 'h265',
          quality: 16,
          preset: 'veryslow',
          audioBitrateKbps: 256,
          useAdvancedParams: true,
        },
        bestQuality: {
          codec: 'h264',
          quality: 26,
          preset: 'veryslow',
          audioBitrateKbps: 128,
          useAdvancedParams: false,
        },
      },
    },
  });
  const out = migrateLegacyTierDefaults(input);
  assert.deepEqual(out.advancedFormatSettings, input.advancedFormatSettings);
});

test('partial tiers and wrong-typed fields are not treated as legacy matches', () => {
  const input = legacyV6({
    av1: {
      tiers: {
        bestQuality: { quality: 18, cpuPreset: 2 },
        quality: { quality: '24', cpuPreset: 4, audioBitrateKbps: 192 },
      },
    },
    h265: {
      tiers: {
        bestCompression: { quality: 32, preset: 'veryslow', audioBitrateKbps: 96 },
      },
    },
  });
  const out = migrateLegacyTierDefaults(input);
  assert.deepEqual(out.advancedFormatSettings, input.advancedFormatSettings);
});

test('migration never mutates the input object', () => {
  const input = legacyV6({
    av1: { tiers: { bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 } } },
  });
  const snapshot = clone(input);
  const out = migrateLegacyTierDefaults(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(out, input);
  assert.notEqual(out.advancedFormatSettings, input.advancedFormatSettings);
  assert.equal(
    out.advancedFormatSettings.av1.tiers.bestQuality.quality,
    fresh().av1.tiers.bestQuality.quality
  );
});

test('migration is idempotent', () => {
  const input = legacyV6({
    av1: { tiers: { bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 } } },
    avi: {
      tiers: {
        balanced: {
          codec: 'h264',
          quality: 20,
          preset: 'slow',
          audioBitrateKbps: 192,
          useAdvancedParams: false,
        },
      },
    },
  });
  const once = migrateLegacyTierDefaults(input);
  assert.deepEqual(migrateLegacyTierDefaults(once), once);
});

test('gif, h264, webp and top-level settings survive the migration', () => {
  const gif = { loopMode: 'once', tiers: { balanced: { fps: 20, maxColors: 200 } } };
  const h264 = { tiers: { quality: { quality: 18, preset: 'slow', audioBitrateKbps: 192 } } };
  const webp = { tiers: { balanced: { fps: 15, maxDimension: 720, quality: 80 } } };
  const input = {
    settingsSchemaVersion: 6,
    theme: 'dark',
    unknownFutureKey: { keep: true },
    advancedFormatSettings: {
      gif,
      h264,
      webp,
      av1: { tiers: { bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 } } },
    },
  };
  const out = migrateLegacyTierDefaults(input);
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.unknownFutureKey, { keep: true });
  assert.deepEqual(out.advancedFormatSettings.gif, gif);
  assert.deepEqual(out.advancedFormatSettings.h264, h264);
  assert.deepEqual(out.advancedFormatSettings.webp, webp);
});

test('hostile shapes pass through unchanged and never throw', () => {
  const hostile = [
    null,
    undefined,
    'text',
    42,
    [],
    [{ advancedFormatSettings: {} }],
    {},
    { advancedFormatSettings: null },
    { advancedFormatSettings: [] },
    { advancedFormatSettings: 'x' },
    { advancedFormatSettings: { av1: null } },
    { advancedFormatSettings: { av1: 'x' } },
    { advancedFormatSettings: { av1: { tiers: 'x' } } },
    { advancedFormatSettings: { av1: { tiers: [] } } },
    { advancedFormatSettings: { av1: { tiers: { bestQuality: null } } } },
    { advancedFormatSettings: { av1: { tiers: { bestQuality: 18 } } } },
    { advancedFormatSettings: { av1: { tiers: { bestQuality: [18, 2, 256] } } } },
    {
      advancedFormatSettings: { avi: { tiers: { balanced: { codec: 'h264', quality: 999999 } } } },
    },
  ];
  for (const value of hostile) {
    const snapshot = clone(value === undefined ? null : value);
    let out;
    assert.doesNotThrow(
      () => {
        out = migrateLegacyTierDefaults(value);
      },
      `threw on ${JSON.stringify(value)}`
    );
    if (value === undefined) {
      assert.equal(out, undefined);
    } else {
      assert.deepEqual(out, snapshot);
    }
  }
});
