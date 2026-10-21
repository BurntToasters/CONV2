import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings, GPUMode, GPUVendor } from '../shared/appContract';
import {
  createDefaultAdvancedFormatSettings,
  normalizeAdvancedFormatSettings,
} from './advancedFormats';
import {
  SETTINGS_SCHEMA_VERSION,
  isSettingsCorrupted,
  isSettingsSchemaOutdated,
  normalizeCustomTheme,
  normalizeRecentPresetIds,
  normalizeSetupWizardCompleted,
  normalizeTheme,
  normalizeUiPanels,
} from './settingsSchema';

// settings.json: defaults, normalisation of untrusted input, crash-safe read and write.

export const ALLOWED_SETTINGS_KEYS = new Set<string>([
  'outputDirectory',
  'gpu',
  'gpuMode',
  'gpuManualVendor',
  'theme',
  'customTheme',
  'interfaceStyle',
  'showDebugOutput',
  'autoCheckUpdates',
  'useSystemFFmpeg',
  'useCpuDecodingWhenGpu',
  'moveOriginalToTrashOnSuccess',
  'updateChannel',
  'showAdvancedPresets',
  'removeSpacesFromFilenames',
  'showAllGpuVendors',
  'notifyOnConversionComplete',
  'preventSleepWhileConverting',
  'setupWizardCompleted',
  'recentPresetIds',
  'uiPanels',
  'advancedFormatSettings',
]);

export const createDefaultSettings = (): AppSettings => ({
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  outputDirectory: '',
  gpu: 'cpu',
  gpuMode: 'auto',
  gpuManualVendor: 'cpu',
  theme: 'system',
  customTheme: 'midnight-blue',
  interfaceStyle: 'glass',
  showDebugOutput: false,
  autoCheckUpdates: true,
  useSystemFFmpeg: false,
  useCpuDecodingWhenGpu: false,
  moveOriginalToTrashOnSuccess: false,
  updateChannel: 'auto',
  showAdvancedPresets: false,
  removeSpacesFromFilenames: false,
  showAllGpuVendors: false,
  notifyOnConversionComplete: true,
  preventSleepWhileConverting: false,
  setupWizardCompleted: false,
  recentPresetIds: [],
  uiPanels: normalizeUiPanels(undefined),
  advancedFormatSettings: createDefaultAdvancedFormatSettings(),
});

export const normalizeUpdateChannel = (value: unknown): AppSettings['updateChannel'] => {
  return value === 'stable' || value === 'beta' || value === 'auto' ? value : 'auto';
};

export const normalizeGpuMode = (value: unknown): GPUMode => {
  return value === 'manual' || value === 'auto' ? value : 'auto';
};

export const normalizeGpuVendor = (value: unknown): GPUVendor => {
  return value === 'nvidia' ||
    value === 'amd' ||
    value === 'intel' ||
    value === 'apple' ||
    value === 'cpu'
    ? value
    : 'cpu';
};

export const normalizeSettings = (value: unknown): AppSettings => {
  const defaults = createDefaultSettings();
  const incoming =
    value && typeof value === 'object'
      ? (value as Partial<Record<keyof AppSettings, unknown>>)
      : {};

  const normalizedManualVendor = normalizeGpuVendor(
    incoming.gpuManualVendor ?? incoming.gpu ?? defaults.gpuManualVendor
  );
  const normalizedMode = normalizeGpuMode(incoming.gpuMode ?? defaults.gpuMode);

  return {
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    outputDirectory: (() => {
      if (typeof incoming.outputDirectory !== 'string') {
        return defaults.outputDirectory;
      }
      const trimmed = incoming.outputDirectory.trim();
      if (!trimmed) {
        return '';
      }
      if (!path.isAbsolute(trimmed)) {
        return '';
      }
      return path.resolve(trimmed);
    })(),
    gpu: normalizedManualVendor,
    gpuMode: normalizedMode,
    gpuManualVendor: normalizedManualVendor,
    theme: normalizeTheme(incoming.theme ?? defaults.theme),
    customTheme: normalizeCustomTheme(incoming.customTheme ?? defaults.customTheme),
    interfaceStyle: incoming.interfaceStyle === 'flat' ? 'flat' : 'glass',
    showDebugOutput: incoming.showDebugOutput === true,
    autoCheckUpdates: incoming.autoCheckUpdates !== false,
    useSystemFFmpeg: incoming.useSystemFFmpeg === true,
    useCpuDecodingWhenGpu: incoming.useCpuDecodingWhenGpu === true,
    moveOriginalToTrashOnSuccess: incoming.moveOriginalToTrashOnSuccess === true,
    updateChannel: normalizeUpdateChannel(incoming.updateChannel ?? defaults.updateChannel),
    showAdvancedPresets: incoming.showAdvancedPresets === true,
    removeSpacesFromFilenames: incoming.removeSpacesFromFilenames === true,
    showAllGpuVendors: incoming.showAllGpuVendors === true,
    notifyOnConversionComplete: incoming.notifyOnConversionComplete !== false,
    preventSleepWhileConverting: incoming.preventSleepWhileConverting === true,
    setupWizardCompleted: normalizeSetupWizardCompleted(
      incoming.setupWizardCompleted,
      Object.prototype.hasOwnProperty.call(incoming, 'setupWizardCompleted')
    ),
    recentPresetIds: normalizeRecentPresetIds(incoming.recentPresetIds),
    uiPanels: normalizeUiPanels(incoming.uiPanels),
    advancedFormatSettings: normalizeAdvancedFormatSettings(incoming.advancedFormatSettings),
  };
};

/**
 * Writes JSON via temp file + fsync + rename so a crash or full disk mid-write
 * can never leave a truncated file where the app expects valid state.
 */
export const writeJsonAtomic = (filePath: string, value: unknown): void => {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
};

const backUpCorruptFile = (settingsPath: string): void => {
  try {
    if (fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, `${settingsPath}.corrupt-${Date.now()}`);
    }
  } catch {
    // backup failure is non-fatal
  }
};

/** Loads settings; corrupt files are backed up, outdated ones flagged for re-save. */
export const readSettingsFile = (
  settingsPath: string
): { settings: AppSettings; shouldPersist: boolean } => {
  try {
    fs.unlinkSync(`${settingsPath}.tmp`);
  } catch {
    // no stale temp file
  }
  if (!fs.existsSync(settingsPath)) {
    return { settings: createDefaultSettings(), shouldPersist: false };
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (isSettingsCorrupted(parsed)) {
      backUpCorruptFile(settingsPath);
      return { settings: createDefaultSettings(), shouldPersist: true };
    }
    return { settings: normalizeSettings(parsed), shouldPersist: isSettingsSchemaOutdated(parsed) };
  } catch {
    backUpCorruptFile(settingsPath);
    return { settings: createDefaultSettings(), shouldPersist: true };
  }
};
