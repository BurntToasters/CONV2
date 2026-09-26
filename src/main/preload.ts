import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron';
import type { AdvancedFormatSettings } from './advancedFormats';
import type { UIPanelSettings } from './settingsSchema';
import type {
  AppSettings,
  ConversionProgress,
  GPUCodec,
  GPUVendor,
  QueueSnapshot,
  VideoInfo,
} from '../shared/appContract';

export type {
  AppSettings,
  ConversionProgress,
  GPUCodec,
  GPUMode,
  GPUVendor,
  QueueItemSnapshot,
  QueueItemStatus,
  QueueSnapshot,
  VideoInfo,
} from '../shared/appContract';
export type { UIPanelSettings };

export type SaveSettingsPayload = Omit<Partial<AppSettings>, 'uiPanels'> & {
  uiPanels?: Partial<UIPanelSettings>;
};

export interface GPUEncoderError {
  type: 'encoder_unavailable' | 'gpu_capability' | 'driver_error' | 'unknown';
  message: string;
  details: string;
  suggestion: string;
  canRetryWithCPU: boolean;
  codec?: string;
  gpu?: GPUVendor;
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
    | 'installing'
    | 'error'
    | 'disabled'
    | 'already-checking';
  manual: boolean;
  message?: string;
  percent?: number;
}

export type AppMenuActionId =
  | 'open-settings'
  | 'open-files'
  | 'start-conversion'
  | 'cancel-conversion'
  | 'show-logs'
  | 'open-credits'
  | 'show-in-folder';

export interface AppMenuActionEvent {
  action: AppMenuActionId;
  payload?: { paths?: string[] };
}

export interface ConversionMenuStatePayload {
  converting: boolean;
  hasOutput: boolean;
}

export interface WindowChromeStylePayload {
  platform: string;
  customTitleBar: boolean;
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
  selectOutputDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('select-output-directory'),
  getFileInfo: (filePath: string): Promise<VideoInfo | null> =>
    ipcRenderer.invoke('get-file-info', filePath),

  // Conversion
  startConversionQueue: (payload: {
    inputPaths: string[];
    presetId: string;
    gpu: GPUVendor;
    removeSpacesFromFilenames?: boolean;
    outputDirectory?: string;
    showDebugOutput?: boolean;
  }): Promise<QueueSnapshot> => ipcRenderer.invoke('start-conversion-queue', payload),
  cancelConversion: (force?: boolean): Promise<void> =>
    ipcRenderer.invoke('cancel-conversion', force),
  onConversionProgress: (callback: (progress: ConversionProgress) => void): (() => void) =>
    subscribe('conversion-progress', callback),
  onConversionLog: (callback: (message: string) => void): (() => void) =>
    subscribe('conversion-log', callback),
  onConversionQueueUpdated: (callback: (snapshot: QueueSnapshot) => void): (() => void) =>
    subscribe('conversion-queue-updated', callback),
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
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('download-update'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('install-update'),
  isUpdatesDisabled: (): Promise<boolean> => ipcRenderer.invoke('is-updates-disabled'),
  onUpdateState: (callback: (payload: UpdateStatePayload) => void): (() => void) =>
    subscribe('update-state', callback),

  // FFmpeg check
  checkFFmpeg: (): Promise<boolean> => ipcRenderer.invoke('check-ffmpeg'),

  // App info
  getVersion: (): Promise<string> => ipcRenderer.invoke('get-version'),
  getPlatform: (): Promise<string> => ipcRenderer.invoke('get-platform'),

  // Reveal in the OS file manager (shell.showItemInFolder). This deliberately
  // does not open/execute the file.
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('reveal-path', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),

  // Theme
  getSystemTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('get-system-theme'),
  onThemeChange: (callback: (theme: 'dark' | 'light') => void): (() => void) =>
    subscribe('theme-changed', callback),

  onAppMenuAction: (callback: (event: AppMenuActionEvent) => void): (() => void) =>
    subscribe('app-menu-action', callback),
  setConversionMenuState: (state: ConversionMenuStatePayload): void =>
    ipcRenderer.send('conversion-menu-state', state),

  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window-minimize'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('window-toggle-maximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window-close'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('window-is-maximized'),
  onWindowChromeStyle: (callback: (payload: WindowChromeStylePayload) => void): (() => void) =>
    subscribe('window-chrome-style', callback),
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void): (() => void) =>
    subscribe('window-maximized-changed', callback),

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
      selectOutputDirectory: () => Promise<string | null>;
      getFileInfo: (filePath: string) => Promise<VideoInfo | null>;
      startConversionQueue: (payload: {
        inputPaths: string[];
        presetId: string;
        gpu: GPUVendor;
        removeSpacesFromFilenames?: boolean;
        outputDirectory?: string;
        showDebugOutput?: boolean;
      }) => Promise<QueueSnapshot>;
      cancelConversion: (force?: boolean) => Promise<void>;
      onConversionProgress: (callback: (progress: ConversionProgress) => void) => () => void;
      onConversionLog: (callback: (message: string) => void) => () => void;
      onConversionQueueUpdated: (callback: (snapshot: QueueSnapshot) => void) => () => void;
      onGPUEncoderError: (callback: (error: GPUEncoderError) => void) => () => void;
      getPresets: () => Promise<RendererPreset[]>;
      getGpuCapabilities: (requestedCodec?: GPUCodec | null) => Promise<GPUCapabilitiesPayload>;
      getSettings: () => Promise<AppSettings>;
      getDefaultAdvancedFormatSettings: () => Promise<AdvancedFormatSettings>;
      saveSettings: (settings: SaveSettingsPayload) => Promise<void>;
      checkForUpdates: () => Promise<void>;
      downloadUpdate: () => Promise<void>;
      installUpdate: () => Promise<void>;
      isUpdatesDisabled: () => Promise<boolean>;
      onUpdateState: (callback: (payload: UpdateStatePayload) => void) => () => void;
      checkFFmpeg: () => Promise<boolean>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      revealPath: (path: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getSystemTheme: () => Promise<'dark' | 'light'>;
      onThemeChange: (callback: (theme: 'dark' | 'light') => void) => () => void;
      onAppMenuAction: (callback: (event: AppMenuActionEvent) => void) => () => void;
      setConversionMenuState: (state: ConversionMenuStatePayload) => void;
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      isWindowMaximized: () => Promise<boolean>;
      onWindowChromeStyle: (callback: (payload: WindowChromeStylePayload) => void) => () => void;
      onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => () => void;
      resetSettings: () => Promise<AppSettings>;
      restartApp: () => Promise<void>;
      getLicenses: () => Promise<Record<string, unknown> | null>;
    };
  }
}
