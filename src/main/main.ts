import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  shell,
  screen,
  IpcMainInvokeEvent,
  IpcMainEvent,
  FileFilter,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { presets, getPresetById, GPUVendor, GPUCodec, getPresetGpuCodec } from './presets';
import {
  AdvancedFormatSettings,
  createDefaultAdvancedFormatSettings,
  mergeAdvancedFormatSettings,
  normalizeAdvancedFormatSettings,
} from './advancedFormats';
import {
  convertVideo,
  cancelConversion as cancelFFmpegConversion,
  checkFFmpegInstalled,
  getVideoInfo,
  GPU_ENCODERS,
  checkGPUEncoderSupport,
  parseGPUError,
  redactPaths,
  ConversionResult,
  waitForConversionStop,
} from './ffmpeg';
import {
  initUpdater,
  checkForUpdates,
  checkForUpdatesSilent,
  installDownloadedUpdate,
  isUpdateDisabled,
  isUpdateReadyToInstall,
  onUpdateMenuStateChange,
  setUpdateChannel,
  setUpdateInstallStartingHandler,
  setUpdaterWindow,
} from './updater';
import { setUseSystemFFmpeg } from './ffmpegPath';
import { clearFFmpegCaches } from './ffmpeg';
import { normalizeFileUrl, isFrameUrlTrusted } from './ipcTrust';
import {
  SETTINGS_SCHEMA_VERSION,
  UIPanelSettings,
  ThemePreference,
  CustomThemeId,
  normalizeRecentPresetIds,
  normalizeUiPanels,
  normalizeTheme,
  normalizeCustomTheme,
  normalizeSetupWizardCompleted,
  isSettingsCorrupted,
  isSettingsSchemaOutdated,
} from './settingsSchema';
import { recommendGpuVendorFromAvailability } from './gpuRecommendation';
import { mapPresetsForRenderer } from './presetProjection';
import {
  createEmptyQueueSnapshot,
  runConversionQueue,
  shouldRetryWithCpu,
  type QueueSnapshot,
} from './conversionQueue';
import { registerConversionCancelIpc } from './conversionIpc';
import {
  installApplicationMenu,
  type AppMenuActionId,
  type ApplicationMenuController,
  type ConversionMenuState,
} from './applicationMenu';
import {
  conversionActivityEnded,
  conversionActivityStarted,
  initOsIntegration,
  installWindowsJumpList,
  maybeNotifyConversionComplete,
  parseConv2JumpArg,
  registerRecentOutput,
  runConv2JumpAction,
  setQueueProgressScope,
  summarizeQueueForNotification,
  updateTaskbarProgress,
  type JumpListDeps,
  type OsIntegrationSettings,
} from './osIntegration';
import {
  attachWindowChromeListeners,
  getWindowChromeConstructorOptions,
  registerWindowChromeIpc,
  sendWindowChromeStyle,
} from './windowChrome';

if (process.platform === 'darwin') {
  const commonPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  const currentPath = process.env.PATH || '';
  const existingParts = new Set(currentPath.split(path.delimiter));
  const missing = commonPaths.filter((p) => !existingParts.has(p));
  if (missing.length > 0) {
    process.env.PATH = currentPath + path.delimiter + missing.join(path.delimiter);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setName('CONV2');

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const jump = parseConv2JumpArg(argv);
  if (jump) {
    void runConv2JumpAction(jump, getJumpListDeps());
  }
});

const pendingOpenPaths: string[] = [];

const getOsIntegrationSettings = (): OsIntegrationSettings => ({
  preventSleepWhileConverting: settings.preventSleepWhileConverting,
  notifyOnConversionComplete: settings.notifyOnConversionComplete,
});

const getJumpListDeps = (): JumpListDeps => ({
  pickVideoFiles: async () => {
    const win = mainWindow;
    if (!win) return [];
    return pickVideoFilesDialog(win);
  },
  sendMenuAction: (action, payload) => {
    if (action === 'open-files') {
      sendAppMenuAction('open-files', payload);
    } else {
      sendAppMenuAction('open-settings');
    }
  },
  checkForUpdates,
  isUpdateDisabled,
});

const ingestOpenPaths = (paths: string[]): void => {
  const valid = paths
    .map((entry) => resolveExistingFilePath(entry))
    .filter((entry): entry is string => entry !== null);
  if (valid.length === 0) {
    return;
  }
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingOpenPaths.push(...valid);
    return;
  }
  sendAppMenuAction('open-files', { paths: valid });
};

const flushPendingOpenPaths = (): void => {
  if (pendingOpenPaths.length === 0) {
    return;
  }
  const paths = pendingOpenPaths.splice(0, pendingOpenPaths.length);
  sendAppMenuAction('open-files', { paths });
};

