import { createDefaultAdvancedFormatSettings } from './advancedFormats';

/** Files saved below this schema version get their untouched legacy tiers replaced. */
export const TIER_DEFAULTS_MIGRATION_VERSION = 7;

type FormatKey = 'av1' | 'h265' | 'avi';
type LegacyFields = Record<string, string | number | boolean>;

// Shipped tier defaults of earlier releases. A stored tier matches when every listed field is equal.
const LEGACY_TIER_DEFAULTS: Record<FormatKey, Record<string, LegacyFields[]>> = {
  av1: {
    bestQuality: [
      { quality: 15, cpuPreset: 2, audioBitrateKbps: 256 },
      { quality: 18, cpuPreset: 2, audioBitrateKbps: 256 },
    ],
    quality: [
      { quality: 20, cpuPreset: 4, audioBitrateKbps: 192 },
      { quality: 24, cpuPreset: 4, audioBitrateKbps: 192 },
    ],
    balanced: [{ quality: 30, cpuPreset: 6, audioBitrateKbps: 128 }],
    bestCompression: [{ quality: 38, cpuPreset: 2, audioBitrateKbps: 96 }],
    compression: [
      { quality: 40, cpuPreset: 6, audioBitrateKbps: 96 },
      { quality: 44, cpuPreset: 6, audioBitrateKbps: 96 },
    ],
  },
  h265: {
    bestQuality: [
      { quality: 16, preset: 'veryslow', audioBitrateKbps: 256, useAdvancedParams: true },
    ],
    bestCompression: [
      { quality: 32, preset: 'veryslow', audioBitrateKbps: 96, useAdvancedParams: true },
    ],
  },
  avi: {
    bestQuality: [
      {
        codec: 'h265',
        quality: 16,
        preset: 'veryslow',
        audioBitrateKbps: 256,
        useAdvancedParams: true,
      },
      {
        codec: 'h264',
        quality: 16,
        preset: 'veryslow',
        audioBitrateKbps: 256,
        useAdvancedParams: false,
      },
    ],
    bestCompression: [
      {
        codec: 'h265',
        quality: 26,
        preset: 'veryslow',
        audioBitrateKbps: 128,
        useAdvancedParams: true,
      },
      {
        codec: 'h264',
        quality: 26,
        preset: 'veryslow',
        audioBitrateKbps: 128,
        useAdvancedParams: false,
      },
    ],
    balanced: [
      {
        codec: 'h264',
        quality: 20,
        preset: 'slow',
        audioBitrateKbps: 192,
        useAdvancedParams: false,
      },
    ],
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const matchesLegacy = (stored: unknown, legacy: LegacyFields): boolean =>
  isRecord(stored) &&
  Object.entries(legacy).every(([field, expected]) => stored[field] === expected);

/**
 * Replaces tiers that still hold an old shipped default with the current default.
 * Returns a new object; the input is never mutated. Unexpected shapes pass through.
 */
export const migrateLegacyTierDefaults = (raw: unknown): unknown => {
  if (!isRecord(raw) || !isRecord(raw.advancedFormatSettings)) {
    return raw;
  }
  const advanced = raw.advancedFormatSettings;
  const defaults = createDefaultAdvancedFormatSettings();
  const nextAdvanced: Record<string, unknown> = { ...advanced };

  for (const formatKey of Object.keys(LEGACY_TIER_DEFAULTS) as FormatKey[]) {
    const format = advanced[formatKey];
    if (!isRecord(format) || !isRecord(format.tiers)) {
      continue;
    }
    const tiers = format.tiers;
    const currentDefaults: Record<string, unknown> = { ...defaults[formatKey].tiers };
    const nextTiers: Record<string, unknown> = { ...tiers };
    let changed = false;

    for (const [tierKey, legacyList] of Object.entries(LEGACY_TIER_DEFAULTS[formatKey])) {
      if (legacyList.some((legacy) => matchesLegacy(tiers[tierKey], legacy))) {
        nextTiers[tierKey] = currentDefaults[tierKey];
        changed = true;
      }
    }
    if (changed) {
      nextAdvanced[formatKey] = { ...format, tiers: nextTiers };
    }
  }

  return { ...raw, advancedFormatSettings: nextAdvanced };
};
