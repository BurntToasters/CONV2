import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron';
import type { AdvancedFormatSettings } from './advancedFormats';

export interface ConversionProgress {
  percent: number;
  frame: number;
  fps: number;
  time: string;
  bitrate: string;
  speed: string;
}

export interface ConversionResult {
  success: boolean;
  outputPath: string;
  error?: string;
  retryWithCpuSuggested?: boolean;
}

export type GPUVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
export type GPUMode = 'auto' | 'manual';
export type GPUCodec = 'h264' | 'h265' | 'av1';

export interface UIPanelSettings {
  presetExpanded: boolean;
  gpuExpanded: boolean;
}

export interface AppSettings {
  settingsSchemaVersion: number;
  outputDirectory: string;
  gpu: GPUVendor;
  gpuMode: GPUMode;
  gpuManualVendor: GPUVendor;
  theme: 'system' | 'dark' | 'light';
  showDebugOutput: boolean;
  autoCheckUpdates: boolean;
  useSystemFFmpeg: boolean;
  useCpuDecodingWhenGpu: boolean;
  moveOriginalToTrashOnSuccess: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  showAdvancedPresets: boolean;
  removeSpacesFromFilenames: boolean;
  showAllGpuVendors: boolean;
  recentPresetIds: string[];
  uiPanels: UIPanelSettings;
  advancedFormatSettings: AdvancedFormatSettings;
}

export type SaveSettingsPayload = Omit<Partial<AppSettings>, 'uiPanels'> & {
  uiPanels?: Partial<UIPanelSettings>;
};

export interface VideoInfo {
  duration: number;
  size: number;
  width: number;
  height: number;
  codec: string;
  format: string;
}

export interface GPUEncoderError {
  type: 'encoder_unavailable' | 'gpu_capability' | 'driver_error' | 'unknown';
  message: string;
  details: string;
  suggestion: string;
  canRetryWithCPU: boolean;
  codec?: string;
  gpu?: GPUVendor;
}

export interface StartConversionOptions {
  suppressGpuErrorEvent?: boolean;
  removeSpacesFromFilenames?: boolean;
  outputDirectory?: string;
  showDebugOutput?: boolean;
}

export interface RendererPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  categoryLabel: string;
  categoryOrder: number;
  isAdvanced: boolean;
  extension: string;
  aviTier: string | null;
}

export interface GPUCapabilityStatus {
  available: boolean;
  reason: string;
  encoder: string;
}

export interface GPUCapabilitiesPayload {
  platform: string;
  requestedCodec: GPUCodec | null;
  checkedCodecs: GPUCodec[];
  matrix: Partial<Record<GPUCodec, Record<GPUVendor, GPUCapabilityStatus>>>;
  recommendedVendor: GPUVendor;
  recommendationReason: string;
}

export interface UpdateStatePayload {
  phase:
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'disabled'
    | 'already-checking';
  manual: boolean;
  message?: string;
  percent?: number;
}