const notifySingleConversionResult = async (
  result: ConversionResult,
  inputPath: string
): Promise<void> => {
  const snapshot = createEmptyQueueSnapshot();
  snapshot.total = 1;
  snapshot.items = [
    {
      id: 'single',
      inputPath,
      fileName: path.basename(inputPath),
      status: result.success
        ? 'done'
        : result.error === 'Conversion cancelled'
          ? 'cancelled'
          : 'failed',
      error: result.error,
      outputPath: result.outputPath || undefined,
    },
  ];
  const summary = summarizeQueueForNotification(snapshot);
  const revealOutputPath = result.success ? result.outputPath : undefined;
  await maybeNotifyConversionComplete(summary, getOsIntegrationSettings(), () => mainWindow, {
    revealOutputPath,
  });
};

const resolveRevealOutputPath = (snapshot: QueueSnapshot): string | undefined => {
  const successes = snapshot.items.filter(
    (item) => item.status === 'done' && item.outputPath && item.outputPath.length > 0
  );
  const last = successes[successes.length - 1];
  return last?.outputPath;
};

if (process.platform === 'darwin') {
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    ingestOpenPaths([filePath]);
  });
}

let isConversionActive = false;
let isUpdateInstallInProgress = false;
let trustedRendererUrl: string | null = null;
let activeConversionAbortController: AbortController | null = null;
const cancelActiveConversion = (force = false): void => {
  activeConversionAbortController?.abort();
  cancelFFmpegConversion(force);
};
const isRuntimeSmoke = process.argv.includes('--smoke') || process.env.CONV2_SMOKE === '1';
const handleNativeThemeUpdated = (): void => {
  mainWindow?.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
};

type GPUMode = 'auto' | 'manual';

