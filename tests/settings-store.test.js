const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ALLOWED_SETTINGS_KEYS,
  createDefaultSettings,
  normalizeGpuVendor,
  normalizeSettings,
  readSettingsFile,
  writeJsonAtomic,
} = require('../dist/main/settingsStore.js');
const { SETTINGS_SCHEMA_VERSION } = require('../dist/main/settingsSchema.js');
const { createDefaultAdvancedFormatSettings } = require('../dist/main/advancedFormats.js');

// Failure modes for reading/writing settings.json. Written before settingsStore.ts.
//  - a corrupt or truncated file crashes startup or is silently thrown away (no backup)
//  - an outdated schema is read but never re-saved at the current version
//  - a crash mid-save leaves a .tmp that shadows or corrupts the next load
//  - a partial write replaces a good file
//  - renderer-supplied junk (relative paths, wrong types, unknown keys) survives normalisation

const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-settings-'));
  try {
    return fn(dir, path.join(dir, 'settings.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const backups = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));

test('missing file yields defaults and nothing to persist', () => {
  withDir((dir, file) => {
    const result = readSettingsFile(file);
    assert.deepEqual(result.settings, createDefaultSettings());
    assert.equal(result.shouldPersist, false);
  });
});

test('first-run defaults keep the setup tour pending', () => {
  assert.equal(createDefaultSettings().setupWizardCompleted, false);
});

test('unparseable JSON is backed up and replaced with defaults', () => {
  withDir((dir, file) => {
    fs.writeFileSync(file, '{"theme": "dark", ');
    const result = readSettingsFile(file);
    assert.deepEqual(result.settings, createDefaultSettings());
    assert.equal(result.shouldPersist, true);
    assert.equal(backups(dir).length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups(dir)[0]), 'utf8'), '{"theme": "dark", ');
  });
});

test('valid JSON of the wrong shape is treated as corrupt', () => {
  withDir((dir, file) => {
    fs.writeFileSync(file, 'null');
    const result = readSettingsFile(file);
    assert.equal(result.shouldPersist, true);
    assert.equal(backups(dir).length, 1);
  });
});

test('an outdated schema is normalised and flagged for re-save', () => {
  withDir((dir, file) => {
    fs.writeFileSync(file, JSON.stringify({ settingsSchemaVersion: 0, theme: 'light' }));
    const result = readSettingsFile(file);
    assert.equal(result.settings.theme, 'light');
    assert.equal(result.settings.settingsSchemaVersion, SETTINGS_SCHEMA_VERSION);
    assert.equal(result.shouldPersist, true);
    assert.deepEqual(backups(dir), []);
  });
});

test('a current file loads without re-saving', () => {
  withDir((dir, file) => {
    fs.writeFileSync(file, JSON.stringify({ ...createDefaultSettings(), theme: 'dark' }));
    const result = readSettingsFile(file);
    assert.equal(result.settings.theme, 'dark');
    assert.equal(result.shouldPersist, false);
  });
});

test('a stale .tmp from a crashed save is removed and never read', () => {
  withDir((dir, file) => {
    fs.writeFileSync(file, JSON.stringify({ ...createDefaultSettings(), theme: 'light' }));
    fs.writeFileSync(`${file}.tmp`, '{ half written');
    assert.equal(readSettingsFile(file).settings.theme, 'light');
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });
});

test('atomic write leaves only the final file and round-trips', () => {
  withDir((dir, file) => {
    const value = { ...createDefaultSettings(), theme: 'light' };
    writeJsonAtomic(file, value);
    assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), value);
  });
});

test('a failed write keeps the previous good file', () => {
  withDir((dir, file) => {
    writeJsonAtomic(file, { theme: 'dark' });
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => writeJsonAtomic(file, cyclic));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark' });
  });
});

test('normalisation drops relative output folders and wrong types', () => {
  const normalized = normalizeSettings({
    outputDirectory: 'relative/out',
    gpu: 'quantum',
    gpuMode: 'sometimes',
    updateChannel: 'nightly',
    interfaceStyle: 'neon',
    autoCheckUpdates: 'no',
    recentPresetIds: 'h264-fast',
  });
  assert.equal(normalized.outputDirectory, '');
  assert.equal(normalized.gpu, 'cpu');
  assert.equal(normalized.gpuMode, 'auto');
  assert.equal(normalized.updateChannel, 'auto');
  assert.equal(normalized.interfaceStyle, 'glass');
  assert.equal(normalized.autoCheckUpdates, true);
  assert.deepEqual(normalized.recentPresetIds, []);
});

test('normalisation keeps an absolute output folder', () => {
  const absolute = path.resolve(os.tmpdir(), 'conv2-out');
  assert.equal(normalizeSettings({ outputDirectory: `  ${absolute}  ` }).outputDirectory, absolute);
});

test('renderer-writable keys exclude the schema version', () => {
  assert.equal(ALLOWED_SETTINGS_KEYS.has('settingsSchemaVersion'), false);
  assert.ok(ALLOWED_SETTINGS_KEYS.has('theme'));
});

// Failure modes for the v7 tier-default migration, driven through readSettingsFile.
//  - an old shipped tier is kept, so existing users never get the faster defaults
//  - a v7+ file is migrated again, overriding a value the user re-picked
//  - a customised tier in an old file is overwritten
//  - an unversioned or string-versioned file is not migrated
//  - hostile tier values crash the read instead of falling back to defaults
const legacyFile = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value));
  return readSettingsFile(file);
};

