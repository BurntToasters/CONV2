export type GifLoopMode = 'forever' | 'once';
export type GifDither = 'sierra2_4a' | 'floyd_steinberg' | 'bayer' | 'none';
export type VideoPreset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'
  | 'placebo';
export type AviCodec = 'h264' | 'h265';

export interface GifTierSettings {
  fps: number;
  maxDimension: number;
  maxColors: number;
  dither: GifDither;
}

export interface GifTierCollection {
  bestQuality: GifTierSettings;
  quality: GifTierSettings;
  balanced: GifTierSettings;
  bestCompression: GifTierSettings;
}

export interface GifAdvancedSettings {
  loopMode: GifLoopMode;
  tiers: GifTierCollection;
}

export interface Av1TierSettings {
  quality: number;
  cpuPreset: number;
  audioBitrateKbps: number;
}

export interface Av1TierCollection {
  bestQuality: Av1TierSettings;
  quality: Av1TierSettings;
  balanced: Av1TierSettings;
  bestCompression: Av1TierSettings;
  compression: Av1TierSettings;
}

export interface Av1AdvancedSettings {
  tiers: Av1TierCollection;
}

export interface H264TierSettings {
  quality: number;
  preset: VideoPreset;
  audioBitrateKbps: number;
}

export interface H264TierCollection {
  fast: H264TierSettings;
  quality: H264TierSettings;
}

export interface H264AdvancedSettings {
  tiers: H264TierCollection;
}

export interface H265TierSettings {
  quality: number;
  preset: VideoPreset;
  audioBitrateKbps: number;
  useAdvancedParams: boolean;
}

export interface H265TierCollection {
  bestQuality: H265TierSettings;
  quality: H265TierSettings;
  balanced: H265TierSettings;
  bestCompression: H265TierSettings;
}

export interface H265AdvancedSettings {
  tiers: H265TierCollection;
}

export interface AviTierSettings {
  codec: AviCodec;
  quality: number;
  preset: VideoPreset;
  audioBitrateKbps: number;
  useAdvancedParams: boolean;
}

export interface AviTierCollection {
  bestQuality: AviTierSettings;
  bestCompression: AviTierSettings;
  balanced: AviTierSettings;
}

export interface AviAdvancedSettings {
  tiers: AviTierCollection;
}

export interface AdvancedFormatSettings {
  gif: GifAdvancedSettings;
  av1: Av1AdvancedSettings;
  h264: H264AdvancedSettings;
  h265: H265AdvancedSettings;
  avi: AviAdvancedSettings;
}

const GIF_DITHER_VALUES: ReadonlySet<GifDither> = new Set([
  'sierra2_4a',
  'floyd_steinberg',
  'bayer',
  'none',
]);

const VIDEO_PRESET_VALUES: ReadonlySet<VideoPreset> = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo',
]);

const AVI_CODEC_VALUES: ReadonlySet<AviCodec> = new Set(['h264', 'h265']);

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as Record<string, unknown>;
};

const clampInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : NaN;

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(numeric)));
};

const normalizeGifDither = (value: unknown, fallback: GifDither): GifDither => {
  if (typeof value !== 'string') {
    return fallback;
  }
  return GIF_DITHER_VALUES.has(value as GifDither) ? (value as GifDither) : fallback;
};

const normalizeVideoPreset = (value: unknown, fallback: VideoPreset): VideoPreset => {
  if (typeof value !== 'string') {
    return fallback;
  }
  return VIDEO_PRESET_VALUES.has(value as VideoPreset) ? (value as VideoPreset) : fallback;
};

const normalizeAviCodec = (value: unknown, fallback: AviCodec): AviCodec => {
  if (typeof value !== 'string') {
    return fallback;
  }
  return AVI_CODEC_VALUES.has(value as AviCodec) ? (value as AviCodec) : fallback;
};

const normalizeGifLoopMode = (value: unknown, fallback: GifLoopMode): GifLoopMode => {
  if (value === 'forever' || value === 'once') {
    return value;
  }
  return fallback;
};

const cloneGifTierSettings = (tier: GifTierSettings): GifTierSettings => ({ ...tier });