interface AppSettings {
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

type SaveSettingsPayload = Omit<Partial<AppSettings>, 'uiPanels'> & {
  uiPanels?: Partial<UIPanelSettings>;
};

const ALLOWED_SETTINGS_KEYS = new Set<string>([
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

const createDefaultSettings = (): AppSettings => ({
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

const normalizeUpdateChannel = (value: unknown): AppSettings['updateChannel'] => {
  return value === 'stable' || value === 'beta' || value === 'auto' ? value : 'auto';
};

const normalizeGpuMode = (value: unknown): GPUMode => {
  return value === 'manual' || value === 'auto' ? value : 'auto';
};

const normalizeGpuVendor = (value: unknown): GPUVendor => {
  return value === 'nvidia' ||
    value === 'amd' ||
    value === 'intel' ||
    value === 'apple' ||
    value === 'cpu'
    ? value
    : 'cpu';
};

const normalizeSettings = (value: unknown): AppSettings => {
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
    outputDirectory:
      typeof incoming.outputDirectory === 'string'
        ? incoming.outputDirectory
        : defaults.outputDirectory,
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

const resolveAbsolutePath = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  return path.resolve(trimmed);
};

const resolveExistingFilePath = (value: unknown): string | null => {
  const resolved = resolveAbsolutePath(value);
  if (!resolved) {
    return null;
  }
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
};

const resolveExistingDirectoryPath = (value: unknown): string | null => {
  const resolved = resolveAbsolutePath(value);
  if (!resolved) {
    return null;
  }
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
};

interface GPUCapabilityStatus {
  available: boolean;
  reason: string;
  encoder: string;
}

type GPUCapabilityMatrix = Partial<Record<GPUCodec, Record<GPUVendor, GPUCapabilityStatus>>>;

interface GPUCapabilitiesPayload {
  platform: NodeJS.Platform;
  requestedCodec: GPUCodec | null;
  checkedCodecs: GPUCodec[];
  matrix: GPUCapabilityMatrix;
  recommendedVendor: GPUVendor;
  recommendationReason: string;
}

const GPU_VENDORS: GPUVendor[] = ['nvidia', 'amd', 'intel', 'apple', 'cpu'];
const GPU_CODECS: GPUCodec[] = ['h264', 'h265', 'av1'];

const getRecommendedVendor = (
  platform: NodeJS.Platform,
  requestedCodec: GPUCodec | null,
  matrix: GPUCapabilityMatrix
): { vendor: GPUVendor; reason: string } => {
  if (!requestedCodec) {
    return {
      vendor: 'cpu',
      reason: 'Preset does not use GPU-accelerated video encoding.',
    };
  }

  const row = matrix[requestedCodec];
  if (!row) {
    return {
      vendor: 'cpu',
      reason: 'Capability data unavailable. Falling back to CPU.',
    };
  }

  const availabilityByVendor = GPU_VENDORS.reduce(
    (acc, vendor) => {
      acc[vendor] = row[vendor]?.available === true;
      return acc;
    },
    {} as Record<GPUVendor, boolean>
  );

  return recommendGpuVendorFromAvailability(platform, requestedCodec, availabilityByVendor);
};

const buildGpuCapabilitiesPayload = async (
  requestedCodec: GPUCodec | null
): Promise<GPUCapabilitiesPayload> => {
  const codecsToCheck = requestedCodec ? [requestedCodec] : GPU_CODECS;
  const matrix: GPUCapabilityMatrix = {};

  for (const codec of codecsToCheck) {
    const vendorChecks = GPU_VENDORS.map(
      async (vendor): Promise<[GPUVendor, GPUCapabilityStatus]> => {
        if (vendor === 'cpu') {
          return [
            vendor,
            {
              available: true,
              reason: 'Software encoding fallback.',
              encoder: GPU_ENCODERS[codec].cpu,
            },
          ];
        }

        if (vendor === 'apple' && process.platform !== 'darwin') {
          return [
            vendor,
            {
              available: false,
              reason: 'Apple VideoToolbox available only on macOS.',
              encoder: GPU_ENCODERS[codec].apple,
            },
          ];
        }

        if (vendor === 'apple' && codec === 'av1') {
          return [
            vendor,
            {
              available: false,
              reason: 'Apple AV1 hardware encode unavailable. Use CPU for AV1.',
              encoder: GPU_ENCODERS[codec].apple,
            },
          ];
        }

        const check = await checkGPUEncoderSupport(vendor, codec);
        return [
          vendor,
          {
            available: check.available,
            reason: check.available ? 'Available' : check.error?.message || 'Unavailable',
            encoder: check.encoder || GPU_ENCODERS[codec][vendor],
          },
        ];
      }
    );

    const results = await Promise.all(vendorChecks);
    const row = {} as Record<GPUVendor, GPUCapabilityStatus>;
    for (const [vendor, status] of results) {
      row[vendor] = status;
    }
    matrix[codec] = row;
  }

  const recommendation = getRecommendedVendor(process.platform, requestedCodec, matrix);

  return {
    platform: process.platform,
    requestedCodec,
    checkedCodecs: codecsToCheck,
    matrix,
    recommendedVendor: recommendation.vendor,
    recommendationReason: recommendation.reason,
  };
};

const isTrustedIpcSender = (event: IpcMainInvokeEvent): boolean => {
  if (!mainWindow) {
    return false;
  }

  if (event.sender.id !== mainWindow.webContents.id) {
    return false;
  }

  return isFrameUrlTrusted(event.senderFrame?.url, trustedRendererUrl);
};

const assertTrustedIpcSender = (event: IpcMainInvokeEvent): void => {
  if (!isTrustedIpcSender(event)) {
    throw new Error('Untrusted IPC sender');
  }
};

let mainWindow: BrowserWindow | null = null;
let settings: AppSettings = createDefaultSettings();
let queueCancelled = false;
let latestQueueSnapshot: QueueSnapshot = createEmptyQueueSnapshot();
let conversionMenuState: ConversionMenuState = { converting: false, hasOutput: false };
let applicationMenuController: ApplicationMenuController | null = null;

const VIDEO_FILE_DIALOG_FILTERS: FileFilter[] = [
  {
    name: 'Video Files',
    extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg', '3gp'],
  },
  { name: 'All Files', extensions: ['*'] },
];

const pickVideoFilesDialog = async (win: BrowserWindow): Promise<string[]> => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: VIDEO_FILE_DIALOG_FILTERS,
  });
  return result.canceled ? [] : result.filePaths;
};

const sendAppMenuAction = (action: AppMenuActionId, payload?: { paths?: string[] }): void => {
  mainWindow?.webContents.send('app-menu-action', { action, payload });
};

const refreshApplicationMenuState = (): void => {
  applicationMenuController?.refresh();
};

const ensureApplicationMenu = (): void => {
  if (applicationMenuController) {
    applicationMenuController.refresh();
    return;
  }
  applicationMenuController = installApplicationMenu(
    {
      getMainWindow: () => mainWindow,
      sendMenuAction: sendAppMenuAction,
      pickVideoFiles: async () => {
        const win = mainWindow;
        if (!win) return [];
        return pickVideoFilesDialog(win);
      },
      checkForUpdates,
      installDownloadedUpdate,
      isUpdateReadyToInstall,
      isUpdateDisabled,
      getConversionMenuState: () => conversionMenuState,
    },
    onUpdateMenuStateChange
  );
  installWindowsJumpList(getJumpListDeps());
};

const resolveResolvedThemeId = (): string => {
  if (settings.theme === 'custom') {
    return settings.customTheme;
  }
  if (settings.theme === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }
  return settings.theme;
};

const resolveWindowBackgroundColor = (): string => {
  const themeId = resolveResolvedThemeId();
  switch (themeId) {
    case 'light':
      return '#f6f8fa';
    case 'midnight-blue':
      return '#0a0e17';
    case 'high-contrast-dark':
      return '#000000';
    case 'dark':
    default:
      return '#010409';
  }
};

const syncNativeThemeSource = (): void => {
  if (settings.theme === 'system') {
    nativeTheme.themeSource = 'system';
  } else if (settings.theme === 'light') {
    nativeTheme.themeSource = 'light';
  } else {
    // dark + custom packs use dark chrome
    nativeTheme.themeSource = 'dark';
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(resolveWindowBackgroundColor());
  }
};

const getSettingsPath = (): string => {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
};

const loadSettings = (): void => {
  let shouldPersist = false;
  const settingsPath = getSettingsPath();

  // Remove any stale .tmp file left by a crash mid-save
  try {
    fs.unlinkSync(settingsPath + '.tmp');
  } catch {
    // doesn't exist — fine
  }

  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (isSettingsCorrupted(parsed)) {
        try {
          fs.copyFileSync(settingsPath, `${settingsPath}.corrupt-${Date.now()}`);
        } catch {
          // backup failure is non-fatal
        }
        settings = createDefaultSettings();
        shouldPersist = true;
      } else {
        settings = normalizeSettings(parsed);
        if (isSettingsSchemaOutdated(parsed)) {
          shouldPersist = true;
        }
      }
    } else {
      settings = createDefaultSettings();
    }
  } catch {
    // JSON parse failure or unexpected I/O error — back up the file if it exists
    try {
      if (fs.existsSync(settingsPath)) {
        fs.copyFileSync(settingsPath, `${settingsPath}.corrupt-${Date.now()}`);
      }
    } catch {
      // backup failure is non-fatal
    }
    settings = createDefaultSettings();
    shouldPersist = true;
  }
  setUpdateChannel(settings.updateChannel);
  setUseSystemFFmpeg(settings.useSystemFFmpeg);
  clearFFmpegCaches();
  if (shouldPersist) {
    saveSettings();
  }
};

