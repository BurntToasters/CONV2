import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, dialog } from 'electron';
import { execFileSync } from 'child_process';

type UpdateChannel = 'auto' | 'stable' | 'beta';

let mainWindow: BrowserWindow | null = null;
let updatesDisabled = false;
let updateAvailable = false;
let silentCheck = false;
let updateChannel: UpdateChannel = 'auto';
let listenersRegistered = false;

const isPrereleaseVersion = (version: string): boolean => {
  return /-(beta|alpha|rc)/i.test(version);
};

const getBaseVersion = (version: string): number[] => {
  return version
    .replace(/-(beta|alpha|rc).*/i, '')
    .split('.')
    .map(Number)
    .slice(0, 3);
};

const isNewerBaseVersion = (offered: string, current: string): boolean => {
  const o = getBaseVersion(offered);
  const c = getBaseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((o[i] || 0) > (c[i] || 0)) return true;
    if ((o[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
};

const shouldUseBetaChannel = (): boolean => {
  if (updateChannel === 'beta') {
    return true;
  }
  if (updateChannel === 'stable') {
    return false;
  }
  return isPrereleaseVersion(app.getVersion());
};

const applyUpdaterChannel = (): void => {
  const useBetaChannel = shouldUseBetaChannel();
  autoUpdater.channel = useBetaChannel ? 'beta' : 'latest';
  autoUpdater.allowPrerelease = useBetaChannel;
};

const checkMsiInstallation = (): boolean => {
  if (process.platform !== 'win32') {
    return false;
  }

  const registryKeys = ['HKLM\\Software\\CONV2', 'HKCU\\Software\\CONV2'];

  for (const key of registryKeys) {
    try {
      const result = execFileSync('reg', ['query', key], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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

const getMainWindow = (): BrowserWindow | null => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }
  return mainWindow;
};

export const setUpdaterWindow = (window: BrowserWindow | null): void => {
  mainWindow = window;
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
  applyUpdaterChannel();

  if (listenersRegistered) {
    return;
  }

  autoUpdater.on('checking-for-update', () => {
    sendStatusToWindow('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (
      shouldUseBetaChannel() &&
      !isPrereleaseVersion(info.version) &&
      !isNewerBaseVersion(info.version, app.getVersion())
    ) {
      const windowRef = getMainWindow();
      if (windowRef) {
        windowRef.webContents.send('update-available', false);
      }
      silentCheck = false;
      return;
    }

    updateAvailable = true;
    const windowRef = getMainWindow();
    if (windowRef) {
      windowRef.webContents.send('update-available', true);
    }

    if (!silentCheck && windowRef) {
      dialog
        .showMessageBox(windowRef, {
          type: 'info',
          title: 'Update Available',
          message: `A new version (${info.version}) is available. Would you like to download it now?`,
          buttons: ['Download', 'Later'],
          defaultId: 0,
        })
        .then((result) => {
          if (result.response === 0) {
            autoUpdater.downloadUpdate();
            sendStatusToWindow('Downloading update...');
          }
        });
    }
    silentCheck = false;
  });

  autoUpdater.on('update-not-available', () => {
    const windowRef = getMainWindow();
    if (windowRef) {
      windowRef.webContents.send('update-available', false);
    }

    if (!silentCheck && windowRef) {
      sendStatusToWindow('You have the latest version.');
      dialog.showMessageBox(windowRef, {
        type: 'info',
        title: 'No Updates',
        message: 'You are already running the latest version of CONV2.',
        buttons: ['OK'],
      });
    }
    silentCheck = false;
  });

  autoUpdater.on('error', (err) => {
    const wasSilent = silentCheck;
    silentCheck = false;
    sendStatusToWindow(`Update error: ${err.message}`);
    const windowRef = getMainWindow();
    if (!wasSilent && windowRef) {
      dialog.showMessageBox(windowRef, {
        type: 'error',
        title: 'Update Error',
        message: `An error occurred while checking for updates: ${err.message}`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const message = `Download speed: ${formatBytes(progressObj.bytesPerSecond)}/s - ${Math.round(progressObj.percent)}% (${formatBytes(progressObj.transferred)}/${formatBytes(progressObj.total)})`;
    sendStatusToWindow(message);

    const windowRef = getMainWindow();
    if (windowRef) {
      windowRef.webContents.send('update-download-progress', progressObj.percent);
    }
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    const windowRef = getMainWindow();
    if (!windowRef) {
      return;
    }
    dialog
      .showMessageBox(windowRef, {
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded. The application will restart to install the update.`,
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  listenersRegistered = true;
};

export const checkForUpdates = (): void => {
  if (updatesDisabled) {
    const windowRef = getMainWindow();
    if (windowRef) {
      dialog.showMessageBox(windowRef, {
        type: 'info',
        title: 'Updates Disabled',
        message:
          'Auto-updates are disabled for this installation.\n\nThis is an enterprise/MSI deployment. Please contact your IT administrator for updates.',
        buttons: ['OK'],
      });
    }
    return;
  }

  silentCheck = false;
  applyUpdaterChannel();
  void autoUpdater.checkForUpdates().catch((err) => {
    console.error('Failed to check for updates:', err);
  });
};

export const isUpdateDisabled = (): boolean => {
  return updatesDisabled;
};

export const checkForUpdatesSilent = (): void => {
  if (updatesDisabled) {
    return;
  }

  applyUpdaterChannel();
  silentCheck = true;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Silent update check failed:', err);
    silentCheck = false;
  });
};

export const setUpdateChannel = (channel: UpdateChannel): void => {
  updateChannel = channel;
  if (!updatesDisabled) {
    applyUpdaterChannel();
  }
};

const sendStatusToWindow = (message: string): void => {
  const windowRef = getMainWindow();
  if (windowRef) {
    windowRef.webContents.send('update-status', message);
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
