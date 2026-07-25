export const SETTINGS_SCHEMA_VERSION = 6;
export const MAX_RECENT_PRESET_IDS = 8;

export type ThemePreference = 'system' | 'dark' | 'light' | 'custom';
export type CustomThemeId = 'midnight-blue' | 'high-contrast-dark';

export const CUSTOM_THEME_IDS: readonly CustomThemeId[] = [
  'midnight-blue',
  'high-contrast-dark',
] as const;

export interface UIPanelSettings {
  presetExpanded: boolean;
  gpuExpanded: boolean;
}

export const normalizeTheme = (value: unknown): ThemePreference => {
  return value === 'dark' || value === 'light' || value === 'system' || value === 'custom'
    ? value
    : 'system';
};

export const normalizeCustomTheme = (value: unknown): CustomThemeId => {
  return value === 'high-contrast-dark' ? 'high-contrast-dark' : 'midnight-blue';
};

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

export const normalizeUiPanels = (value: unknown): UIPanelSettings => {
  const incoming =
    value && typeof value === 'object'
      ? (value as Partial<Record<keyof UIPanelSettings, unknown>>)
      : {};
  return {
    presetExpanded: incoming.presetExpanded === true,
    gpuExpanded: incoming.gpuExpanded === true,
  };
};

/** New installs default false; missing key on existing settings.json means legacy user (completed). */
export const normalizeSetupWizardCompleted = (value: unknown, hadExplicitKey: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  return hadExplicitKey ? false : true;
};

export const isSettingsCorrupted = (value: unknown): boolean => {
  return !value || typeof value !== 'object';
};

export const isSettingsSchemaOutdated = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const incoming = value as Record<string, unknown>;
  return incoming.settingsSchemaVersion !== SETTINGS_SCHEMA_VERSION;
};