const saveSettings = (): void => {
  try {
    const settingsPath = getSettingsPath();
    const tmpPath = settingsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    const fd = fs.openSync(tmpPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, settingsPath);
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
};

const prepareForUpdateInstall = async (): Promise<void> => {
  isUpdateInstallInProgress = true;
  if (!isConversionActive) {
    return;
  }

  cancelActiveConversion(true);
  const stopped = await waitForConversionStop(3000);
  if (!stopped) {
    cancelActiveConversion(true);
    await waitForConversionStop(1500);
  }
  isConversionActive = false;
};

// ── Window state persistence ─────────────────────────────────────────────────

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const DEFAULT_WINDOW_WIDTH = 1080;
const DEFAULT_WINDOW_HEIGHT = 880;

const getWindowStatePath = (): string => path.join(app.getPath('userData'), 'windowState.json');

const isWindowBoundsOnScreen = (x: number, y: number, width: number, height: number): boolean => {
  const TITLE_BAR_CLEARANCE = 64;
  return screen.getAllDisplays().some(({ bounds }) => {
    return (
      x + width > bounds.x &&
      x < bounds.x + bounds.width &&
      y + TITLE_BAR_CLEARANCE > bounds.y &&
      y < bounds.y + bounds.height
    );
  });
};

const loadWindowState = (): WindowState => {
  const defaults: WindowState = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  try {
    const statePath = getWindowStatePath();
    if (!fs.existsSync(statePath)) return defaults;
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const width =
      typeof data.width === 'number' && data.width >= 600 ? data.width : DEFAULT_WINDOW_WIDTH;
    const height =
      typeof data.height === 'number' && data.height >= 500 ? data.height : DEFAULT_WINDOW_HEIGHT;
    return {
      width,
      height,
      x: typeof data.x === 'number' ? data.x : undefined,
      y: typeof data.y === 'number' ? data.y : undefined,
      isMaximized: data.isMaximized === true,
    };
  } catch {
    return defaults;
  }
};

const saveWindowState = (): void => {
  if (!mainWindow) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    // getNormalBounds() returns restored-state bounds even when maximized
    const bounds = mainWindow.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save window state:', err);
  }
};

