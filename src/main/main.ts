import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  shell,
  Menu,
  IpcMainInvokeEvent,
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
  cancelConversion,
  checkFFmpegInstalled,
  getVideoInfo,
  GPU_ENCODERS,
  checkGPUEncoderSupport,
  parseGPUError,
  ConversionResult,
  waitForConversionStop,
} from './ffmpeg';
import {
  initUpdater,
  checkForUpdates,
  checkForUpdatesSilent,
  isUpdateDisabled,
  setUpdateChannel,
  setUpdaterWindow,
} from './updater';
import { setUseSystemFFmpeg } from './ffmpegPath';
import { clearFFmpegCaches } from './ffmpeg';
import {
  SETTINGS_SCHEMA_VERSION,
  normalizeRecentPresetIds,
  shouldHardResetSettings,
} from './settingsSchema';
import { recommendGpuVendorFromAvailability } from './gpuRecommendation';
import { mapPresetsForRenderer } from './presetProjection';

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
  const newPath = commonPaths.reduce((acc, p) => {
    if (!acc.includes(p)) {
      return `${acc}:${p}`;
    }
    return acc;
  }, currentPath);

  process.env.PATH = newPath;
}

let isConversionActive = false;
let lastOutputPath = '';
let trustedRendererUrl: string | null = null;

type GPUMode = 'auto' | 'manual';

interface AppSettings {
  settingsSchemaVersion: number;
  outputDirectory: string;
  gpu: GPUVendor;
  gpuMode: GPUMode;
  gpuManualVendor: GPUVendor;
  theme: 'system' | 'dark' | 'light';
  showDebugOutput: boolean;
  autoCheckUpdates: boolean;
  useSystemFFmpeg: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  showAdvancedPresets: boolean;
  removeSpacesFromFilenames: boolean;
  recentPresetIds: string[];
  advancedFormatSettings: AdvancedFormatSettings;
}

const createDefaultSettings = (): AppSettings => ({
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  outputDirectory: '',
  gpu: 'cpu',
  gpuMode: 'auto',
  gpuManualVendor: 'cpu',
  theme: 'system',
  showDebugOutput: false,
  autoCheckUpdates: true,
  useSystemFFmpeg: false,
  updateChannel: 'auto',
  showAdvancedPresets: false,
  removeSpacesFromFilenames: false,
  recentPresetIds: [],
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

const normalizeTheme = (value: unknown): AppSettings['theme'] => {
  return value === 'dark' || value === 'light' || value === 'system' ? value : 'system';
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
    showDebugOutput: incoming.showDebugOutput === true,
    autoCheckUpdates: incoming.autoCheckUpdates !== false,
    useSystemFFmpeg: incoming.useSystemFFmpeg === true,
    updateChannel: normalizeUpdateChannel(incoming.updateChannel ?? defaults.updateChannel),
    showAdvancedPresets: incoming.showAdvancedPresets === true,
    removeSpacesFromFilenames: incoming.removeSpacesFromFilenames === true,
    recentPresetIds: normalizeRecentPresetIds(incoming.recentPresetIds),
    advancedFormatSettings: normalizeAdvancedFormatSettings(incoming.advancedFormatSettings),
  };
};

const normalizeFileUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') {
      return null;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
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
    const row = {} as Record<GPUVendor, GPUCapabilityStatus>;
    for (const vendor of GPU_VENDORS) {
      if (vendor === 'cpu') {
        row[vendor] = {
          available: true,
          reason: 'Software encoding fallback.',
          encoder: GPU_ENCODERS[codec].cpu,
        };
        continue;
      }

      if (vendor === 'apple' && process.platform !== 'darwin') {
        row[vendor] = {
          available: false,
          reason: 'Apple VideoToolbox available only on macOS.',
          encoder: GPU_ENCODERS[codec].apple,
        };
        continue;
      }

      if (vendor === 'apple' && codec === 'av1') {
        row[vendor] = {
          available: false,
          reason: 'Apple AV1 hardware encode unavailable. Use CPU for AV1.',
          encoder: GPU_ENCODERS[codec].apple,
        };
        continue;
      }

      const check = await checkGPUEncoderSupport(vendor, codec);
      row[vendor] = {
        available: check.available,
        reason: check.available ? 'Available' : check.error?.message || 'Unavailable',
        encoder: check.encoder || GPU_ENCODERS[codec][vendor],
      };
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

  const senderUrl = normalizeFileUrl(event.senderFrame?.url || '');
  const expectedUrl = trustedRendererUrl;
  return senderUrl !== null && expectedUrl !== null && senderUrl === expectedUrl;
};

const assertTrustedIpcSender = (event: IpcMainInvokeEvent): void => {
  if (!isTrustedIpcSender(event)) {
    throw new Error('Untrusted IPC sender');
  }
};

let mainWindow: BrowserWindow | null = null;
let settings: AppSettings = createDefaultSettings();

const getSettingsPath = (): string => {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
};

const loadSettings = (): void => {
  let shouldPersist = false;
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (shouldHardResetSettings(parsed)) {
        settings = createDefaultSettings();
        shouldPersist = true;
      } else {
        settings = normalizeSettings(parsed);
      }
    } else {
      settings = createDefaultSettings();
    }
  } catch {
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
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err);
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
  Menu.setApplicationMenu(null);
  const rendererEntryPath = path.join(__dirname, '../renderer/index.html');
  trustedRendererUrl = normalizeFileUrl(pathToFileURL(rendererEntryPath).toString());

  mainWindow = new BrowserWindow({
    width: 900,
    height: 780,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
    show: false,
  });

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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();

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
    if (isConversionActive) {
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
            cancelConversion(true);
            await waitForConversionStop(3000);
            isConversionActive = false;
            mainWindow?.destroy();
          }
        });
    }
  });

  initUpdater(mainWindow);

  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send(
      'theme-changed',
      nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );
  });
};

