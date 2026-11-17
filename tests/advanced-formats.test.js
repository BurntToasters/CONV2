const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDefaultAdvancedFormatSettings,
  createDefaultWebpAdvancedSettings,
  normalizeAdvancedFormatSettings,
  mergeAdvancedFormatSettings,
} = require('../dist/main/advancedFormats.js');

test('normalizeAdvancedFormatSettings returns defaults when values are missing', () => {
  const normalized = normalizeAdvancedFormatSettings({});
  assert.equal(normalized.gif.loopMode, 'forever');
  assert.deepEqual(normalized.gif.tiers.bestQuality, {
    fps: 15,
    maxDimension: 720,
    maxColors: 256,
    dither: 'bayer',
  });
  assert.deepEqual(normalized.gif.tiers.quality, {
    fps: 12,
    maxDimension: 600,
    maxColors: 192,
    dither: 'bayer',
  });
  assert.deepEqual(normalized.gif.tiers.balanced, {
    fps: 12,
    maxDimension: 480,
    maxColors: 128,
    dither: 'bayer',
  });
  assert.deepEqual(normalized.gif.tiers.bestCompression, {
    fps: 10,
    maxDimension: 360,
    maxColors: 64,
    dither: 'none',
  });

  assert.deepEqual(normalized.av1.tiers.bestQuality, {
    quality: 18,
    cpuPreset: 4,
    audioBitrateKbps: 192,
  });
  assert.deepEqual(normalized.h264.tiers.fast, {
    quality: 23,
    preset: 'fast',
    audioBitrateKbps: 128,
  });
  assert.deepEqual(normalized.h265.tiers.bestCompression, {
    quality: 32,
    preset: 'slow',
    audioBitrateKbps: 96,
    useAdvancedParams: true,
  });
  assert.deepEqual(normalized.avi.tiers.balanced, {
    codec: 'h264',
    quality: 20,
    preset: 'medium',
    audioBitrateKbps: 192,
    useAdvancedParams: false,
  });
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
  assert.equal(normalized.gif.tiers.bestQuality.fps, 50);
  assert.equal(normalized.gif.tiers.bestQuality.maxDimension, 160);
  assert.equal(normalized.gif.tiers.bestQuality.maxColors, 256);
  assert.equal(normalized.gif.tiers.bestQuality.dither, 'bayer');
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

test('normalizeAdvancedFormatSettings handles numeric strings and rounds values', () => {
  const normalized = normalizeAdvancedFormatSettings({
    gif: {
      loopMode: 'once',
      tiers: {
        balanced: {
          fps: '10.6',
          maxDimension: '721.2',
          maxColors: '191.5',
          dither: 'floyd_steinberg',
        },
      },
    },
  });

  assert.equal(normalized.gif.loopMode, 'once');
  assert.equal(normalized.gif.tiers.balanced.fps, 11);
  assert.equal(normalized.gif.tiers.balanced.maxDimension, 721);
  assert.equal(normalized.gif.tiers.balanced.maxColors, 192);
  assert.equal(normalized.gif.tiers.balanced.dither, 'floyd_steinberg');
});

test('normalizeAdvancedFormatSettings clamps invalid values for non-gif formats', () => {
  const normalized = normalizeAdvancedFormatSettings({
    av1: {
      tiers: {
        bestCompression: {
          quality: -10,
          cpuPreset: 99,
          audioBitrateKbps: 10000,
        },
      },
    },
    h264: {
      tiers: {
        fast: {
          quality: 999,
          preset: 'invalid',
          audioBitrateKbps: 1,
        },
      },
    },
    h265: {
      tiers: {
        quality: {
          quality: 0,
          preset: 'ultrafast',
          audioBitrateKbps: 4096,
          useAdvancedParams: 'nope',
        },
      },
    },
    avi: {
      tiers: {
        balanced: {
          codec: 'invalid',
          quality: 999,
          preset: 'bad',
          audioBitrateKbps: -1,
          useAdvancedParams: true,
        },
      },
    },
  });

  assert.equal(normalized.av1.tiers.bestCompression.quality, 1);
  assert.equal(normalized.av1.tiers.bestCompression.cpuPreset, 13);
  assert.equal(normalized.av1.tiers.bestCompression.audioBitrateKbps, 512);

  assert.equal(normalized.h264.tiers.fast.quality, 51);
  assert.equal(normalized.h264.tiers.fast.preset, 'fast');
  assert.equal(normalized.h264.tiers.fast.audioBitrateKbps, 32);

  assert.equal(normalized.h265.tiers.quality.quality, 1);
  assert.equal(normalized.h265.tiers.quality.preset, 'ultrafast');
  assert.equal(normalized.h265.tiers.quality.audioBitrateKbps, 512);
  assert.equal(normalized.h265.tiers.quality.useAdvancedParams, false);

  assert.equal(normalized.avi.tiers.balanced.codec, 'h264');
  assert.equal(normalized.avi.tiers.balanced.quality, 51);
  assert.equal(normalized.avi.tiers.balanced.preset, 'medium');
  assert.equal(normalized.avi.tiers.balanced.audioBitrateKbps, 32);
  assert.equal(normalized.avi.tiers.balanced.useAdvancedParams, true);
});

test('mergeAdvancedFormatSettings preserves unaffected tiers across partial updates', () => {
  const current = createDefaultAdvancedFormatSettings();
  const merged = mergeAdvancedFormatSettings(current, {
    gif: {
      tiers: {
        bestQuality: {
          fps: 17,
        },
      },
    },
  });

  assert.equal(merged.gif.tiers.bestQuality.fps, 17);
  assert.deepEqual(merged.gif.tiers.quality, current.gif.tiers.quality);
  assert.deepEqual(merged.gif.tiers.balanced, current.gif.tiers.balanced);
  assert.deepEqual(merged.gif.tiers.bestCompression, current.gif.tiers.bestCompression);
});

test('mergeAdvancedFormatSettings applies partial updates for non-gif formats', () => {
  const current = createDefaultAdvancedFormatSettings();
  const merged = mergeAdvancedFormatSettings(current, {
    av1: {
      tiers: {
        compression: {
          quality: 33,
        },
      },
    },
    h264: {
      tiers: {
        quality: {
          preset: 'medium',
        },
      },
    },
    h265: {
      tiers: {
        bestQuality: {
          useAdvancedParams: false,
        },
      },
    },
    avi: {
      tiers: {
        bestCompression: {
          codec: 'h264',
        },
      },
    },
  });

  assert.equal(merged.av1.tiers.compression.quality, 33);
  assert.equal(merged.av1.tiers.compression.cpuPreset, current.av1.tiers.compression.cpuPreset);
  assert.equal(merged.h264.tiers.quality.preset, 'medium');
  assert.equal(
    merged.h264.tiers.quality.audioBitrateKbps,
    current.h264.tiers.quality.audioBitrateKbps
  );
  assert.equal(merged.h265.tiers.bestQuality.useAdvancedParams, false);
  assert.equal(merged.avi.tiers.bestCompression.codec, 'h264');
  assert.equal(merged.avi.tiers.balanced.codec, current.avi.tiers.balanced.codec);
});

test('createDefaultAdvancedFormatSettings sets updated av1, h265 and avi defaults', () => {
  const defaults = createDefaultAdvancedFormatSettings();

  assert.deepEqual(defaults.av1.tiers, {
    bestQuality: { quality: 18, cpuPreset: 4, audioBitrateKbps: 192 },
    quality: { quality: 24, cpuPreset: 5, audioBitrateKbps: 160 },
    balanced: { quality: 30, cpuPreset: 6, audioBitrateKbps: 128 },
    bestCompression: { quality: 38, cpuPreset: 4, audioBitrateKbps: 96 },
    compression: { quality: 44, cpuPreset: 8, audioBitrateKbps: 96 },
  });
  assert.deepEqual(defaults.h265.tiers, {
    bestQuality: { quality: 16, preset: 'slow', audioBitrateKbps: 256, useAdvancedParams: true },
    quality: { quality: 22, preset: 'slow', audioBitrateKbps: 192, useAdvancedParams: false },
    balanced: { quality: 28, preset: 'medium', audioBitrateKbps: 128, useAdvancedParams: false },
    bestCompression: { quality: 32, preset: 'slow', audioBitrateKbps: 96, useAdvancedParams: true },
  });
  assert.deepEqual(defaults.avi.tiers, {
    bestQuality: {
      codec: 'h264',
      quality: 16,
      preset: 'slow',
      audioBitrateKbps: 256,
      useAdvancedParams: false,
    },
    bestCompression: {
      codec: 'h264',
      quality: 26,
      preset: 'slow',
      audioBitrateKbps: 128,
      useAdvancedParams: false,
    },
    balanced: {
      codec: 'h264',
      quality: 20,
      preset: 'medium',
      audioBitrateKbps: 192,
      useAdvancedParams: false,
    },
  });
});

test('normalizeAdvancedFormatSettings caps gif fps at 50', () => {
  const gifFpsFor = (fps) =>
    normalizeAdvancedFormatSettings({ gif: { tiers: { quality: { fps } } } }).gif.tiers.quality.fps;

  assert.equal(gifFpsFor(0), 1);
  assert.equal(gifFpsFor(49), 49);
  assert.equal(gifFpsFor(50), 50);
  assert.equal(gifFpsFor(51), 50);
  assert.equal(gifFpsFor(500), 50);
});

// Webp block failure modes:
// - webp missing or null in input yields no block or non-default values
// - shipped default tier values drift
// - fps accepts 0 or 61, or rejects 60
// - maxDimension accepts 159 or 2161, or misses the 160/2160 clamps
// - quality accepts 0 or 101, or misses the 1/100 clamps
// - unknown or non-string loopMode is not replaced by 'forever'
// - invalid or missing tier values ignore that tier's default
// - numeric strings are not parsed or rounded
// - merge drops untouched webp tiers or loopMode
// - merge with empty input returns shared references
// - defaults are shared between calls, so mutation leaks

const WEBP_DEFAULT_TIERS = {
  bestQuality: { fps: 30, maxDimension: 720, quality: 90 },
  quality: { fps: 24, maxDimension: 600, quality: 80 },
  balanced: { fps: 20, maxDimension: 480, quality: 70 },
  bestCompression: { fps: 15, maxDimension: 360, quality: 50 },
};

test('webp defaults match the shipped tier values', () => {
  const defaults = createDefaultAdvancedFormatSettings();

  assert.equal(defaults.webp.loopMode, 'forever');
  assert.deepEqual(defaults.webp.tiers, WEBP_DEFAULT_TIERS);
  assert.deepEqual(createDefaultWebpAdvancedSettings(), defaults.webp);
});

test('normalizeAdvancedFormatSettings fills webp defaults when the key is missing or null', () => {
  const missing = normalizeAdvancedFormatSettings({ gif: { loopMode: 'once' } });
  const nulled = normalizeAdvancedFormatSettings({ webp: null });

  assert.equal(missing.webp.loopMode, 'forever');
  assert.deepEqual(missing.webp.tiers, WEBP_DEFAULT_TIERS);
  assert.deepEqual(nulled.webp, missing.webp);
});

test('normalizeAdvancedFormatSettings clamps webp tier values', () => {
  const high = normalizeAdvancedFormatSettings({
    webp: { tiers: { bestQuality: { fps: 200, maxDimension: 9999, quality: 500 } } },
  });
  const low = normalizeAdvancedFormatSettings({
    webp: { tiers: { bestQuality: { fps: 0, maxDimension: 10, quality: 0 } } },
  });
  const edges = normalizeAdvancedFormatSettings({
    webp: { tiers: { bestQuality: { fps: 60, maxDimension: 2160, quality: 100 } } },
  });
  const pastEdges = normalizeAdvancedFormatSettings({
    webp: { tiers: { bestQuality: { fps: 61, maxDimension: 2161, quality: 101 } } },
  });
  const lowEdges = normalizeAdvancedFormatSettings({
    webp: { tiers: { bestQuality: { fps: 1, maxDimension: 160, quality: 1 } } },
  });

  assert.deepEqual(high.webp.tiers.bestQuality, { fps: 60, maxDimension: 2160, quality: 100 });
  assert.deepEqual(low.webp.tiers.bestQuality, { fps: 1, maxDimension: 160, quality: 1 });
  assert.deepEqual(edges.webp.tiers.bestQuality, { fps: 60, maxDimension: 2160, quality: 100 });
  assert.deepEqual(pastEdges.webp.tiers.bestQuality, {
    fps: 60,
    maxDimension: 2160,
    quality: 100,
  });
  assert.deepEqual(lowEdges.webp.tiers.bestQuality, { fps: 1, maxDimension: 160, quality: 1 });
});

test('normalizeAdvancedFormatSettings falls back to the tier default for invalid webp values', () => {
  const normalized = normalizeAdvancedFormatSettings({
    webp: { tiers: { quality: { fps: 'abc', maxDimension: null, quality: 'nope' } } },
  });

  assert.deepEqual(normalized.webp.tiers.quality, WEBP_DEFAULT_TIERS.quality);
});

test('normalizeAdvancedFormatSettings rounds numeric webp strings', () => {
  const normalized = normalizeAdvancedFormatSettings({
    webp: { tiers: { balanced: { fps: '10.6', maxDimension: '721.2', quality: '69.5' } } },
  });

  assert.deepEqual(normalized.webp.tiers.balanced, { fps: 11, maxDimension: 721, quality: 70 });
});

test('normalizeAdvancedFormatSettings normalizes webp loopMode like gif', () => {
  const invalid = normalizeAdvancedFormatSettings({ webp: { loopMode: 'invalid' } });
  const numeric = normalizeAdvancedFormatSettings({ webp: { loopMode: 5 } });
  const once = normalizeAdvancedFormatSettings({ webp: { loopMode: 'once' } });

  assert.equal(invalid.webp.loopMode, 'forever');
  assert.equal(numeric.webp.loopMode, 'forever');
  assert.equal(once.webp.loopMode, 'once');
});

test('mergeAdvancedFormatSettings applies partial nested webp updates', () => {
  const current = createDefaultAdvancedFormatSettings();
  const merged = mergeAdvancedFormatSettings(current, {
    webp: {
      loopMode: 'once',
      tiers: { quality: { quality: 75 } },
    },
  });

  assert.equal(merged.webp.loopMode, 'once');
  assert.equal(merged.webp.tiers.quality.quality, 75);
  assert.equal(merged.webp.tiers.quality.fps, current.webp.tiers.quality.fps);
  assert.equal(merged.webp.tiers.quality.maxDimension, current.webp.tiers.quality.maxDimension);
  assert.deepEqual(merged.webp.tiers.bestQuality, current.webp.tiers.bestQuality);
  assert.deepEqual(merged.webp.tiers.balanced, current.webp.tiers.balanced);
  assert.deepEqual(merged.webp.tiers.bestCompression, current.webp.tiers.bestCompression);
});

test('mergeAdvancedFormatSettings falls back on invalid nested webp values', () => {
  const current = createDefaultAdvancedFormatSettings();
  const merged = mergeAdvancedFormatSettings(current, {
    webp: {
      tiers: { bestCompression: { fps: -5, quality: 'x' } },
    },
  });

  assert.equal(merged.webp.tiers.bestCompression.fps, 1);
  assert.equal(
    merged.webp.tiers.bestCompression.quality,
    current.webp.tiers.bestCompression.quality
  );
  assert.equal(
    merged.webp.tiers.bestCompression.maxDimension,
    current.webp.tiers.bestCompression.maxDimension
  );
});

test('mergeAdvancedFormatSettings keeps webp when the key is absent or the input is empty', () => {
  const current = createDefaultAdvancedFormatSettings();
  const absent = mergeAdvancedFormatSettings(current, { gif: { loopMode: 'once' } });
  const empty = mergeAdvancedFormatSettings(current, {});

  assert.deepEqual(absent.webp, current.webp);
  assert.deepEqual(empty.webp, current.webp);
  assert.notEqual(empty.webp.tiers.quality, current.webp.tiers.quality);
});

test('createDefaultAdvancedFormatSettings returns independent webp objects', () => {
  const first = createDefaultAdvancedFormatSettings();
  first.webp.tiers.quality.fps = 99;
  const second = createDefaultAdvancedFormatSettings();

  assert.equal(second.webp.tiers.quality.fps, WEBP_DEFAULT_TIERS.quality.fps);
});