const getLicensesFilePath = (): string | null => {
  const appPath = app.getAppPath();
  const unpackedAppPath = path.resolve(appPath, '..');
  const candidates = [
    path.join(appPath, 'licenses.json'),
    path.join(unpackedAppPath, 'licenses.json'),
    path.join(process.resourcesPath, 'licenses.json'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'licenses.json'),
    path.resolve(__dirname, '../../licenses.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

const createWindow = (): void => {
  ensureApplicationMenu();
  const rendererEntryPath = path.join(__dirname, '../renderer/index.html');
  trustedRendererUrl = normalizeFileUrl(pathToFileURL(rendererEntryPath).toString());

  const windowState = loadWindowState();
  const positionOpts: { x?: number; y?: number } = {};
  if (
    windowState.x !== undefined &&
    windowState.y !== undefined &&
    isWindowBoundsOnScreen(windowState.x, windowState.y, windowState.width, windowState.height)
  ) {
    positionOpts.x = windowState.x;
    positionOpts.y = windowState.y;
  }

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...positionOpts,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: resolveWindowBackgroundColor(),
    ...getWindowChromeConstructorOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
    show: false,
  });

  attachWindowChromeListeners(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const normalized = normalizeFileUrl(targetUrl);
    if (!normalized || normalized !== trustedRendererUrl) {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(rendererEntryPath);

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      sendWindowChromeStyle(mainWindow!);
    }, 0);
    flushPendingOpenPaths();
    const jump = parseConv2JumpArg(process.argv);
    if (jump) {
      void runConv2JumpAction(jump, getJumpListDeps());
    }
  });

  if (isRuntimeSmoke) {
    mainWindow.webContents.once('did-finish-load', () => {
      void mainWindow?.webContents
        .executeJavaScript(
          `Promise.resolve(window.electronAPI?.getVersion()).then((version) => ({
            title: document.title,
            version,
          }))`,
          true
        )
        .then((result) => {
          if (result?.title !== 'CONV2' || result.version !== app.getVersion()) {
            throw new Error(
              `Runtime smoke returned invalid renderer state: ${JSON.stringify(result)}`
            );
          }
          app.exit(0);
        })
        .catch((error) => {
          console.error('Runtime smoke failed:', error);
          app.exit(1);
        });
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (windowState.isMaximized) {
      mainWindow?.maximize();
    }

    if (process.argv.includes('--dev')) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }

    if (app.isPackaged && settings.autoCheckUpdates) {
      setTimeout(() => {
        checkForUpdatesSilent();
      }, 3000);
    }
  });

  mainWindow.on('closed', () => {
    setUpdaterWindow(null);
    mainWindow = null;
    trustedRendererUrl = null;
  });

  mainWindow.on('close', (e) => {
    saveWindowState();
    if (isConversionActive && !isUpdateInstallInProgress) {
      e.preventDefault();
      dialog
        .showMessageBox(mainWindow!, {
          type: 'warning',
          title: 'Conversion in Progress',
          message: 'A conversion is currently running. Are you sure you want to quit?',
          buttons: ['Cancel', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0,
        })
        .then(async (result) => {
          if (result.response === 1) {
            cancelActiveConversion(true);
            await waitForConversionStop(3000);
            isConversionActive = false;
            mainWindow?.destroy();
          }
        });
    }
  });

  initUpdater(mainWindow);
};

