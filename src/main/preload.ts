import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron';
import type {
  AppMenuActionEvent,
  ConversionMenuStatePayload,
  ElectronApi,
  GPUCapabilitiesPayload,
  GPUEncoderError,
  RendererPreset,
  SaveSettingsPayload,
  StartConversionQueuePayload,
  UpdateStatePayload,
  WindowChromeStylePayload,
} from '../shared/electronApi';
import type {
  AppSettings,
  ConversionProgress,
  GPUCodec,
  QueueSnapshot,
  VideoInfo,
} from '../shared/appContract';
import type { AdvancedFormatSettings } from './advancedFormats';

const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

// Typed against the shared contract so preload and renderer cannot drift.
const api: ElectronApi = {
  // File operations
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  selectOutputDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('select-output-directory'),
  getFileInfo: (filePath: string): Promise<VideoInfo | null> =>
    ipcRenderer.invoke('get-file-info', filePath),

  // Conversion
  startConversionQueue: (payload: StartConversionQueuePayload): Promise<QueueSnapshot> =>
    ipcRenderer.invoke('start-conversion-queue', payload),
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
  refreshGpuCapabilities: (): Promise<void> => ipcRenderer.invoke('refresh-gpu-capabilities'),

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
};

contextBridge.exposeInMainWorld('electronAPI', api);
