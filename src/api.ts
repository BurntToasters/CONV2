// The renderer API object. Every method maps to a Rust command, a Tauri
// event, or a webview capability. Callers import `api` and call
// `api.method(...)` at call time, so a replaced method is seen everywhere.
// The E2E hook exposes this same object.
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { call, fire, type SaveSettingsInput } from './commands';
import type * as Ipc from './generated/ipc-types';

/** Partial settings patch, as v1's SaveSettingsPayload accepted. */
export type SaveSettingsPayload = SaveSettingsInput;

/** Native menu delivery; `payload.paths` rides along with open-files. */
export interface AppMenuActionEvent {
  action: string;
  payload?: { paths?: string[] };
}

/** Drag-and-drop traffic Tauri delivers with real file paths. */
export interface DragDropPayload {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
}

export interface Conv2RendererApi {
  selectOutputDirectory: () => Promise<string | null>;
  selectInputFiles: () => Promise<string[]>;
  getFileInfo: (filePath: string) => Promise<Ipc.VideoInfo | null>;
  startConversionQueue: (payload: Ipc.StartConversionQueuePayload) => Promise<Ipc.QueueSnapshot>;
  cancelConversion: (force?: boolean) => Promise<void>;
  onConversionProgress: (callback: (progress: Ipc.ConversionProgress) => void) => () => void;
  onConversionLog: (callback: (message: string) => void) => () => void;
  onConversionQueueUpdated: (callback: (snapshot: Ipc.QueueSnapshot) => void) => () => void;
  onGPUEncoderError: (callback: (error: Ipc.GPUEncoderError) => void) => () => void;
  getPresets: () => Promise<Ipc.RendererPreset[]>;
  getGpuCapabilities: (requestedCodec?: Ipc.GpuCodec | null) => Promise<Ipc.GPUCapabilitiesPayload>;
  refreshGpuCapabilities: () => Promise<void>;
  getSettings: () => Promise<Ipc.AppSettings>;
  getDefaultSettings: () => Promise<Ipc.AppSettings>;
  saveSettings: (settings: SaveSettingsPayload) => Promise<void>;
  resetSettings: () => Promise<Ipc.AppSettings>;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  cancelUpdateDownload: () => Promise<void>;
  setUpdateChannel: (channel: Ipc.UpdateChannel) => Promise<void>;
  getDistributionChannel: () => Promise<string>;
  onUpdateState: (callback: (payload: Ipc.UpdateStatePayload) => void) => () => void;
  checkFFmpeg: () => Promise<Ipc.FFmpegStatus>;
  getVersion: () => Promise<string>;
  getPlatform: () => Promise<string>;
  /** Webview CPU architecture ('x64' | 'arm64' | ''); no Rust command needed. */
  getArch: () => Promise<string>;
  getSystemTheme: () => Promise<'dark' | 'light'>;
  onThemeChange: (callback: (theme: 'dark' | 'light') => void) => () => void;
  revealPath: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  restartApp: () => Promise<void>;
  setConversionMenuState: (state: Ipc.ConversionMenuStatePayload) => Promise<void>;
  logError: (message: string) => void;
  onAppMenuAction: (callback: (event: AppMenuActionEvent) => void) => () => void;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  startDragging: () => Promise<void>;
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void) => () => void;
  onDragDropEvent: (callback: (event: DragDropPayload) => void) => () => void;
}

