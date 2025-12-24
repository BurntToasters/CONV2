import { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { presets, getPresetById, GPUVendor } from './presets';
import { convertVideo, cancelConversion, checkFFmpegInstalled } from './ffmpeg';
import { initUpdater, checkForUpdates } from './updater';

interface AppSettings {
  outputDirectory: string;
  gpu: GPUVendor;
  theme: 'system' | 'dark' | 'light';
}

const defaultSettings: AppSettings = {
  outputDirectory: '',
  gpu: 'cpu',
  theme: 'system',
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

const createWindow = (): void => {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 900,
    height: 800,
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
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
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

ipcMain.handle('start-conversion', async (_, inputPath: string, presetId: string) => {
  const preset = getPresetById(presetId);
  if (!preset) {
    mainWindow?.webContents.send('conversion-complete', {
      success: false,
      outputPath: '',
      error: 'Invalid preset selected',
    });
    return;
  }

  const outputDir = settings.outputDirectory || path.dirname(inputPath);

  const result = await convertVideo(
    inputPath,
    outputDir,
    preset,
    settings.gpu,
    (progress) => {
      mainWindow?.webContents.send('conversion-progress', progress);
    }
  );

  mainWindow?.webContents.send('conversion-complete', result);
});

ipcMain.handle('cancel-conversion', () => {
  cancelConversion();
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

ipcMain.handle('check-ffmpeg', async () => {
  return checkFFmpegInstalled();
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('open-path', async (_, filePath: string) => {
  shell.showItemInFolder(filePath);
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
