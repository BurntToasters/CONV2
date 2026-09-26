const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ALLOWED_SETTINGS_KEYS,
  createDefaultSettings,
  normalizeSettings,
  readSettingsFile,
  writeJsonAtomic,
} = require('../dist/main/settingsStore.js');
const { SETTINGS_SCHEMA_VERSION } = require('../dist/main/settingsSchema.js');

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
