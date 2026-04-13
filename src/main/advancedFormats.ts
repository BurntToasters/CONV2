export type GifLoopMode = 'forever' | 'once';
export type GifDither = 'sierra2_4a' | 'floyd_steinberg' | 'bayer' | 'none';

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

export interface AdvancedFormatSettings {
  gif: GifAdvancedSettings;
}

const GIF_DITHER_VALUES: ReadonlySet<GifDither> = new Set([
  'sierra2_4a',
  'floyd_steinberg',
  'bayer',
  'none',
]);

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

export const createDefaultAdvancedFormatSettings = (): AdvancedFormatSettings => ({
  gif: createDefaultGifAdvancedSettings(),
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

export const normalizeAdvancedFormatSettings = (value: unknown): AdvancedFormatSettings => {
  const incoming = toRecord(value);
  return {
    gif: normalizeGifAdvancedSettings(incoming.gif),
  };
};

const mergeGifTierSettings = (current: GifTierSettings, incoming: unknown): GifTierSettings => {
  const incomingRecord = toRecord(incoming);
  return normalizeGifTierSettings({ ...current, ...incomingRecord }, current);
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

export const mergeAdvancedFormatSettings = (
  current: AdvancedFormatSettings,
  incoming: unknown
): AdvancedFormatSettings => {
  const normalizedCurrent = normalizeAdvancedFormatSettings(current);
  const incomingRecord = toRecord(incoming);
  if (Object.keys(incomingRecord).length === 0 || incomingRecord.gif === undefined) {
    return {
      gif: {
        loopMode: normalizedCurrent.gif.loopMode,
        tiers: cloneGifTierCollection(normalizedCurrent.gif.tiers),
      },
    };
  }

  return {
    gif: mergeGifAdvancedSettings(normalizedCurrent.gif, incomingRecord.gif),
  };
};