const cloneGifTierCollection = (tiers: GifTierCollection): GifTierCollection => ({
  bestQuality: cloneGifTierSettings(tiers.bestQuality),
  quality: cloneGifTierSettings(tiers.quality),
  balanced: cloneGifTierSettings(tiers.balanced),
  bestCompression: cloneGifTierSettings(tiers.bestCompression),
});

const cloneAv1TierSettings = (tier: Av1TierSettings): Av1TierSettings => ({ ...tier });

const cloneAv1TierCollection = (tiers: Av1TierCollection): Av1TierCollection => ({
  bestQuality: cloneAv1TierSettings(tiers.bestQuality),
  quality: cloneAv1TierSettings(tiers.quality),
  balanced: cloneAv1TierSettings(tiers.balanced),
  bestCompression: cloneAv1TierSettings(tiers.bestCompression),
  compression: cloneAv1TierSettings(tiers.compression),
});

const cloneH264TierSettings = (tier: H264TierSettings): H264TierSettings => ({ ...tier });

const cloneH264TierCollection = (tiers: H264TierCollection): H264TierCollection => ({
  fast: cloneH264TierSettings(tiers.fast),
  quality: cloneH264TierSettings(tiers.quality),
});

const cloneH265TierSettings = (tier: H265TierSettings): H265TierSettings => ({ ...tier });

const cloneH265TierCollection = (tiers: H265TierCollection): H265TierCollection => ({
  bestQuality: cloneH265TierSettings(tiers.bestQuality),
  quality: cloneH265TierSettings(tiers.quality),
  balanced: cloneH265TierSettings(tiers.balanced),
  bestCompression: cloneH265TierSettings(tiers.bestCompression),
});

const cloneAviTierSettings = (tier: AviTierSettings): AviTierSettings => ({ ...tier });

const cloneAviTierCollection = (tiers: AviTierCollection): AviTierCollection => ({
  bestQuality: cloneAviTierSettings(tiers.bestQuality),
  bestCompression: cloneAviTierSettings(tiers.bestCompression),
  balanced: cloneAviTierSettings(tiers.balanced),
});

export const createDefaultGifAdvancedSettings = (): GifAdvancedSettings => ({
  loopMode: 'forever',
  tiers: {
    bestQuality: {
      fps: 15,
      maxDimension: 1080,
      maxColors: 256,
      dither: 'sierra2_4a',
    },
    quality: {
      fps: 12,
      maxDimension: 900,
      maxColors: 224,
      dither: 'sierra2_4a',
    },
    balanced: {
      fps: 10,
      maxDimension: 720,
      maxColors: 192,
      dither: 'bayer',
    },
    bestCompression: {
      fps: 8,
      maxDimension: 540,
      maxColors: 128,
      dither: 'none',
    },
  },
});

export const createDefaultAv1AdvancedSettings = (): Av1AdvancedSettings => ({
  tiers: {
    bestQuality: { quality: 15, cpuPreset: 2, audioBitrateKbps: 256 },
    quality: { quality: 20, cpuPreset: 4, audioBitrateKbps: 192 },
    balanced: { quality: 30, cpuPreset: 6, audioBitrateKbps: 128 },
    bestCompression: { quality: 38, cpuPreset: 2, audioBitrateKbps: 96 },
    compression: { quality: 40, cpuPreset: 6, audioBitrateKbps: 96 },
  },
});

export const createDefaultH264AdvancedSettings = (): H264AdvancedSettings => ({
  tiers: {
    fast: { quality: 23, preset: 'fast', audioBitrateKbps: 128 },
    quality: { quality: 18, preset: 'slow', audioBitrateKbps: 192 },
  },
});

export const createDefaultH265AdvancedSettings = (): H265AdvancedSettings => ({
  tiers: {
    bestQuality: {
      quality: 16,
      preset: 'veryslow',
      audioBitrateKbps: 256,
      useAdvancedParams: true,
    },
    quality: { quality: 22, preset: 'slow', audioBitrateKbps: 192, useAdvancedParams: false },
    balanced: { quality: 28, preset: 'medium', audioBitrateKbps: 128, useAdvancedParams: false },
    bestCompression: {
      quality: 32,
      preset: 'veryslow',
      audioBitrateKbps: 96,
      useAdvancedParams: true,
    },
  },
});

