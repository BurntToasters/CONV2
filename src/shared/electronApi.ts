// The preload bridge contract. preload.ts implements it; the renderer consumes window.electronAPI.
import type { AdvancedFormatSettings } from '../main/advancedFormats';
import type { UIPanelSettings } from '../main/settingsSchema';
import type {
  AppSettings,
  ConversionProgress,
  GPUCodec,
  GPUVendor,
  QueueSnapshot,
  VideoInfo,
} from './appContract';

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

export interface StartConversionQueuePayload {
  inputPaths: string[];
  presetId: string;
  gpu: GPUVendor;
  removeSpacesFromFilenames?: boolean;
  outputDirectory?: string;
  showDebugOutput?: boolean;
}

type Unsubscribe = () => void;

export interface ElectronApi {
  getPathForFile: (file: File) => string;
  selectOutputDirectory: () => Promise<string | null>;
  getFileInfo: (filePath: string) => Promise<VideoInfo | null>;
  startConversionQueue: (payload: StartConversionQueuePayload) => Promise<QueueSnapshot>;
  cancelConversion: (force?: boolean) => Promise<void>;
  onConversionProgress: (callback: (progress: ConversionProgress) => void) => Unsubscribe;
  onConversionLog: (callback: (message: string) => void) => Unsubscribe;
  onConversionQueueUpdated: (callback: (snapshot: QueueSnapshot) => void) => Unsubscribe;
  onGPUEncoderError: (callback: (error: GPUEncoderError) => void) => Unsubscribe;
  getPresets: () => Promise<RendererPreset[]>;
  getGpuCapabilities: (requestedCodec?: GPUCodec | null) => Promise<GPUCapabilitiesPayload>;
  refreshGpuCapabilities: () => Promise<void>;
  getSettings: () => Promise<AppSettings>;
  getDefaultAdvancedFormatSettings: () => Promise<AdvancedFormatSettings>;
  saveSettings: (settings: SaveSettingsPayload) => Promise<void>;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  isUpdatesDisabled: () => Promise<boolean>;
  onUpdateState: (callback: (payload: UpdateStatePayload) => void) => Unsubscribe;
  checkFFmpeg: () => Promise<boolean>;
  getVersion: () => Promise<string>;
  getPlatform: () => Promise<string>;
  /** shell.showItemInFolder: reveals, never opens or executes. */
  revealPath: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getSystemTheme: () => Promise<'dark' | 'light'>;
  onThemeChange: (callback: (theme: 'dark' | 'light') => void) => Unsubscribe;
  onAppMenuAction: (callback: (event: AppMenuActionEvent) => void) => Unsubscribe;
  setConversionMenuState: (state: ConversionMenuStatePayload) => void;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowChromeStyle: (callback: (payload: WindowChromeStylePayload) => void) => Unsubscribe;
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => Unsubscribe;
  resetSettings: () => Promise<AppSettings>;
  restartApp: () => Promise<void>;
  getLicenses: () => Promise<Record<string, unknown> | null>;
}

declare global {
  interface Window {
    electronAPI: ElectronApi;
  }
}
