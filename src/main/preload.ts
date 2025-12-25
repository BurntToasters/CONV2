import { contextBridge, ipcRenderer } from 'electron';

export interface ConversionProgress {
  percent: number;
  frame: number;
  fps: number;
  time: string;
  bitrate: string;
  speed: string;
}

export interface AppSettings {
  outputDirectory: string;
  gpu: 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
  theme: 'system' | 'dark' | 'light';
  showDebugOutput: boolean;
  autoCheckUpdates: boolean;
}

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
  gpu?: 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
}

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('select-file'),
  selectOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke('select-output-directory'),
  getFileInfo: (filePath: string): Promise<VideoInfo | null> => ipcRenderer.invoke('get-file-info', filePath),

  // Conversion
  startConversion: (inputPath: string, presetId: string): Promise<void> =>
    ipcRenderer.invoke('start-conversion', inputPath, presetId),
  cancelConversion: (): Promise<void> => ipcRenderer.invoke('cancel-conversion'),
  onConversionProgress: (callback: (progress: ConversionProgress) => void): void => {
    ipcRenderer.on('conversion-progress', (_, progress) => callback(progress));
  },
  onConversionLog: (callback: (message: string) => void): void => {
    ipcRenderer.on('conversion-log', (_, message) => callback(message));
  },
  onConversionComplete: (callback: (result: { success: boolean; outputPath: string; error?: string }) => void): void => {
    ipcRenderer.on('conversion-complete', (_, result) => callback(result));
  },
  onGPUEncoderError: (callback: (error: GPUEncoderError) => void): void => {
    ipcRenderer.on('gpu-encoder-error', (_, error) => callback(error));
  },

  // Presets
  getPresets: (): Promise<Array<{ id: string; name: string; description: string; category: string }>> =>
    ipcRenderer.invoke('get-presets'),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke('save-settings', settings),

  // Updates
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (callback: (message: string) => void): void => {
    ipcRenderer.on('update-status', (_, message) => callback(message));
  },
  onUpdateProgress: (callback: (percent: number) => void): void => {
    ipcRenderer.on('update-download-progress', (_, percent) => callback(percent));
  },
  onUpdateAvailable: (callback: (available: boolean) => void): void => {
    ipcRenderer.on('update-available', (_, available) => callback(available));
  },

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
  onThemeChange: (callback: (theme: 'dark' | 'light') => void): void => {
    ipcRenderer.on('theme-changed', (_, theme) => callback(theme));
  },

  // Reset & Restart
  resetSettings: (): Promise<AppSettings> => ipcRenderer.invoke('reset-settings'),
  restartApp: (): Promise<void> => ipcRenderer.invoke('restart-app'),

  // Licenses
  getLicenses: (): Promise<Record<string, unknown> | null> => ipcRenderer.invoke('get-licenses'),
});

declare global {
  interface Window {
    electronAPI: {
      selectFile: () => Promise<string | null>;
      selectOutputDirectory: () => Promise<string | null>;
      getFileInfo: (filePath: string) => Promise<VideoInfo | null>;
      startConversion: (inputPath: string, presetId: string) => Promise<void>;
      cancelConversion: () => Promise<void>;
      onConversionProgress: (callback: (progress: ConversionProgress) => void) => void;
      onConversionLog: (callback: (message: string) => void) => void;
      onConversionComplete: (callback: (result: { success: boolean; outputPath: string; error?: string }) => void) => void;
      onGPUEncoderError: (callback: (error: GPUEncoderError) => void) => void;
      getPresets: () => Promise<Array<{ id: string; name: string; description: string; category: string }>>;
      getSettings: () => Promise<AppSettings>;
      saveSettings: (settings: Partial<AppSettings>) => Promise<void>;
      checkForUpdates: () => Promise<void>;
      onUpdateStatus: (callback: (message: string) => void) => void;
      onUpdateProgress: (callback: (percent: number) => void) => void;
      onUpdateAvailable: (callback: (available: boolean) => void) => void;
      checkFFmpeg: () => Promise<boolean>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      openPath: (path: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getSystemTheme: () => Promise<'dark' | 'light'>;
      onThemeChange: (callback: (theme: 'dark' | 'light') => void) => void;
      resetSettings: () => Promise<AppSettings>;
      restartApp: () => Promise<void>;
      getLicenses: () => Promise<Record<string, unknown> | null>;
    };
  }
}