export const createDefaultAviAdvancedSettings = (): AviAdvancedSettings => ({
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
});

export const createDefaultAdvancedFormatSettings = (): AdvancedFormatSettings => ({
  gif: createDefaultGifAdvancedSettings(),
  av1: createDefaultAv1AdvancedSettings(),
  h264: createDefaultH264AdvancedSettings(),
  h265: createDefaultH265AdvancedSettings(),
  avi: createDefaultAviAdvancedSettings(),
});

export const normalizeGifTierSettings = (
  value: unknown,
  fallback: GifTierSettings
): GifTierSettings => {
  const incoming = toRecord(value);
  return {
    fps: clampInteger(incoming.fps, 1, 60, fallback.fps),
    maxDimension: clampInteger(incoming.maxDimension, 160, 2160, fallback.maxDimension),
    maxColors: clampInteger(incoming.maxColors, 2, 256, fallback.maxColors),
    dither: normalizeGifDither(incoming.dither, fallback.dither),
  };
};

export const normalizeAv1TierSettings = (
  value: unknown,
  fallback: Av1TierSettings
): Av1TierSettings => {
  const incoming = toRecord(value);
  return {
    quality: clampInteger(incoming.quality, 1, 63, fallback.quality),
    cpuPreset: clampInteger(incoming.cpuPreset, 0, 13, fallback.cpuPreset),
    audioBitrateKbps: clampInteger(incoming.audioBitrateKbps, 32, 512, fallback.audioBitrateKbps),
  };
};

export const normalizeH264TierSettings = (
  value: unknown,
  fallback: H264TierSettings
): H264TierSettings => {
  const incoming = toRecord(value);
  return {
    quality: clampInteger(incoming.quality, 1, 51, fallback.quality),
    preset: normalizeVideoPreset(incoming.preset, fallback.preset),
    audioBitrateKbps: clampInteger(incoming.audioBitrateKbps, 32, 512, fallback.audioBitrateKbps),
  };
};

export const normalizeH265TierSettings = (
  value: unknown,
  fallback: H265TierSettings
): H265TierSettings => {
  const incoming = toRecord(value);
  return {
    quality: clampInteger(incoming.quality, 1, 51, fallback.quality),
    preset: normalizeVideoPreset(incoming.preset, fallback.preset),
    audioBitrateKbps: clampInteger(incoming.audioBitrateKbps, 32, 512, fallback.audioBitrateKbps),
    useAdvancedParams:
      typeof incoming.useAdvancedParams === 'boolean'
        ? incoming.useAdvancedParams
        : fallback.useAdvancedParams,
  };
};

export const normalizeAviTierSettings = (
  value: unknown,
  fallback: AviTierSettings
): AviTierSettings => {
  const incoming = toRecord(value);
  return {
    codec: normalizeAviCodec(incoming.codec, fallback.codec),
    quality: clampInteger(incoming.quality, 1, 51, fallback.quality),
    preset: normalizeVideoPreset(incoming.preset, fallback.preset),
    audioBitrateKbps: clampInteger(incoming.audioBitrateKbps, 32, 512, fallback.audioBitrateKbps),
    useAdvancedParams:
      typeof incoming.useAdvancedParams === 'boolean'
        ? incoming.useAdvancedParams
        : fallback.useAdvancedParams,
  };
};

export const normalizeGifAdvancedSettings = (value: unknown): GifAdvancedSettings => {
  const defaults = createDefaultGifAdvancedSettings();
  const incoming = toRecord(value);
  const tiersIncoming = toRecord(incoming.tiers);

  return {
    loopMode: normalizeGifLoopMode(incoming.loopMode, defaults.loopMode),
    tiers: {
      bestQuality: normalizeGifTierSettings(tiersIncoming.bestQuality, defaults.tiers.bestQuality),
      quality: normalizeGifTierSettings(tiersIncoming.quality, defaults.tiers.quality),
      balanced: normalizeGifTierSettings(tiersIncoming.balanced, defaults.tiers.balanced),
      bestCompression: normalizeGifTierSettings(
        tiersIncoming.bestCompression,
        defaults.tiers.bestCompression
      ),
    },
  };
};

