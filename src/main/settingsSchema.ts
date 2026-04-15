export const SETTINGS_SCHEMA_VERSION = 2;
export const MAX_RECENT_PRESET_IDS = 8;

export const normalizeRecentPresetIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  );

  return deduped.slice(0, MAX_RECENT_PRESET_IDS);
};

export const shouldHardResetSettings = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return true;
  }
  const incoming = value as Record<string, unknown>;
  return incoming.settingsSchemaVersion !== SETTINGS_SCHEMA_VERSION;
};
