const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDefaultAdvancedFormatSettings,
  normalizeAdvancedFormatSettings,
  mergeAdvancedFormatSettings,
} = require('../dist/main/advancedFormats.js');

test('normalizeAdvancedFormatSettings returns defaults when values are missing', () => {
  const normalized = normalizeAdvancedFormatSettings({});
  const defaults = createDefaultAdvancedFormatSettings();
  assert.deepEqual(normalized, defaults);
});

test('normalizeAdvancedFormatSettings clamps invalid gif tier values', () => {
  const normalized = normalizeAdvancedFormatSettings({
    gif: {
      loopMode: 'invalid',
      tiers: {
        bestQuality: {
          fps: 200,
          maxDimension: 10,
          maxColors: 1000,
          dither: 'not-real',
        },
      },
    },
  });

  assert.equal(normalized.gif.loopMode, 'forever');
  assert.equal(normalized.gif.tiers.bestQuality.fps, 60);
  assert.equal(normalized.gif.tiers.bestQuality.maxDimension, 160);
  assert.equal(normalized.gif.tiers.bestQuality.maxColors, 256);
  assert.equal(normalized.gif.tiers.bestQuality.dither, 'sierra2_4a');
});

test('mergeAdvancedFormatSettings applies partial nested gif updates', () => {
  const current = createDefaultAdvancedFormatSettings();
  const merged = mergeAdvancedFormatSettings(current, {
    gif: {
      loopMode: 'once',
      tiers: {
        quality: {
          fps: 18,
        },
      },
    },
  });

  assert.equal(merged.gif.loopMode, 'once');
  assert.equal(merged.gif.tiers.quality.fps, 18);
  assert.equal(merged.gif.tiers.quality.maxDimension, current.gif.tiers.quality.maxDimension);
  assert.equal(
    merged.gif.tiers.bestCompression.maxColors,
    current.gif.tiers.bestCompression.maxColors
  );
});

test('mergeAdvancedFormatSettings falls back on invalid nested values', () => {
  const current = createDefaultAdvancedFormatSettings();
  const merged = mergeAdvancedFormatSettings(current, {
    gif: {
      tiers: {
        bestCompression: {
          fps: -5,
          dither: 'unknown',
        },
      },
    },
  });

  assert.equal(merged.gif.tiers.bestCompression.fps, 1);
  assert.equal(merged.gif.tiers.bestCompression.dither, current.gif.tiers.bestCompression.dither);
});
