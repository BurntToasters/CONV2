import { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { presets, getPresetById, GPUVendor } from './presets';
import {
  convertVideo,
  cancelConversion,
  checkFFmpegInstalled,
  getVideoInfo,
  checkGPUEncoderSupport,
  parseGPUError,
} from './ffmpeg';
import { initUpdater, checkForUpdates, checkForUpdatesSilent, isUpdateDisabled } from './updater';

if (process.platform === 'darwin') {
  const commonPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
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
}

const defaultSettings: AppSettings = {
  outputDirectory: '',
  gpu: 'cpu',
  theme: 'system',
  showDebugOutput: false,
  autoCheckUpdates: true,
};

let mainWindow: BrowserWindow | null = null;
let settings: AppSettings = { ...defaultSettings };

const getSettingsPath = (): string => {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'settings.json');
};

const loadSettings = (): void => {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      settings = { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch {
    settings = { ...defaultSettings };
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

    // Auto-check for updates if enabled and app is packaged
    if (app.isPackaged && settings.autoCheckUpdates) {
      setTimeout(() => {
        checkForUpdatesSilent();
      }, 3000);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', (e) => {
    if (isConversionActive) {
      e.preventDefault();
      dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Conversion in Progress',
        message: 'A conversion is currently running. Are you sure you want to quit?',
        buttons: ['Cancel', 'Quit Anyway'],
        defaultId: 0,
        cancelId: 0,
      }).then((result) => {
        if (result.response === 1) {
          cancelConversion();
          isConversionActive = false;
          mainWindow?.destroy();
        }
      });
    }
  });

  initUpdater(mainWindow);

  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
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
    properties: ['openFile'],
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg', '3gp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-output-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('start-conversion', async (_, inputPath: string, presetId: string, gpuOverride?: GPUVendor) => {
  const preset = getPresetById(presetId);
  if (!preset) {
    mainWindow?.webContents.send('conversion-complete', {
      success: false,
      outputPath: '',
      error: 'Invalid preset selected',
    });
    return;
  }

  const gpu = gpuOverride ?? settings.gpu;
  const codecCategory = preset.category;
  const isVideoPreset = ['av1', 'h264', 'h265'].includes(codecCategory);

  if (isVideoPreset && gpu !== 'cpu') {
    const codec = codecCategory as 'av1' | 'h264' | 'h265';
    const encoderCheck = await checkGPUEncoderSupport(gpu, codec);
    if (!encoderCheck.available && encoderCheck.error) {
      mainWindow?.webContents.send('gpu-encoder-error', encoderCheck.error);
      return;
    }
  }

  const outputDir = settings.outputDirectory || path.dirname(inputPath);
  isConversionActive = true;

  const result = await convertVideo(
    inputPath,
    outputDir,
    preset,
    gpu,
    (progress) => {
      mainWindow?.webContents.send('conversion-progress', progress);
    },
    settings.showDebugOutput ? (message) => {
      mainWindow?.webContents.send('conversion-log', message);
    } : undefined
  );

  isConversionActive = false;
  lastOutputPath = result.outputPath;

  if (!result.success && result.error && gpu !== 'cpu' && isVideoPreset) {
    const codec = codecCategory as 'av1' | 'h264' | 'h265';
    const gpuError = parseGPUError(result.error, gpu, codec);
    if (gpuError) {
      mainWindow?.webContents.send('gpu-encoder-error', gpuError);
      return;
    }
  }

  mainWindow?.webContents.send('conversion-complete', result);
});

ipcMain.handle('cancel-conversion', () => {
  cancelConversion();
  isConversionActive = false;
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
  settings = { ...settings, ...newSettings };
  saveSettings();
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

ipcMain.handle('open-path', async (_, filePath: string) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('open-external', async (_, url: string) => {
  if (url) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('get-system-theme', () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

ipcMain.handle('reset-settings', () => {
  settings = { ...defaultSettings };
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