export const normalizeAv1AdvancedSettings = (value: unknown): Av1AdvancedSettings => {
  const defaults = createDefaultAv1AdvancedSettings();
  const incoming = toRecord(value);
  const tiersIncoming = toRecord(incoming.tiers);

  return {
    tiers: {
      bestQuality: normalizeAv1TierSettings(tiersIncoming.bestQuality, defaults.tiers.bestQuality),
      quality: normalizeAv1TierSettings(tiersIncoming.quality, defaults.tiers.quality),
      balanced: normalizeAv1TierSettings(tiersIncoming.balanced, defaults.tiers.balanced),
      bestCompression: normalizeAv1TierSettings(
        tiersIncoming.bestCompression,
        defaults.tiers.bestCompression
      ),
      compression: normalizeAv1TierSettings(tiersIncoming.compression, defaults.tiers.compression),
    },
  };
};

export const normalizeH264AdvancedSettings = (value: unknown): H264AdvancedSettings => {
  const defaults = createDefaultH264AdvancedSettings();
  const incoming = toRecord(value);
  const tiersIncoming = toRecord(incoming.tiers);

  return {
    tiers: {
      fast: normalizeH264TierSettings(tiersIncoming.fast, defaults.tiers.fast),
      quality: normalizeH264TierSettings(tiersIncoming.quality, defaults.tiers.quality),
    },
  };
};

export const normalizeH265AdvancedSettings = (value: unknown): H265AdvancedSettings => {
  const defaults = createDefaultH265AdvancedSettings();
  const incoming = toRecord(value);
  const tiersIncoming = toRecord(incoming.tiers);

  return {
    tiers: {
      bestQuality: normalizeH265TierSettings(tiersIncoming.bestQuality, defaults.tiers.bestQuality),
      quality: normalizeH265TierSettings(tiersIncoming.quality, defaults.tiers.quality),
      balanced: normalizeH265TierSettings(tiersIncoming.balanced, defaults.tiers.balanced),
      bestCompression: normalizeH265TierSettings(
        tiersIncoming.bestCompression,
        defaults.tiers.bestCompression
      ),
    },
  };
};

export const normalizeAviAdvancedSettings = (value: unknown): AviAdvancedSettings => {
  const defaults = createDefaultAviAdvancedSettings();
  const incoming = toRecord(value);
  const tiersIncoming = toRecord(incoming.tiers);

  return {
    tiers: {
      bestQuality: normalizeAviTierSettings(tiersIncoming.bestQuality, defaults.tiers.bestQuality),
      bestCompression: normalizeAviTierSettings(
        tiersIncoming.bestCompression,
        defaults.tiers.bestCompression
      ),
      balanced: normalizeAviTierSettings(tiersIncoming.balanced, defaults.tiers.balanced),
    },
  };
};

export const normalizeAdvancedFormatSettings = (value: unknown): AdvancedFormatSettings => {
  const incoming = toRecord(value);
  return {
    gif: normalizeGifAdvancedSettings(incoming.gif),
    av1: normalizeAv1AdvancedSettings(incoming.av1),
    h264: normalizeH264AdvancedSettings(incoming.h264),
    h265: normalizeH265AdvancedSettings(incoming.h265),
    avi: normalizeAviAdvancedSettings(incoming.avi),
  };
};

const mergeGifTierSettings = (current: GifTierSettings, incoming: unknown): GifTierSettings => {
  const incomingRecord = toRecord(incoming);
  return normalizeGifTierSettings({ ...current, ...incomingRecord }, current);
};

const mergeAv1TierSettings = (current: Av1TierSettings, incoming: unknown): Av1TierSettings => {
  const incomingRecord = toRecord(incoming);
  return normalizeAv1TierSettings({ ...current, ...incomingRecord }, current);
};