app.whenReady().then(() => {
  initOsIntegration();
  loadSettings();
  syncNativeThemeSource();
  setUpdateInstallStartingHandler(prepareForUpdateInstall);
  nativeTheme.on('updated', handleNativeThemeUpdated);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', async (e) => {
  nativeTheme.removeListener('updated', handleNativeThemeUpdated);
  if (isUpdateInstallInProgress) {
    return;
  }
  if (isConversionActive) {
    e.preventDefault();
    cancelActiveConversion(true);
    const stopped = await waitForConversionStop(3000);
    if (!stopped) {
      cancelActiveConversion(true);
      await waitForConversionStop(1500);
    }
    isConversionActive = false;
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

ipcMain.on('conversion-menu-state', (event: IpcMainEvent, state: unknown) => {
  if (!isTrustedIpcSender(event as IpcMainInvokeEvent)) {
    return;
  }
  if (!state || typeof state !== 'object') {
    return;
  }
  const record = state as Record<string, unknown>;
  conversionMenuState = {
    converting: record.converting === true,
    hasOutput: record.hasOutput === true,
  };
  refreshApplicationMenuState();
});

registerWindowChromeIpc(() => mainWindow, assertTrustedIpcSender);
registerConversionCancelIpc({
  assertTrustedIpcSender,
  markQueueCancelled: () => {
    queueCancelled = true;
  },
  cancelActiveConversion: (force) => cancelActiveConversion(!!force),
});

ipcMain.handle('select-file', async (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  const win = mainWindow;
  if (!win) return [];
  return pickVideoFilesDialog(win);
});

ipcMain.handle('select-output-directory', async (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  const win = mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

const performSingleConversion = async (
  inputPath: string,
  presetId: string,
  gpuOverride: GPUVendor | undefined,
  options?: {
    suppressGpuErrorEvent?: boolean;
    removeSpacesFromFilenames?: boolean;
    outputDirectory?: string;
    showDebugOutput?: boolean;
    emitCompleteEvent?: boolean;
  }
): Promise<ConversionResult> => {
  const resolvedInputPath = resolveExistingFilePath(inputPath);
  if (!resolvedInputPath) {
    return { success: false, outputPath: '', error: 'Invalid input file path' };
  }

  const suppressGpuErrorEvent = options?.suppressGpuErrorEvent === true;
  const showDebugOutput = options?.showDebugOutput ?? settings.showDebugOutput;
  const emitCompleteEvent = options?.emitCompleteEvent !== false;

  const preset = getPresetById(presetId);
  if (!preset) {
    return { success: false, outputPath: '', error: 'Invalid preset selected' };
  }

  const requestedGpu =
    gpuOverride === undefined ? settings.gpuManualVendor : normalizeGpuVendor(gpuOverride);
  const codec = getPresetGpuCodec(preset, {
    advancedFormatSettings: settings.advancedFormatSettings,
  });
  const effectiveGpu =
    requestedGpu === 'apple' && codec === 'av1'
      ? 'cpu'
      : requestedGpu === 'amd' && process.platform === 'linux'
        ? 'cpu'
        : requestedGpu;

  const conversionAbortController = new AbortController();
  activeConversionAbortController = conversionAbortController;
  try {
    if (codec !== null && effectiveGpu !== 'cpu') {
      const encoderCheck = await checkGPUEncoderSupport(
        effectiveGpu,
        codec,
        conversionAbortController.signal
      );
      if (conversionAbortController.signal.aborted) {
        return { success: false, outputPath: '', error: 'Conversion cancelled' };
      }
      if (!encoderCheck.available && encoderCheck.error) {
        if (!suppressGpuErrorEvent) {
          mainWindow?.webContents.send('gpu-encoder-error', encoderCheck.error);
        }
        return {
          success: false,
          outputPath: '',
          error: encoderCheck.error.message,
          retryWithCpuSuggested: encoderCheck.error.canRetryWithCPU,
        };
      }
    }

    const outputDir =
      resolveExistingDirectoryPath(options?.outputDirectory) ??
      resolveExistingDirectoryPath(settings.outputDirectory) ??
      path.dirname(resolvedInputPath);

    let result: ConversionResult;
    try {
      result = await convertVideo(
        resolvedInputPath,
        outputDir,
        preset,
        effectiveGpu,
        (progress) => {
          updateTaskbarProgress(progress, () => mainWindow);
          mainWindow?.webContents.send('conversion-progress', progress);
        },
        showDebugOutput
          ? (message) => {
              mainWindow?.webContents.send('conversion-log', redactPaths(message));
            }
          : undefined,
        {
          removeSpacesFromOutputName:
            options?.removeSpacesFromFilenames ?? settings.removeSpacesFromFilenames,
          useCpuDecodingWhenGpu: settings.useCpuDecodingWhenGpu,
          advancedFormatSettings: settings.advancedFormatSettings,
          signal: conversionAbortController.signal,
        }
      );
    } catch (err) {
      result = {
        success: false,
        outputPath: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!result.success && result.error && effectiveGpu !== 'cpu' && codec !== null) {
      const gpuError = parseGPUError(result.error, effectiveGpu, codec);
      if (gpuError) {
        result.retryWithCpuSuggested = gpuError.canRetryWithCPU;
        if (!suppressGpuErrorEvent) {
          mainWindow?.webContents.send('gpu-encoder-error', gpuError);
        }
      }
    }

    if (result.success && settings.moveOriginalToTrashOnSuccess) {
      try {
        await shell.trashItem(resolvedInputPath);
        if (showDebugOutput) {
          mainWindow?.webContents.send(
            'conversion-log',
            redactPaths(`Moved original file to trash: ${resolvedInputPath}\n`)
          );
        }
      } catch (trashError) {
        if (showDebugOutput) {
          const errorMessage =
            trashError instanceof Error ? trashError.message : String(trashError);
          mainWindow?.webContents.send(
            'conversion-log',
            redactPaths(`Failed to move original file to trash: ${errorMessage}\n`)
          );
        }
      }
    }

    const resultForRenderer: ConversionResult = result.error
      ? { ...result, error: redactPaths(result.error) }
      : result;
    if (emitCompleteEvent) {
      mainWindow?.webContents.send('conversion-complete', resultForRenderer);
    }
    if (result.success && result.outputPath) {
      registerRecentOutput(result.outputPath);
    }
    return resultForRenderer;
  } finally {
    if (activeConversionAbortController === conversionAbortController) {
      activeConversionAbortController = null;
    }
  }
};

ipcMain.handle(
  'start-conversion',
  async (
    event: IpcMainInvokeEvent,
    inputPath: string,
    presetId: string,
    gpuOverride?: GPUVendor,
    options?: {
      suppressGpuErrorEvent?: boolean;
      removeSpacesFromFilenames?: boolean;
      outputDirectory?: string;
      showDebugOutput?: boolean;
    }
  ): Promise<ConversionResult> => {
    assertTrustedIpcSender(event);
    if (isConversionActive) {
      const busyResult: ConversionResult = {
        success: false,
        outputPath: '',
        error: 'Another conversion is already in progress',
      };
      mainWindow?.webContents.send('conversion-complete', busyResult);
      return busyResult;
    }

    isConversionActive = true;
    setQueueProgressScope(null);
    conversionActivityStarted(getOsIntegrationSettings());
    try {
      const result = await performSingleConversion(inputPath, presetId, gpuOverride, options);
      await notifySingleConversionResult(result, inputPath);
      return result;
    } finally {
      isConversionActive = false;
      conversionActivityEnded(() => mainWindow);
    }
  }
);

ipcMain.handle(
  'start-conversion-queue',
  async (
    event: IpcMainInvokeEvent,
    payload: {
      inputPaths: string[];
      presetId: string;
      gpu: GPUVendor;
      removeSpacesFromFilenames?: boolean;
      outputDirectory?: string;
      showDebugOutput?: boolean;
    }
  ): Promise<QueueSnapshot> => {
    assertTrustedIpcSender(event);
    if (isConversionActive) {
      const busy = createEmptyQueueSnapshot();
      busy.items = (payload.inputPaths || []).map((inputPath, index) => ({
        id: `busy-${index}`,
        inputPath,
        fileName: path.basename(inputPath),
        status: 'failed' as const,
        error: 'Another conversion is already in progress',
      }));
      busy.total = busy.items.length;
      mainWindow?.webContents.send('conversion-queue-updated', busy);
      return busy;
    }

    const inputPaths = Array.isArray(payload?.inputPaths)
      ? payload.inputPaths.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : [];
    if (inputPaths.length === 0) {
      const empty = createEmptyQueueSnapshot();
      mainWindow?.webContents.send('conversion-queue-updated', empty);
      return empty;
    }

    const preset = getPresetById(payload.presetId);
    if (!preset) {
      const invalid = createEmptyQueueSnapshot();
      invalid.presetId = payload.presetId;
      invalid.total = inputPaths.length;
      invalid.items = inputPaths.map((inputPath, index) => ({
        id: `invalid-${index}`,
        inputPath,
        fileName: path.basename(inputPath),
        status: 'failed' as const,
        error: 'Invalid preset selected',
      }));
      mainWindow?.webContents.send('conversion-queue-updated', invalid);
      return invalid;
    }

    const codec = getPresetGpuCodec(preset, {
      advancedFormatSettings: settings.advancedFormatSettings,
    });

    isConversionActive = true;
    queueCancelled = false;
    setQueueProgressScope(null);
    conversionActivityStarted(getOsIntegrationSettings());
    try {
      const snapshot = await runConversionQueue(
        {
          inputPaths,
          presetId: payload.presetId,
          gpu: normalizeGpuVendor(payload.gpu),
          removeSpacesFromFilenames: payload.removeSpacesFromFilenames,
          outputDirectory: payload.outputDirectory,
          showDebugOutput: payload.showDebugOutput,
        },
        {
          onSnapshot: (next) => {
            latestQueueSnapshot = next;
            mainWindow?.webContents.send('conversion-queue-updated', next);
          },
          onProgressScope: (fileIndex, fileCount) => {
            setQueueProgressScope({ fileIndex, fileCount });
          },
          onProgress: (progress) => {
            updateTaskbarProgress(progress, () => mainWindow);
            mainWindow?.webContents.send('conversion-progress', progress);
          },
          onLog: (message) => {
            mainWindow?.webContents.send('conversion-log', redactPaths(message));
          },
          convertOne: async ({ inputPath, presetId, gpu, options }) =>
            performSingleConversion(inputPath, presetId, gpu, {
              ...options,
              emitCompleteEvent: false,
            }),
          shouldRetryWithCpu,
          hasVideoCodec: codec !== null,
          isCancelled: () => queueCancelled,
        }
      );
      latestQueueSnapshot = snapshot;
      const summary = summarizeQueueForNotification(snapshot);
      await maybeNotifyConversionComplete(summary, getOsIntegrationSettings(), () => mainWindow, {
        revealOutputPath: resolveRevealOutputPath(snapshot),
      });
      return snapshot;
    } finally {
      isConversionActive = false;
      queueCancelled = false;
      conversionActivityEnded(() => mainWindow);
    }
  }
);

ipcMain.handle('get-file-info', async (event: IpcMainInvokeEvent, filePath: string) => {
  assertTrustedIpcSender(event);
  const resolvedFilePath = resolveExistingFilePath(filePath);
  if (!resolvedFilePath) {
    return null;
  }
  try {
    const info = await getVideoInfo(resolvedFilePath);
    const stats = fs.statSync(resolvedFilePath);
    return {
      ...info,
      size: stats.size,
    };
  } catch {
    return null;
  }
});

ipcMain.handle('get-presets', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return mapPresetsForRenderer(presets);
});

ipcMain.handle(
  'get-gpu-capabilities',
  async (event: IpcMainInvokeEvent, requestedCodec?: GPUCodec | null) => {
    assertTrustedIpcSender(event);
    const normalizedRequestedCodec: GPUCodec | null =
      requestedCodec === 'h264' || requestedCodec === 'h265' || requestedCodec === 'av1'
        ? requestedCodec
        : null;
    return buildGpuCapabilitiesPayload(normalizedRequestedCodec);
  }
);

ipcMain.handle('get-settings', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return settings;
});

ipcMain.handle('get-default-advanced-format-settings', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return createDefaultAdvancedFormatSettings();
});

ipcMain.handle('save-settings', (event: IpcMainInvokeEvent, newSettings: SaveSettingsPayload) => {
  assertTrustedIpcSender(event);
  const safeIncomingSettings =
    newSettings && typeof newSettings === 'object' ? newSettings : ({} as SaveSettingsPayload);

  // Warn on unknown fields so renderer bugs surface fast in logs
  for (const key of Object.keys(safeIncomingSettings)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      console.warn(`save-settings: unexpected field "${key}" – ignored`);
    }
  }
  const incomingSettings = safeIncomingSettings as Partial<Record<keyof AppSettings, unknown>>;
  const nextUpdateChannel =
    safeIncomingSettings.updateChannel !== undefined
      ? normalizeUpdateChannel(safeIncomingSettings.updateChannel)
      : settings.updateChannel;
  const nextAdvancedFormatSettings =
    incomingSettings.advancedFormatSettings === undefined
      ? settings.advancedFormatSettings
      : mergeAdvancedFormatSettings(
          settings.advancedFormatSettings,
          incomingSettings.advancedFormatSettings
        );
  const nextUiPanels =
    incomingSettings.uiPanels === undefined
      ? settings.uiPanels
      : normalizeUiPanels({
          ...settings.uiPanels,
          ...(incomingSettings.uiPanels && typeof incomingSettings.uiPanels === 'object'
            ? (incomingSettings.uiPanels as Partial<UIPanelSettings>)
            : {}),
        });
  const nextGpuMode =
    safeIncomingSettings.gpuMode !== undefined
      ? normalizeGpuMode(safeIncomingSettings.gpuMode)
      : safeIncomingSettings.gpu !== undefined
        ? 'manual'
        : settings.gpuMode;
  const nextGpuManualVendor =
    safeIncomingSettings.gpuManualVendor !== undefined || safeIncomingSettings.gpu !== undefined
      ? normalizeGpuVendor(safeIncomingSettings.gpuManualVendor ?? safeIncomingSettings.gpu)
      : settings.gpuManualVendor;

  settings = normalizeSettings({
    ...settings,
    ...safeIncomingSettings,
    updateChannel: nextUpdateChannel,
    gpuMode: nextGpuMode,
    gpuManualVendor: nextGpuManualVendor,
    gpu: nextGpuManualVendor,
    uiPanels: nextUiPanels,
    advancedFormatSettings: nextAdvancedFormatSettings,
  });
  saveSettings();
  if (safeIncomingSettings.updateChannel !== undefined) {
    setUpdateChannel(nextUpdateChannel);
  }
  if (safeIncomingSettings.useSystemFFmpeg !== undefined) {
    setUseSystemFFmpeg(settings.useSystemFFmpeg);
    clearFFmpegCaches();
  }
  if (safeIncomingSettings.theme !== undefined || safeIncomingSettings.customTheme !== undefined) {
    syncNativeThemeSource();
  }
  if (safeIncomingSettings.interfaceStyle !== undefined) {
    syncNativeThemeSource();
  }
  if (safeIncomingSettings.updateChannel !== undefined) {
    installWindowsJumpList(getJumpListDeps());
  }
  if (safeIncomingSettings.autoCheckUpdates !== undefined) {
    installWindowsJumpList(getJumpListDeps());
  }
});

ipcMain.handle('check-for-updates', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  checkForUpdates();
});

ipcMain.handle('install-update', async (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  await installDownloadedUpdate();
});

ipcMain.handle('is-updates-disabled', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return isUpdateDisabled();
});

