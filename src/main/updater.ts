import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, dialog } from 'electron';
import { execFileSync } from 'child_process';
import * as path from 'path';

type UpdateChannel = 'auto' | 'stable' | 'beta';
type UpdateCheckMode = 'manual' | 'silent';
type UpdateStatePhase =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'disabled'
  | 'already-checking';

interface UpdateStatePayload {
  phase: UpdateStatePhase;
  manual: boolean;
  message?: string;
  percent?: number;
}

let mainWindow: BrowserWindow | null = null;
let updatesDisabled = false;
let updateChannel: UpdateChannel = 'auto';
let listenersRegistered = false;
let updateCheckInFlight = false;
let activeCheckMode: UpdateCheckMode | null = null;

const getWindowsSystemBinaryPath = (binaryName: string): string => {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', binaryName);
};

const WINDOWS_REG_PATH = getWindowsSystemBinaryPath('reg.exe');

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
      const result = execFileSync(WINDOWS_REG_PATH, ['query', key], {
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

const isManualCheckActive = (): boolean => {
  return activeCheckMode === 'manual';
};

const beginUpdateCheck = (mode: UpdateCheckMode): boolean => {
  if (updateCheckInFlight) {
    return false;
  }
  activeCheckMode = mode;
  updateCheckInFlight = true;
  return true;
};

const endUpdateCheck = (): void => {
  activeCheckMode = null;
  updateCheckInFlight = false;
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

const sendUpdateStateToWindow = (payload: UpdateStatePayload): void => {
  const windowRef = getMainWindow();
  if (windowRef) {
    windowRef.webContents.send('update-state', payload);
  }
};

export const initUpdater = (window: BrowserWindow): void => {
  mainWindow = window;
  updatesDisabled = checkMsiInstallation();

  if (updatesDisabled) {
    console.log('Auto-updates disabled: MSI/Enterprise installation detected');
    sendUpdateStateToWindow({
      phase: 'disabled',
      manual: false,
      message: 'Auto-updates are disabled for this installation.',
    });
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
    sendUpdateStateToWindow({
      phase: 'checking',
      manual: isManualCheckActive(),
      message: 'Checking for updates...',
    });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const manual = isManualCheckActive();
    if (
      shouldUseBetaChannel() &&
      !isPrereleaseVersion(info.version) &&
      !isNewerBaseVersion(info.version, app.getVersion())
    ) {
      const windowRef = getMainWindow();
      if (windowRef) {
        windowRef.webContents.send('update-available', false);
      }
      sendUpdateStateToWindow({
        phase: 'not-available',
        manual,
        message: 'No newer version is available for this channel.',
      });
      endUpdateCheck();
      return;
    }

    const windowRef = getMainWindow();
    if (windowRef) {
      windowRef.webContents.send('update-available', true);
    }
    sendUpdateStateToWindow({
      phase: 'available',
      manual,
      message: `Update available: ${info.version}`,
    });
    endUpdateCheck();

    if (manual && windowRef) {
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
            sendUpdateStateToWindow({
              phase: 'downloading',
              manual: true,
              message: 'Downloading update...',
            });
          }
        });
    }
  });

  autoUpdater.on('update-not-available', () => {
    const manual = isManualCheckActive();
    const windowRef = getMainWindow();
    if (windowRef) {
      windowRef.webContents.send('update-available', false);
    }
    sendUpdateStateToWindow({
      phase: 'not-available',
      manual,
      message: 'You have the latest version.',
    });
    endUpdateCheck();

    if (manual && windowRef) {
      sendStatusToWindow('You have the latest version.');
      dialog.showMessageBox(windowRef, {
        type: 'info',
        title: 'No Updates',
        message: 'You are already running the latest version of CONV2.',
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('error', (err) => {
    const manual = isManualCheckActive();
    endUpdateCheck();
    sendStatusToWindow(`Update error: ${err.message}`);
    sendUpdateStateToWindow({
      phase: 'error',
      manual,
      message: `Update error: ${err.message}`,
    });
    const windowRef = getMainWindow();
    if (manual && windowRef) {
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
    sendUpdateStateToWindow({
      phase: 'downloading',
      manual: false,
      message,
      percent: progressObj.percent,
    });

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
    sendUpdateStateToWindow({
      phase: 'downloaded',
      manual: false,
      message: `Version ${info.version} downloaded.`,
    });
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
    sendUpdateStateToWindow({
      phase: 'disabled',
      manual: true,
      message: 'Auto-updates are disabled for this installation.',
    });
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

  if (!beginUpdateCheck('manual')) {
    sendStatusToWindow('Update check already in progress.');
    sendUpdateStateToWindow({
      phase: 'already-checking',
      manual: true,
      message: 'Update check already in progress.',
    });
    return;
  }

  applyUpdaterChannel();
  sendUpdateStateToWindow({
    phase: 'checking',
    manual: true,
    message: 'Checking for updates...',
  });
  void autoUpdater.checkForUpdates().catch((err) => {
    if (!updateCheckInFlight) {
      return;
    }
    endUpdateCheck();
    console.error('Failed to check for updates:', err);
    sendStatusToWindow(`Update error: ${err.message}`);
    sendUpdateStateToWindow({
      phase: 'error',
      manual: true,
      message: `Update error: ${err.message}`,
    });
  });
};

export const isUpdateDisabled = (): boolean => {
  return updatesDisabled;
};

export const checkForUpdatesSilent = (): void => {
  if (updatesDisabled) {
    return;
  }

  if (!beginUpdateCheck('silent')) {
    return;
  }

  applyUpdaterChannel();
  sendUpdateStateToWindow({
    phase: 'checking',
    manual: false,
    message: 'Checking for updates...',
  });
  autoUpdater.checkForUpdates().catch((err) => {
    if (!updateCheckInFlight) {
      return;
    }
    endUpdateCheck();
    console.error('Silent update check failed:', err);
    sendStatusToWindow(`Update error: ${err.message}`);
    sendUpdateStateToWindow({
      phase: 'error',
      manual: false,
      message: `Update error: ${err.message}`,
    });
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