function reportBridgeError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[conv2] ${context}: ${message}`);
}

function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  const registration = listen<T>(event, (message) => {
    if (!disposed) callback(message.payload);
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => {
      reportBridgeError(`listen ${event}`, error);
      throw error;
    });
  void registration.catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

/** Wraps a promise-based Tauri subscription so dispose works before resolve. */
function subscribeWith<T>(
  register: (deliver: (payload: T) => void) => Promise<UnlistenFn>,
  callback: (payload: T) => void
): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  void register((payload) => {
    if (!disposed) callback(payload);
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => {
      reportBridgeError('window listen', error);
    });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

/** High-entropy UA values exist only in Chromium webviews (Windows). */
interface NavigatorUserAgentData {
  getHighEntropyValues: (hints: string[]) => Promise<{ architecture?: string }>;
}

async function getWebviewArch(): Promise<string> {
  const userAgentData = (navigator as Navigator & { userAgentData?: NavigatorUserAgentData })
    .userAgentData;
  if (!userAgentData?.getHighEntropyValues) return '';
  try {
    const values = await userAgentData.getHighEntropyValues(['architecture']);
    if (values.architecture === 'arm') return 'arm64';
    if (values.architecture === 'x86') return 'x64';
  } catch {
    // fall through: the architecture stays unknown
  }
  return '';
}

/** A requestedCodec key is sent only with a value; absent means probe all. */
function gpuCapabilitiesArgs(requestedCodec?: Ipc.GpuCodec | null): {
  requestedCodec?: Ipc.GpuCodec;
} {
  return requestedCodec ? { requestedCodec } : {};
}

export const api: Conv2RendererApi = {
  selectOutputDirectory: () => call('select_output_directory'),
  selectInputFiles: () => call('select_input_files'),
  getFileInfo: (filePath) => call('get_file_info', { filePath }),
  startConversionQueue: (payload) => call('start_conversion_queue', { payload }),
  cancelConversion: (force) => call('cancel_conversion', { force: force === true }),
  onConversionProgress: (callback) => subscribe('conversion-progress', callback),
  onConversionLog: (callback) => subscribe('conversion-log', callback),
  onConversionQueueUpdated: (callback) => subscribe('conversion-queue-updated', callback),
  onGPUEncoderError: (callback) => subscribe('gpu-encoder-error', callback),
  getPresets: () => call('get_presets'),
  getGpuCapabilities: (requestedCodec) =>
    call('get_gpu_capabilities', gpuCapabilitiesArgs(requestedCodec)),
  refreshGpuCapabilities: () => call('refresh_gpu_capabilities'),
  getSettings: () => call('get_settings'),
  getDefaultSettings: () => call('get_default_settings'),
  saveSettings: (settings) => call('save_settings', { settings }),
  resetSettings: () => call('reset_settings'),
  checkForUpdates: () => call('check_for_updates'),
  downloadUpdate: () => call('download_update'),
  installUpdate: () => call('install_update'),
  cancelUpdateDownload: () => call('cancel_update_download'),
  setUpdateChannel: (channel) => call('set_update_channel', { channel }),
  getDistributionChannel: () => call('get_distribution_channel'),
  onUpdateState: (callback) => subscribe('update-state', callback),
  checkFFmpeg: () => call('check_ffmpeg'),
  getVersion: () => getVersion(),
  getPlatform: () => call('get_app_platform'),
  getArch: () => getWebviewArch(),
  getSystemTheme: () => call('get_system_theme'),
  onThemeChange: (callback) =>
    subscribeWith<'dark' | 'light'>(
      (deliver) =>
        getCurrentWindow().onThemeChanged((event) => {
          deliver(event.payload === 'dark' ? 'dark' : 'light');
        }),
      callback
    ),
  revealPath: (path) => call('reveal_path', { filePath: path }),
  openExternal: (url) => call('open_external', { url }),
  restartApp: () => call('restart_app'),
  setConversionMenuState: (state) => call('set_conversion_menu_state', { state }),
  logError: (message) => fire('log_error', { message }),
  onAppMenuAction: (callback) => subscribe('app-menu-action', callback),
  minimizeWindow: () => getCurrentWindow().minimize(),
  toggleMaximizeWindow: () => getCurrentWindow().toggleMaximize(),
  closeWindow: () => getCurrentWindow().close(),
  isWindowMaximized: () => getCurrentWindow().isMaximized(),
  startDragging: () => getCurrentWindow().startDragging(),
  onWindowMaximizedChanged: (callback) => {
    let lastMaximized: boolean | null = null;
    const report = (maximized: boolean): void => {
      if (lastMaximized === maximized) return;
      lastMaximized = maximized;
      callback(maximized);
    };
    const probe = (): void => {
      void getCurrentWindow()
        .isMaximized()
        .then(report)
        .catch(() => undefined);
    };
    const unsubscribe = subscribeWith<void>(
      (deliver) => getCurrentWindow().onResized(() => deliver(undefined)),
      probe
    );
    probe();
    return unsubscribe;
  },
  onDragDropEvent: (callback) =>
    subscribeWith<DragDropPayload>(
      (deliver) =>
        getCurrentWindow().onDragDropEvent((event) => {
          const payload = event.payload;
          deliver({
            type: payload.type,
            paths: payload.type === 'enter' || payload.type === 'drop' ? payload.paths : [],
          });
        }),
      callback
    ),
};

/** Dependency credits ship as the public licenses.json asset; null = absent. */
export async function fetchLicenses(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch('./licenses.json');
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