ipcMain.handle('check-ffmpeg', async (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return checkFFmpegInstalled();
});

ipcMain.handle('get-version', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return app.getVersion();
});

ipcMain.handle('get-platform', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return process.platform;
});

ipcMain.handle('open-path', async (event: IpcMainInvokeEvent, filePath: string) => {
  assertTrustedIpcSender(event);
  const resolvedPath = resolveAbsolutePath(filePath);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return;
  }
  shell.showItemInFolder(resolvedPath);
});

ipcMain.handle('open-external', async (event: IpcMainInvokeEvent, url: string) => {
  assertTrustedIpcSender(event);
  if (!url) {
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return;
    }
    await shell.openExternal(parsed.toString());
  } catch {
    return;
  }
});

ipcMain.handle('get-system-theme', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

ipcMain.handle('reset-settings', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  settings = createDefaultSettings();
  setUpdateChannel(settings.updateChannel);
  setUseSystemFFmpeg(settings.useSystemFFmpeg);
  clearFFmpegCaches();
  saveSettings();
  syncNativeThemeSource();
  return settings;
});

ipcMain.handle('restart-app', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('get-licenses', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  const licensePath = getLicensesFilePath();
  if (!licensePath) {
    return null;
  }

  try {
    const data = fs.readFileSync(licensePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Failed to read licenses.json:', err);
    return null;
  }
});
