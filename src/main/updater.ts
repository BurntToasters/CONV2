import { autoUpdater, UpdateInfo } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';
import { execSync } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let updatesDisabled = false;
let updateAvailable = false;
let silentCheck = false;

const checkMsiInstallation = (): boolean => {
  if (process.platform !== 'win32') {
    return false;
  }

  const registryKeys = [
    'HKLM\\Software\\CONV2',
    'HKCU\\Software\\CONV2',
  ];

  for (const key of registryKeys) {
    try {
      const result = execSync(
        `reg query "${key}"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      if (hasRegistryDwordValue(result, ['InstalledViaMsi', 'DisableAutoUpdates'])) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
};

const hasRegistryDwordValue = (output: string, names: string[]): boolean => {
  const nameSet = new Set(names.map((name) => name.toLowerCase()));
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(\S+)\s+REG_DWORD\s+(\S+)/i);
    if (!match) {
      continue;
    }
    const name = match[1].toLowerCase();
    if (!nameSet.has(name)) {
      continue;
    }
    const rawValue = match[2];
    const value = rawValue.startsWith('0x') ? parseInt(rawValue, 16) : parseInt(rawValue, 10);
    if (value === 1) {
      return true;
    }
  }
  return false;
};

export const initUpdater = (window: BrowserWindow): void => {
  mainWindow = window;
  updatesDisabled = checkMsiInstallation();

  if (updatesDisabled) {
    console.log('Auto-updates disabled: MSI/Enterprise installation detected');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendStatusToWindow('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    updateAvailable = true;
    if (mainWindow) {
      mainWindow.webContents.send('update-available', true);
    }

    if (!silentCheck) {
      dialog.showMessageBox(mainWindow!, {
        type: 'info',
        title: 'Update Available',
        message: `A new version (${info.version}) is available. Would you like to download it now?`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate();
          sendStatusToWindow('Downloading update...');
        }
      });
    }
    silentCheck = false;
  });

  autoUpdater.on('update-not-available', () => {
    if (mainWindow) {
      mainWindow.webContents.send('update-available', false);
    }

    if (!silentCheck) {
      sendStatusToWindow('You have the latest version.');
      dialog.showMessageBox(mainWindow!, {
        type: 'info',
        title: 'No Updates',
        message: 'You are already running the latest version of CONV2.',
        buttons: ['OK'],
      });
    }
    silentCheck = false;
  });

  autoUpdater.on('error', (err) => {
    sendStatusToWindow(`Update error: ${err.message}`);
    dialog.showMessageBox(mainWindow!, {
      type: 'error',
      title: 'Update Error',
      message: `An error occurred while checking for updates: ${err.message}`,
      buttons: ['OK'],
    });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const message = `Download speed: ${formatBytes(progressObj.bytesPerSecond)}/s - ${Math.round(progressObj.percent)}% (${formatBytes(progressObj.transferred)}/${formatBytes(progressObj.total)})`;
    sendStatusToWindow(message);

    if (mainWindow) {
      mainWindow.webContents.send('update-download-progress', progressObj.percent);
    }
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded. The application will restart to install the update.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });
};

export const checkForUpdates = (): void => {
  if (updatesDisabled) {
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Updates Disabled',
        message: 'Auto-updates are disabled for this installation.\n\nThis is an enterprise/MSI deployment. Please contact your IT administrator for updates.',
        buttons: ['OK'],
      });
    }
    return;
  }

  autoUpdater.checkForUpdates();
};

export const isUpdateDisabled = (): boolean => {
  return updatesDisabled;
};

export const checkForUpdatesSilent = (): void => {
  if (updatesDisabled) {
    return;
  }

  silentCheck = true;
  autoUpdater.checkForUpdates().catch(() => {
    silentCheck = false;
  });
};

const sendStatusToWindow = (message: string): void => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', message);
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