const mergeH264TierSettings = (current: H264TierSettings, incoming: unknown): H264TierSettings => {
  const incomingRecord = toRecord(incoming);
  return normalizeH264TierSettings({ ...current, ...incomingRecord }, current);
};

const mergeH265TierSettings = (current: H265TierSettings, incoming: unknown): H265TierSettings => {
  const incomingRecord = toRecord(incoming);
  return normalizeH265TierSettings({ ...current, ...incomingRecord }, current);
};

const mergeAviTierSettings = (current: AviTierSettings, incoming: unknown): AviTierSettings => {
  const incomingRecord = toRecord(incoming);
  return normalizeAviTierSettings({ ...current, ...incomingRecord }, current);
};

export const mergeGifAdvancedSettings = (
  current: GifAdvancedSettings,
  incoming: unknown
): GifAdvancedSettings => {
  const normalizedCurrent = normalizeGifAdvancedSettings(current);
  const incomingRecord = toRecord(incoming);
  if (Object.keys(incomingRecord).length === 0) {
    return {
      loopMode: normalizedCurrent.loopMode,
      tiers: cloneGifTierCollection(normalizedCurrent.tiers),
    };
  }

  const incomingTiers = toRecord(incomingRecord.tiers);

  return normalizeGifAdvancedSettings({
    loopMode: incomingRecord.loopMode ?? normalizedCurrent.loopMode,
    tiers: {
      bestQuality: mergeGifTierSettings(
        normalizedCurrent.tiers.bestQuality,
        incomingTiers.bestQuality
      ),
      quality: mergeGifTierSettings(normalizedCurrent.tiers.quality, incomingTiers.quality),
      balanced: mergeGifTierSettings(normalizedCurrent.tiers.balanced, incomingTiers.balanced),
      bestCompression: mergeGifTierSettings(
        normalizedCurrent.tiers.bestCompression,
        incomingTiers.bestCompression
      ),
    },
  });
};

export const mergeAv1AdvancedSettings = (
  current: Av1AdvancedSettings,
  incoming: unknown
): Av1AdvancedSettings => {
  const normalizedCurrent = normalizeAv1AdvancedSettings(current);
  const incomingRecord = toRecord(incoming);
  if (Object.keys(incomingRecord).length === 0) {
    return {
      tiers: cloneAv1TierCollection(normalizedCurrent.tiers),
    };
  }

  const incomingTiers = toRecord(incomingRecord.tiers);

  return normalizeAv1AdvancedSettings({
    tiers: {
      bestQuality: mergeAv1TierSettings(
        normalizedCurrent.tiers.bestQuality,
        incomingTiers.bestQuality
      ),
      quality: mergeAv1TierSettings(normalizedCurrent.tiers.quality, incomingTiers.quality),
      balanced: mergeAv1TierSettings(normalizedCurrent.tiers.balanced, incomingTiers.balanced),
      bestCompression: mergeAv1TierSettings(
        normalizedCurrent.tiers.bestCompression,
        incomingTiers.bestCompression
      ),
      compression: mergeAv1TierSettings(
        normalizedCurrent.tiers.compression,
        incomingTiers.compression
      ),
    },
  });
};

export const mergeH264AdvancedSettings = (
  current: H264AdvancedSettings,
  incoming: unknown
): H264AdvancedSettings => {
  const normalizedCurrent = normalizeH264AdvancedSettings(current);
  const incomingRecord = toRecord(incoming);
  if (Object.keys(incomingRecord).length === 0) {
    return {
      tiers: cloneH264TierCollection(normalizedCurrent.tiers),
    };
  }

  const incomingTiers = toRecord(incomingRecord.tiers);

  return normalizeH264AdvancedSettings({
    tiers: {
      fast: mergeH264TierSettings(normalizedCurrent.tiers.fast, incomingTiers.fast),
      quality: mergeH264TierSettings(normalizedCurrent.tiers.quality, incomingTiers.quality),
    },
  });
};