const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  selectFile: (): Promise<string[]> => ipcRenderer.invoke('select-file'),
  selectOutputDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('select-output-directory'),
  getFileInfo: (filePath: string): Promise<VideoInfo | null> =>
    ipcRenderer.invoke('get-file-info', filePath),

  // Conversion
  startConversion: (
    inputPath: string,
    presetId: string,
    gpu: GPUVendor,
    options?: StartConversionOptions
  ): Promise<ConversionResult> =>
    ipcRenderer.invoke('start-conversion', inputPath, presetId, gpu, options),
  cancelConversion: (force?: boolean): Promise<void> =>
    ipcRenderer.invoke('cancel-conversion', force),
  onConversionProgress: (callback: (progress: ConversionProgress) => void): (() => void) =>
    subscribe('conversion-progress', callback),
  onConversionLog: (callback: (message: string) => void): (() => void) =>
    subscribe('conversion-log', callback),
  onConversionComplete: (callback: (result: ConversionResult) => void): (() => void) =>
    subscribe('conversion-complete', callback),
  onGPUEncoderError: (callback: (error: GPUEncoderError) => void): (() => void) =>
    subscribe('gpu-encoder-error', callback),

  // Presets
  getPresets: (): Promise<RendererPreset[]> => ipcRenderer.invoke('get-presets'),
  getGpuCapabilities: (requestedCodec?: GPUCodec | null): Promise<GPUCapabilitiesPayload> =>
    ipcRenderer.invoke('get-gpu-capabilities', requestedCodec ?? null),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('get-settings'),
  getDefaultAdvancedFormatSettings: (): Promise<AdvancedFormatSettings> =>
    ipcRenderer.invoke('get-default-advanced-format-settings'),
  saveSettings: (settings: SaveSettingsPayload): Promise<void> =>
    ipcRenderer.invoke('save-settings', settings),

  // Updates
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('check-for-updates'),
  isUpdatesDisabled: (): Promise<boolean> => ipcRenderer.invoke('is-updates-disabled'),
  onUpdateStatus: (callback: (message: string) => void): (() => void) =>
    subscribe('update-status', callback),
  onUpdateState: (callback: (payload: UpdateStatePayload) => void): (() => void) =>
    subscribe('update-state', callback),
  onUpdateProgress: (callback: (percent: number) => void): (() => void) =>
    subscribe('update-download-progress', callback),
  onUpdateAvailable: (callback: (available: boolean) => void): (() => void) =>
    subscribe('update-available', callback),

  // FFmpeg check
  checkFFmpeg: (): Promise<boolean> => ipcRenderer.invoke('check-ffmpeg'),

  // App info
  getVersion: (): Promise<string> => ipcRenderer.invoke('get-version'),
  getPlatform: (): Promise<string> => ipcRenderer.invoke('get-platform'),

  // Open external
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('open-path', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),

  // Theme
  getSystemTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('get-system-theme'),
  onThemeChange: (callback: (theme: 'dark' | 'light') => void): (() => void) =>
    subscribe('theme-changed', callback),

  // Reset & Restart
  resetSettings: (): Promise<AppSettings> => ipcRenderer.invoke('reset-settings'),
  restartApp: (): Promise<void> => ipcRenderer.invoke('restart-app'),

  // Licenses
  getLicenses: (): Promise<Record<string, unknown> | null> => ipcRenderer.invoke('get-licenses'),
});

declare global {
  interface Window {
    electronAPI: {
      getPathForFile: (file: File) => string;
      selectFile: () => Promise<string[]>;
      selectOutputDirectory: () => Promise<string | null>;
      getFileInfo: (filePath: string) => Promise<VideoInfo | null>;
      startConversion: (
        inputPath: string,
        presetId: string,
        gpu: GPUVendor,
        options?: StartConversionOptions
      ) => Promise<ConversionResult>;
      cancelConversion: (force?: boolean) => Promise<void>;
      onConversionProgress: (callback: (progress: ConversionProgress) => void) => () => void;
      onConversionLog: (callback: (message: string) => void) => () => void;
      onConversionComplete: (callback: (result: ConversionResult) => void) => () => void;
      onGPUEncoderError: (callback: (error: GPUEncoderError) => void) => () => void;
      getPresets: () => Promise<RendererPreset[]>;
      getGpuCapabilities: (requestedCodec?: GPUCodec | null) => Promise<GPUCapabilitiesPayload>;
      getSettings: () => Promise<AppSettings>;
      getDefaultAdvancedFormatSettings: () => Promise<AdvancedFormatSettings>;
      saveSettings: (settings: SaveSettingsPayload) => Promise<void>;
      checkForUpdates: () => Promise<void>;
      isUpdatesDisabled: () => Promise<boolean>;
      onUpdateStatus: (callback: (message: string) => void) => () => void;
      onUpdateState: (callback: (payload: UpdateStatePayload) => void) => () => void;
      onUpdateProgress: (callback: (percent: number) => void) => () => void;
      onUpdateAvailable: (callback: (available: boolean) => void) => () => void;
      checkFFmpeg: () => Promise<boolean>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      openPath: (path: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getSystemTheme: () => Promise<'dark' | 'light'>;
      onThemeChange: (callback: (theme: 'dark' | 'light') => void) => () => void;
      resetSettings: () => Promise<AppSettings>;
      restartApp: () => Promise<void>;
      getLicenses: () => Promise<Record<string, unknown> | null>;
    };
  }
}