test('an old file with untouched legacy tier defaults gets the current defaults and is re-saved', () => {
  withDir((dir, file) => {
    const defaults = createDefaultAdvancedFormatSettings();
    const result = legacyFile(file, {
      ...createDefaultSettings(),
      settingsSchemaVersion: 6,
      theme: 'dark',
      advancedFormatSettings: {
        av1: {
          tiers: {
            bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 },
            balanced: { quality: 30, cpuPreset: 6, audioBitrateKbps: 128 },
          },
        },
        h265: {
          tiers: {
            bestCompression: {
              quality: 32,
              preset: 'veryslow',
              audioBitrateKbps: 96,
              useAdvancedParams: true,
            },
          },
        },
      },
    });
    assert.equal(result.settings.theme, 'dark');
    assert.deepEqual(
      result.settings.advancedFormatSettings.av1.tiers.bestQuality,
      defaults.av1.tiers.bestQuality
    );
    assert.deepEqual(
      result.settings.advancedFormatSettings.h265.tiers.bestCompression,
      defaults.h265.tiers.bestCompression
    );
    assert.equal(result.shouldPersist, true);
  });
});

test('an unversioned or string-versioned file has its legacy AVI tiers migrated', () => {
  withDir((dir, file) => {
    const defaults = createDefaultAdvancedFormatSettings();
    const legacyAvi = {
      bestQuality: {
        codec: 'h265',
        quality: 16,
        preset: 'veryslow',
        audioBitrateKbps: 256,
        useAdvancedParams: true,
      },
    };
    const unversioned = legacyFile(file, {
      advancedFormatSettings: { avi: { tiers: legacyAvi } },
    });
    assert.deepEqual(
      unversioned.settings.advancedFormatSettings.avi.tiers.bestQuality,
      defaults.avi.tiers.bestQuality
    );
    const stringVersion = legacyFile(file, {
      settingsSchemaVersion: '6',
      advancedFormatSettings: { avi: { tiers: legacyAvi } },
    });
    assert.deepEqual(
      stringVersion.settings.advancedFormatSettings.avi.tiers.bestQuality,
      defaults.avi.tiers.bestQuality
    );
  });
});

test('a customised tier in an old file is kept while its legacy neighbour is upgraded', () => {
  withDir((dir, file) => {
    const defaults = createDefaultAdvancedFormatSettings();
    const result = legacyFile(file, {
      settingsSchemaVersion: 6,
      advancedFormatSettings: {
        av1: {
          tiers: {
            bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 },
            balanced: { quality: 27, cpuPreset: 5, audioBitrateKbps: 160 },
          },
        },
      },
    });
    const av1 = result.settings.advancedFormatSettings.av1.tiers;
    assert.deepEqual(av1.bestQuality, defaults.av1.tiers.bestQuality);
    assert.deepEqual(av1.balanced, { quality: 27, cpuPreset: 5, audioBitrateKbps: 160 });
  });
});

test('a v7 or newer file keeps a legacy value the user re-picked', () => {
  withDir((dir, file) => {
    for (const version of [SETTINGS_SCHEMA_VERSION, SETTINGS_SCHEMA_VERSION + 1]) {
      const result = legacyFile(file, {
        settingsSchemaVersion: version,
        advancedFormatSettings: {
          av1: { tiers: { bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 } } },
        },
      });
      assert.deepEqual(result.settings.advancedFormatSettings.av1.tiers.bestQuality, {
        quality: 18,
        cpuPreset: 2,
        audioBitrateKbps: 256,
      });
    }
    const current = legacyFile(file, {
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      advancedFormatSettings: {
        av1: { tiers: { bestQuality: { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 } } },
      },
    });
    assert.equal(current.shouldPersist, false);
  });
});

test('hostile tier values in an old file fall back to defaults without crashing', () => {
  withDir((dir, file) => {
    const defaults = createDefaultAdvancedFormatSettings();
    let result;
    assert.doesNotThrow(() => {
      result = legacyFile(file, {
        settingsSchemaVersion: 6,
        advancedFormatSettings: {
          av1: { tiers: { bestQuality: null, quality: 'x', balanced: [1, 2] } },
          avi: { tiers: { balanced: 42 } },
        },
      });
    });
    assert.deepEqual(
      result.settings.advancedFormatSettings.av1.tiers.bestQuality,
      defaults.av1.tiers.bestQuality
    );
    assert.deepEqual(
      result.settings.advancedFormatSettings.avi.tiers.balanced,
      defaults.avi.tiers.balanced
    );
    assert.equal(result.shouldPersist, true);
  });
});

// Failure modes for Qualcomm settings. Written before the change.
//  - a saved 'qualcomm' choice is coerced to 'cpu' on load, dropping the user's pick
//  - an unknown vendor string is accepted and reaches the encoder table
//  - the vendor is matched case-insensitively, so 'Qualcomm' from a hand-edited file passes

test('normalizeGpuVendor accepts qualcomm and rejects unknown vendors', () => {
  assert.equal(normalizeGpuVendor('qualcomm'), 'qualcomm');
  assert.equal(normalizeGpuVendor('Qualcomm'), 'cpu');
  assert.equal(normalizeGpuVendor('snapdragon'), 'cpu');
  assert.equal(normalizeGpuVendor('intel'), 'intel');
});

test('a saved qualcomm manual vendor survives settings normalisation', () => {
  const normalized = normalizeSettings({ gpuManualVendor: 'qualcomm', gpuMode: 'manual' });
  assert.equal(normalized.gpuManualVendor, 'qualcomm');
  assert.equal(normalized.gpu, 'qualcomm');
});