export const mergeH265AdvancedSettings = (
  current: H265AdvancedSettings,
  incoming: unknown
): H265AdvancedSettings => {
  const normalizedCurrent = normalizeH265AdvancedSettings(current);
  const incomingRecord = toRecord(incoming);
  if (Object.keys(incomingRecord).length === 0) {
    return {
      tiers: cloneH265TierCollection(normalizedCurrent.tiers),
    };
  }

  const incomingTiers = toRecord(incomingRecord.tiers);

  return normalizeH265AdvancedSettings({
    tiers: {
      bestQuality: mergeH265TierSettings(
        normalizedCurrent.tiers.bestQuality,
        incomingTiers.bestQuality
      ),
      quality: mergeH265TierSettings(normalizedCurrent.tiers.quality, incomingTiers.quality),
      balanced: mergeH265TierSettings(normalizedCurrent.tiers.balanced, incomingTiers.balanced),
      bestCompression: mergeH265TierSettings(
        normalizedCurrent.tiers.bestCompression,
        incomingTiers.bestCompression
      ),
    },
  });
};

export const mergeAviAdvancedSettings = (
  current: AviAdvancedSettings,
  incoming: unknown
): AviAdvancedSettings => {
  const normalizedCurrent = normalizeAviAdvancedSettings(current);
  const incomingRecord = toRecord(incoming);
  if (Object.keys(incomingRecord).length === 0) {
    return {
      tiers: cloneAviTierCollection(normalizedCurrent.tiers),
    };
  }

  const incomingTiers = toRecord(incomingRecord.tiers);

  return normalizeAviAdvancedSettings({
    tiers: {
      bestQuality: mergeAviTierSettings(
        normalizedCurrent.tiers.bestQuality,
        incomingTiers.bestQuality
      ),
      bestCompression: mergeAviTierSettings(
        normalizedCurrent.tiers.bestCompression,
        incomingTiers.bestCompression
      ),
      balanced: mergeAviTierSettings(normalizedCurrent.tiers.balanced, incomingTiers.balanced),
    },
  });
};

export const mergeAdvancedFormatSettings = (
  current: AdvancedFormatSettings,
  incoming: unknown
): AdvancedFormatSettings => {
  const normalizedCurrent = normalizeAdvancedFormatSettings(current);
  const incomingRecord = toRecord(incoming);

  if (Object.keys(incomingRecord).length === 0) {
    return {
      gif: {
        loopMode: normalizedCurrent.gif.loopMode,
        tiers: cloneGifTierCollection(normalizedCurrent.gif.tiers),
      },
      av1: {
        tiers: cloneAv1TierCollection(normalizedCurrent.av1.tiers),
      },
      h264: {
        tiers: cloneH264TierCollection(normalizedCurrent.h264.tiers),
      },
      h265: {
        tiers: cloneH265TierCollection(normalizedCurrent.h265.tiers),
      },
      avi: {
        tiers: cloneAviTierCollection(normalizedCurrent.avi.tiers),
      },
    };
  }

  return {
    gif:
      incomingRecord.gif === undefined
        ? {
            loopMode: normalizedCurrent.gif.loopMode,
            tiers: cloneGifTierCollection(normalizedCurrent.gif.tiers),
          }
        : mergeGifAdvancedSettings(normalizedCurrent.gif, incomingRecord.gif),
    av1:
      incomingRecord.av1 === undefined
        ? {
            tiers: cloneAv1TierCollection(normalizedCurrent.av1.tiers),
          }
        : mergeAv1AdvancedSettings(normalizedCurrent.av1, incomingRecord.av1),
    h264:
      incomingRecord.h264 === undefined
        ? {
            tiers: cloneH264TierCollection(normalizedCurrent.h264.tiers),
          }
        : mergeH264AdvancedSettings(normalizedCurrent.h264, incomingRecord.h264),
    h265:
      incomingRecord.h265 === undefined
        ? {
            tiers: cloneH265TierCollection(normalizedCurrent.h265.tiers),
          }
        : mergeH265AdvancedSettings(normalizedCurrent.h265, incomingRecord.h265),
    avi:
      incomingRecord.avi === undefined
        ? {
            tiers: cloneAviTierCollection(normalizedCurrent.avi.tiers),
          }
        : mergeAviAdvancedSettings(normalizedCurrent.avi, incomingRecord.avi),
  };
};
