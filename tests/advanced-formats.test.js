const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDefaultAdvancedFormatSettings,
  normalizeAdvancedFormatSettings,
  mergeAdvancedFormatSettings,
} = require('../dist/main/advancedFormats.js');

test('normalizeAdvancedFormatSettings returns defaults when values are missing', () => {
  const normalized = normalizeAdvancedFormatSettings({});
  assert.equal(normalized.gif.loopMode, 'forever');
  assert.deepEqual(normalized.gif.tiers.bestQuality, {
    fps: 15,
    maxDimension: 1080,
    maxColors: 256,
    dither: 'sierra2_4a',
  });
  assert.deepEqual(normalized.gif.tiers.quality, {
    fps: 12,
    maxDimension: 900,
    maxColors: 224,
    dither: 'sierra2_4a',
  });
  assert.deepEqual(normalized.gif.tiers.balanced, {
    fps: 10,
    maxDimension: 720,
    maxColors: 192,
    dither: 'bayer',
  });
  assert.deepEqual(normalized.gif.tiers.bestCompression, {
    fps: 8,
    maxDimension: 540,
    maxColors: 128,
    dither: 'none',
  });

  assert.deepEqual(normalized.av1.tiers.bestQuality, {
    quality: 15,
    cpuPreset: 2,
    audioBitrateKbps: 256,
  });
  assert.deepEqual(normalized.h264.tiers.fast, {
    quality: 23,
    preset: 'fast',
    audioBitrateKbps: 128,
  });
  assert.deepEqual(normalized.h265.tiers.bestCompression, {
    quality: 32,
    preset: 'veryslow',
    audioBitrateKbps: 96,
    useAdvancedParams: true,
  });
  assert.deepEqual(normalized.avi.tiers.balanced, {
    codec: 'h264',
    quality: 20,
    preset: 'slow',
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
  assert.equal(normalized.avi.tiers.balanced.preset, 'slow');
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
