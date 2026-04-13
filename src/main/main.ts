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
import { presets, getPresetById, GPUVendor } from './presets';
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
  checkGPUEncoderSupport,
  parseGPUError,
  ConversionResult,
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

interface AppSettings {
  outputDirectory: string;
  gpu: GPUVendor;
  theme: 'system' | 'dark' | 'light';
  showDebugOutput: boolean;
  autoCheckUpdates: boolean;
  useSystemFFmpeg: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  showAdvancedPresets: boolean;
  removeSpacesFromFilenames: boolean;
  advancedFormatSettings: AdvancedFormatSettings;
}

const createDefaultSettings = (): AppSettings => ({
  outputDirectory: '',
  gpu: 'cpu',
  theme: 'system',
  showDebugOutput: false,
  autoCheckUpdates: true,
  useSystemFFmpeg: false,
  updateChannel: 'auto',
  showAdvancedPresets: false,
  removeSpacesFromFilenames: false,
  advancedFormatSettings: createDefaultAdvancedFormatSettings(),
});

const normalizeUpdateChannel = (value: unknown): AppSettings['updateChannel'] => {
  return value === 'stable' || value === 'beta' || value === 'auto' ? value : 'auto';
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

  return {
    outputDirectory:
      typeof incoming.outputDirectory === 'string'
        ? incoming.outputDirectory
        : defaults.outputDirectory,
    gpu: normalizeGpuVendor(incoming.gpu ?? defaults.gpu),
    theme: normalizeTheme(incoming.theme ?? defaults.theme),
    showDebugOutput: incoming.showDebugOutput === true,
    autoCheckUpdates: incoming.autoCheckUpdates !== false,
    useSystemFFmpeg: incoming.useSystemFFmpeg === true,
    updateChannel: normalizeUpdateChannel(incoming.updateChannel ?? defaults.updateChannel),
    showAdvancedPresets: incoming.showAdvancedPresets === true,
    removeSpacesFromFilenames: incoming.removeSpacesFromFilenames === true,
    advancedFormatSettings: normalizeAdvancedFormatSettings(incoming.advancedFormatSettings),
  };
};

const isTrustedIpcSender = (event: IpcMainInvokeEvent): boolean => {
  const senderUrl = event.senderFrame?.url || '';
  return senderUrl.startsWith('file://');
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
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      settings = normalizeSettings(JSON.parse(data));
    }
  } catch {
    settings = createDefaultSettings();
  }
  setUpdateChannel(settings.updateChannel);
  setUseSystemFFmpeg(settings.useSystemFFmpeg);
  clearFFmpegCaches();
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
  const candidates = [
    path.join(appPath, 'licenses.json'),
    path.join(process.cwd(), 'licenses.json'),
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

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

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
        .then((result) => {
          if (result.response === 1) {
            cancelConversion(true);
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

ipcMain.handle('select-file', async () => {
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

ipcMain.handle('select-output-directory', async () => {
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

    const gpu = gpuOverride ?? settings.gpu;
    const codecCategory = preset.category;
    const isVideoPreset = ['av1', 'h264', 'h265'].includes(codecCategory);

    if (isVideoPreset && gpu !== 'cpu') {
      const codec = codecCategory as 'av1' | 'h264' | 'h265';
      const encoderCheck = await checkGPUEncoderSupport(gpu, codec);
      if (!encoderCheck.available && encoderCheck.error) {
        if (!suppressGpuErrorEvent) {
          mainWindow?.webContents.send('gpu-encoder-error', encoderCheck.error);
        }
        const unsupportedEncoderResult: ConversionResult = {
          success: false,
          outputPath: '',
          error: encoderCheck.error.message,
        };
        mainWindow?.webContents.send('conversion-complete', unsupportedEncoderResult);
        return unsupportedEncoderResult;
      }
    }

    const requestedOutputDir =
      typeof options?.outputDirectory === 'string' ? options.outputDirectory.trim() : '';
    const configuredOutputDir =
      requestedOutputDir ||
      (typeof settings.outputDirectory === 'string' ? settings.outputDirectory : '');
    const outputDir = path.isAbsolute(configuredOutputDir)
      ? configuredOutputDir
      : path.dirname(inputPath);
    isConversionActive = true;

    let result: ConversionResult;
    try {
      result = await convertVideo(
        inputPath,
        outputDir,
        preset,
        gpu,
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

    if (!result.success && result.error && gpu !== 'cpu' && isVideoPreset) {
      const codec = codecCategory as 'av1' | 'h264' | 'h265';
      const gpuError = parseGPUError(result.error, gpu, codec);
      if (gpuError) {
        if (!suppressGpuErrorEvent) {
          mainWindow?.webContents.send('gpu-encoder-error', gpuError);
        }
      }
    }

    mainWindow?.webContents.send('conversion-complete', result);
    return result;
  }
);

ipcMain.handle('cancel-conversion', (_, force?: boolean) => {
  cancelConversion(!!force);
});

ipcMain.handle('get-file-info', async (_, filePath: string) => {
  try {
    const info = await getVideoInfo(filePath);
    const stats = fs.statSync(filePath);
    return {
      ...info,
      size: stats.size,
    };
  } catch {
    return null;
  }
});

ipcMain.handle('get-presets', () => {
  return presets.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
  }));
});

ipcMain.handle('get-settings', () => {
  return settings;
});

ipcMain.handle('save-settings', (_, newSettings: Partial<AppSettings>) => {
  const incomingSettings = newSettings as Partial<Record<keyof AppSettings, unknown>>;
  const nextUpdateChannel =
    newSettings.updateChannel !== undefined
      ? normalizeUpdateChannel(newSettings.updateChannel)
      : settings.updateChannel;
  const nextAdvancedFormatSettings =
    incomingSettings.advancedFormatSettings === undefined
      ? settings.advancedFormatSettings
      : mergeAdvancedFormatSettings(
          settings.advancedFormatSettings,
          incomingSettings.advancedFormatSettings
        );

  settings = normalizeSettings({
    ...settings,
    ...newSettings,
    updateChannel: nextUpdateChannel,
    advancedFormatSettings: nextAdvancedFormatSettings,
  });
  saveSettings();
  if (newSettings.updateChannel !== undefined) {
    setUpdateChannel(nextUpdateChannel);
  }
  if (newSettings.useSystemFFmpeg !== undefined) {
    setUseSystemFFmpeg(settings.useSystemFFmpeg);
    clearFFmpegCaches();
  }
});

ipcMain.handle('check-for-updates', () => {
  checkForUpdates();
});

ipcMain.handle('is-updates-disabled', () => {
  return isUpdateDisabled();
});

ipcMain.handle('check-ffmpeg', async () => {
  return checkFFmpegInstalled();
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('open-path', async (event: IpcMainInvokeEvent, filePath: string) => {
  assertTrustedIpcSender(event);
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return;
  }
  if (!path.isAbsolute(filePath)) {
    return;
  }
  const resolvedPath = path.resolve(filePath);
  shell.showItemInFolder(resolvedPath);
});

ipcMain.handle('open-external', async (event: IpcMainInvokeEvent, url: string) => {
  assertTrustedIpcSender(event);
  if (!url) {
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return;
    }
    await shell.openExternal(parsed.toString());
  } catch {
    return;
  }
});

ipcMain.handle('get-system-theme', () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

ipcMain.handle('reset-settings', () => {
  settings = createDefaultSettings();
  setUpdateChannel(settings.updateChannel);
  setUseSystemFFmpeg(settings.useSystemFFmpeg);
  clearFFmpegCaches();
  saveSettings();
  return settings;
});

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('get-licenses', () => {
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
