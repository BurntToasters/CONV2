import type { AdvancedFormatSettings } from '../main/advancedFormats';
import type { CustomThemeId, ThemePreference, UIPanelSettings } from '../main/settingsSchema';

export type GPUVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
export type GPUMode = 'auto' | 'manual';
export type GPUCodec = 'h264' | 'h265' | 'av1';
export type QueueItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface AppSettings {
  settingsSchemaVersion: number;
  outputDirectory: string;
  gpu: GPUVendor;
  gpuMode: GPUMode;
  gpuManualVendor: GPUVendor;
  theme: ThemePreference;
  customTheme: CustomThemeId;
  interfaceStyle: 'glass' | 'flat';
  showDebugOutput: boolean;
  autoCheckUpdates: boolean;
  useSystemFFmpeg: boolean;
  useCpuDecodingWhenGpu: boolean;
  moveOriginalToTrashOnSuccess: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  showAdvancedPresets: boolean;
  removeSpacesFromFilenames: boolean;
  showAllGpuVendors: boolean;
  notifyOnConversionComplete: boolean;
  preventSleepWhileConverting: boolean;
  setupWizardCompleted: boolean;
  recentPresetIds: string[];
  uiPanels: UIPanelSettings;
  advancedFormatSettings: AdvancedFormatSettings;
}

export interface QueueItemSnapshot {
  id: string;
  inputPath: string;
  fileName: string;
  status: QueueItemStatus;
  error?: string;
  outputPath?: string;
  usedCpuFallback?: boolean;
}

export interface QueueSnapshot {
  active: boolean;
  presetId: string;
  currentIndex: number;
  total: number;
  items: QueueItemSnapshot[];
}

export interface ConversionProgress {
  percent: number;
  frame: number;
  fps: number;
  time: string;
  bitrate: string;
  speed: string;
}

export interface VideoInfo {
  duration: number;
  size: number;
  width: number;
  height: number;
  codec: string;
  format: string;
}