app.whenReady().then(() => {
  loadSettings();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('select-file', async (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Video Files',
        extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg', '3gp'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('select-output-directory', async (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

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
    const resolvedInputPath = resolveExistingFilePath(inputPath);
    if (!resolvedInputPath) {
      const invalidInputResult: ConversionResult = {
        success: false,
        outputPath: '',
        error: 'Invalid input file path',
      };
      mainWindow?.webContents.send('conversion-complete', invalidInputResult);
      return invalidInputResult;
    }

    const suppressGpuErrorEvent = options?.suppressGpuErrorEvent === true;
    const showDebugOutput = options?.showDebugOutput ?? settings.showDebugOutput;
    if (isConversionActive) {
      const busyResult: ConversionResult = {
        success: false,
        outputPath: '',
        error: 'Another conversion is already in progress',
      };
      mainWindow?.webContents.send('conversion-complete', busyResult);
      return busyResult;
    }

    const preset = getPresetById(presetId);
    if (!preset) {
      const invalidPresetResult: ConversionResult = {
        success: false,
        outputPath: '',
        error: 'Invalid preset selected',
      };
      mainWindow?.webContents.send('conversion-complete', invalidPresetResult);
      return invalidPresetResult;
    }

    const requestedGpu =
      gpuOverride === undefined ? settings.gpuManualVendor : normalizeGpuVendor(gpuOverride);
    const codec = getPresetGpuCodec(preset, {
      advancedFormatSettings: settings.advancedFormatSettings,
    });
    const effectiveGpu = requestedGpu === 'apple' && codec === 'av1' ? 'cpu' : requestedGpu;

    if (codec !== null && effectiveGpu !== 'cpu') {
      const encoderCheck = await checkGPUEncoderSupport(effectiveGpu, codec);
      if (!encoderCheck.available && encoderCheck.error) {
        if (!suppressGpuErrorEvent) {
          mainWindow?.webContents.send('gpu-encoder-error', encoderCheck.error);
        }
        const unsupportedEncoderResult: ConversionResult = {
          success: false,
          outputPath: '',
          error: encoderCheck.error.message,
          retryWithCpuSuggested: encoderCheck.error.canRetryWithCPU,
        };
        mainWindow?.webContents.send('conversion-complete', unsupportedEncoderResult);
        return unsupportedEncoderResult;
      }
    }

    const requestedOutputDir =
      resolveExistingDirectoryPath(options?.outputDirectory) ??
      resolveExistingDirectoryPath(settings.outputDirectory) ??
      path.dirname(resolvedInputPath);
    const outputDir = requestedOutputDir;
    isConversionActive = true;

    let result: ConversionResult;
    try {
      result = await convertVideo(
        resolvedInputPath,
        outputDir,
        preset,
        effectiveGpu,
        (progress) => {
          mainWindow?.webContents.send('conversion-progress', progress);
        },
        showDebugOutput
          ? (message) => {
              mainWindow?.webContents.send('conversion-log', message);
            }
          : undefined,
        {
          removeSpacesFromOutputName:
            options?.removeSpacesFromFilenames ?? settings.removeSpacesFromFilenames,
          advancedFormatSettings: settings.advancedFormatSettings,
        }
      );
    } catch (err) {
      result = {
        success: false,
        outputPath: '',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      isConversionActive = false;
    }

    lastOutputPath = result.outputPath;

    if (!result.success && result.error && effectiveGpu !== 'cpu' && codec !== null) {
      const gpuError = parseGPUError(result.error, effectiveGpu, codec);
      if (gpuError) {
        result.retryWithCpuSuggested = gpuError.canRetryWithCPU;
        if (!suppressGpuErrorEvent) {
          mainWindow?.webContents.send('gpu-encoder-error', gpuError);
        }
      }
    }

    mainWindow?.webContents.send('conversion-complete', result);
    return result;
  }
);

ipcMain.handle('cancel-conversion', (event: IpcMainInvokeEvent, force?: boolean) => {
  assertTrustedIpcSender(event);
  cancelConversion(!!force);
});

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

ipcMain.handle('save-settings', (event: IpcMainInvokeEvent, newSettings: Partial<AppSettings>) => {
  assertTrustedIpcSender(event);
  const safeIncomingSettings =
    newSettings && typeof newSettings === 'object' ? newSettings : ({} as Partial<AppSettings>);
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
});

ipcMain.handle('check-for-updates', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  checkForUpdates();
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
