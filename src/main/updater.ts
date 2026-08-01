import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, dialog } from 'electron';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isPrereleaseVersion, shouldAcceptUpdate } from './updaterPolicy';

type UpdateChannel = 'auto' | 'stable' | 'beta';
type UpdateCheckMode = 'manual' | 'silent';
type UpdateStatePhase =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'disabled'
  | 'already-checking';

type UpdateInstallStartingHandler = () => void | Promise<void>;

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
let updateDownloadedReady = false;
let downloadedUpdateVersion: string | null = null;
let updateInstallInProgress = false;
let updateInstallStartingHandler: UpdateInstallStartingHandler | null = null;
/** Version electron-updater currently has available to download, if any. */
let availableUpdateVersion: string | null = null;
/** Bumped on channel change so stale Download dialogs cannot install the wrong feed. */
let updateOfferEpoch = 0;
/** Epoch captured when the current download started; null if idle. */
let activeDownloadEpoch: number | null = null;
/** When beta feed has nothing newer, re-check stable once for a newer release. */
let stableFallbackInProgress = false;
/** Drop UI results from an in-flight check after the channel changes. */
let discardCheckResults = false;
/** Re-run a silent check once the in-flight check finishes after a channel change. */
let channelRecheckQueued = false;

type UpdateMenuStateListener = () => void;
const updateMenuStateListeners = new Set<UpdateMenuStateListener>();

const notifyUpdateMenuStateChange = (): void => {
  for (const listener of updateMenuStateListeners) {
    listener();
  }
};

export const isUpdateReadyToInstall = (): boolean => {
  return updateDownloadedReady && !updateInstallInProgress && !updatesDisabled;
};

export const onUpdateMenuStateChange = (listener: UpdateMenuStateListener): (() => void) => {
  updateMenuStateListeners.add(listener);
  return () => {
    updateMenuStateListeners.delete(listener);
  };
};

const getWindowsSystemBinaryPath = (binaryName: string): string => {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', binaryName);
};

const WINDOWS_REG_PATH = getWindowsSystemBinaryPath('reg.exe');

const isStoreOrManagedBuild = (): boolean => {
  const flags = process as NodeJS.Process & { mas?: boolean; windowsStore?: boolean };
  if (flags.mas === true || flags.windowsStore === true) {
    return true;
  }
  if (process.env.FLATPAK_ID || fs.existsSync('/.flatpak-info')) {
    return true;
  }
  const disableFlag = process.env.CONV2_DISABLE_UPDATES;
  return disableFlag === '1' || disableFlag === 'true';
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

const applyUpdaterChannel = (options?: { forceStable?: boolean }): void => {
  const useBetaChannel = options?.forceStable ? false : shouldUseBetaChannel();
  // Setting channel forces allowDowngrade=true inside electron-updater.
  autoUpdater.channel = useBetaChannel ? 'beta' : 'latest';
  autoUpdater.allowPrerelease = useBetaChannel;
  autoUpdater.allowDowngrade = false;
};

const clearStableFallback = (): void => {
  if (!stableFallbackInProgress) {
    return;
  }
  stableFallbackInProgress = false;
  applyUpdaterChannel();
};

const tryStableFallbackCheck = (): boolean => {
  if (stableFallbackInProgress || !shouldUseBetaChannel()) {
    return false;
  }
  stableFallbackInProgress = true;
  // Defer: electron-updater still holds checkForUpdatesPromise until the
  // current handler stack unwinds; an immediate re-check is a no-op.
  setImmediate(() => {
    if (discardCheckResults) {
      stableFallbackInProgress = false;
      // U1: must end the check or updateCheckInFlight stays wedged.
      endUpdateCheck();
      return;
    }
    if (!stableFallbackInProgress) {
      return;
    }
    applyUpdaterChannel({ forceStable: true });
    if (!updateDownloadedReady) {
      sendUpdateStateToWindow({
        phase: 'checking',
        manual: isManualCheckActive(),
        message: 'Checking for updates...',
      });
    }
    void autoUpdater.checkForUpdates().catch((err) => {
      if (!updateCheckInFlight && !stableFallbackInProgress) {
        return;
      }
      clearStableFallback();
      endUpdateCheck();
      console.error('Stable fallback update check failed:', err);
      emitUpdateError(isManualCheckActive(), `Update error: ${err.message}`);
    });
  });
  return true;
};

const emitUpdateNotAvailable = (manual: boolean): void => {
  availableUpdateVersion = null;
  if (updateDownloadedReady && downloadedUpdateVersion) {
    sendDownloadedUpdateStateToWindow();
    endUpdateCheck();
    if (manual) {
      const windowRef = getMainWindow();
      if (windowRef) {
        const version = downloadedUpdateVersion;
        sendStatusToWindow(`Version ${version} is ready to install.`);
        dialog
          .showMessageBox(windowRef, {
            type: 'info',
            title: 'Update Ready',
            message: `Version ${version} has already been downloaded. Restart now to install it.`,
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
          })
          .then((result) => {
            if (result.response === 0) {
              void installDownloadedUpdate().catch((err) => {
                const error = err instanceof Error ? err : new Error(String(err));
                dialog.showMessageBox(windowRef, {
                  type: 'error',
                  title: 'Update Error',
                  message: `CONV2 could not restart to install the update: ${error.message}`,
                  buttons: ['OK'],
                });
              });
            }
          });
      }
    }
    return;
  }

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
  discardCheckResults = false;
  activeCheckMode = mode;
  updateCheckInFlight = true;
  return true;
};

const endUpdateCheck = (): void => {
  activeCheckMode = null;
  updateCheckInFlight = false;
  if (!channelRecheckQueued) {
    return;
  }
  channelRecheckQueued = false;
  setImmediate(() => {
    checkForUpdatesSilent();
  });
};

const clearDownloadedUpdate = (): void => {
  if (!updateDownloadedReady && !downloadedUpdateVersion) {
    return;
  }
  updateDownloadedReady = false;
  downloadedUpdateVersion = null;
  notifyUpdateMenuStateChange();
};

const startUpdateDownload = (): void => {
  if (!availableUpdateVersion) {
    const message = 'No update is available to download.';
    sendStatusToWindow(message);
    sendUpdateStateToWindow({
      phase: 'error',
      manual: true,
      message,
    });
    if (updateDownloadedReady && downloadedUpdateVersion) {
      sendDownloadedUpdateStateToWindow();
    }
    return;
  }
  void autoUpdater.downloadUpdate().catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    activeDownloadEpoch = null;
    emitUpdateError(true, `Update error: ${error.message}`);
  });
  activeDownloadEpoch = updateOfferEpoch;
  sendStatusToWindow('Downloading update...');
  sendUpdateStateToWindow({
    phase: 'downloading',
    manual: true,
    message: 'Downloading update...',
  });
};

const emitUpdateError = (manual: boolean, message: string): void => {
  sendStatusToWindow(message);
  if (updateDownloadedReady && downloadedUpdateVersion) {
    sendDownloadedUpdateStateToWindow();
    return;
  }
  sendUpdateStateToWindow({
    phase: 'error',
    manual,
    message,
  });
};

const clearStaleAvailableOffer = (): void => {
  availableUpdateVersion = null;
  const windowRef = getMainWindow();
  if (windowRef) {
    windowRef.webContents.send('update-available', false);
  }
  if (updateDownloadedReady && downloadedUpdateVersion) {
    sendDownloadedUpdateStateToWindow();
    return;
  }
  sendUpdateStateToWindow({
    phase: 'not-available',
    manual: false,
    message: 'Update channel changed.',
  });
};

const queueChannelRecheck = (): void => {
  if (updateCheckInFlight) {
    discardCheckResults = true;
    channelRecheckQueued = true;
    return;
  }
  checkForUpdatesSilent();
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

export const setUpdateInstallStartingHandler = (
  handler: UpdateInstallStartingHandler | null
): void => {
  updateInstallStartingHandler = handler;
};

const sendUpdateStateToWindow = (payload: UpdateStatePayload): void => {
  const windowRef = getMainWindow();
  if (windowRef) {
    windowRef.webContents.send('update-state', payload);
  }
};

const sendDownloadedUpdateStateToWindow = (): void => {
  if (!updateDownloadedReady || !downloadedUpdateVersion) return;
  sendUpdateStateToWindow({
    phase: 'downloaded',
    manual: false,
    message: `Version ${downloadedUpdateVersion} downloaded.`,
  });
};

export const initUpdater = (window: BrowserWindow): void => {
  mainWindow = window;
  updatesDisabled = checkMsiInstallation() || isStoreOrManagedBuild();

  if (updatesDisabled) {
    console.log('Auto-updates disabled: MSI/Store/managed installation detected');
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
    window.webContents.once('did-finish-load', sendDownloadedUpdateStateToWindow);
    return;
  }

  autoUpdater.on('checking-for-update', () => {
    if (discardCheckResults) {
      return;
    }
    sendStatusToWindow('Checking for updates...');
    // Keep Restart Now visible while a background re-check runs.
    if (updateDownloadedReady) {
      return;
    }
    sendUpdateStateToWindow({
      phase: 'checking',
      manual: isManualCheckActive(),
      message: 'Checking for updates...',
    });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const manual = isManualCheckActive();
    if (discardCheckResults) {
      clearStableFallback();
      endUpdateCheck();
      return;
    }

    if (!shouldAcceptUpdate(info.version, app.getVersion())) {
      // Older feed version (e.g. stable behind current beta) — try newer stable, else done.
      if (tryStableFallbackCheck()) {
        return;
      }
      clearStableFallback();
      availableUpdateVersion = null;
      const windowRef = getMainWindow();
      if (windowRef) {
        windowRef.webContents.send('update-available', false);
      }
      if (updateDownloadedReady && downloadedUpdateVersion) {
        sendDownloadedUpdateStateToWindow();
      } else {
        sendUpdateStateToWindow({
          phase: 'not-available',
          manual,
          message: 'No newer version is available for this channel.',
        });
      }
      endUpdateCheck();
      return;
    }

    clearStableFallback();

    if (updateDownloadedReady && downloadedUpdateVersion === info.version) {
      availableUpdateVersion = null;
      sendDownloadedUpdateStateToWindow();
      endUpdateCheck();
      return;
    }

    if (updateDownloadedReady && downloadedUpdateVersion !== info.version) {
      clearDownloadedUpdate();
    }

    availableUpdateVersion = info.version;
    const offerEpoch = updateOfferEpoch;
    const offeredVersion = info.version;
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
          if (result.response !== 0) {
            return;
          }
          if (offerEpoch !== updateOfferEpoch || availableUpdateVersion !== offeredVersion) {
            return;
          }
          startUpdateDownload();
        });
    }
  });

  autoUpdater.on('update-not-available', () => {
    const manual = isManualCheckActive();
    if (discardCheckResults) {
      clearStableFallback();
      endUpdateCheck();
      return;
    }
    // Beta feed empty → check whether a newer stable exists.
    if (tryStableFallbackCheck()) {
      return;
    }
    clearStableFallback();
    emitUpdateNotAvailable(manual);
  });

  autoUpdater.on('error', (err) => {
    const manual = isManualCheckActive();
    clearStableFallback();
    if (discardCheckResults) {
      endUpdateCheck();
      return;
    }
    endUpdateCheck();
    if (updateDownloadedReady && downloadedUpdateVersion) {
      sendDownloadedUpdateStateToWindow();
    } else {
      emitUpdateError(manual, `Update error: ${err.message}`);
    }
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
    if (activeDownloadEpoch !== null && activeDownloadEpoch !== updateOfferEpoch) {
      activeDownloadEpoch = null;
      availableUpdateVersion = null;
      sendStatusToWindow('Ignoring update downloaded from a previous channel.');
      return;
    }
    activeDownloadEpoch = null;
    updateDownloadedReady = true;
    downloadedUpdateVersion = info.version;
    availableUpdateVersion = null;
    notifyUpdateMenuStateChange();
    const windowRef = getMainWindow();
    if (!windowRef) {
      return;
    }
    sendDownloadedUpdateStateToWindow();
    dialog
      .showMessageBox(windowRef, {
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded. Restart now to install, or choose Later — the update will also install when CONV2 quits.`,
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          void installDownloadedUpdate().catch((err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            dialog.showMessageBox(windowRef, {
              type: 'error',
              title: 'Update Error',
              message: `CONV2 could not restart to install the update: ${error.message}`,
              buttons: ['OK'],
            });
          });
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
          'Auto-updates are disabled for this installation.\n\nThis build is managed by MSI, the App Store / Microsoft Store, or an admin policy. Please update through that channel.',
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

  stableFallbackInProgress = false;
  applyUpdaterChannel();
  if (!updateDownloadedReady) {
    sendUpdateStateToWindow({
      phase: 'checking',
      manual: true,
      message: 'Checking for updates...',
    });
  }
  void autoUpdater.checkForUpdates().catch((err) => {
    if (!updateCheckInFlight) {
      return;
    }
    clearStableFallback();
    endUpdateCheck();
    console.error('Failed to check for updates:', err);
    emitUpdateError(true, `Update error: ${err.message}`);
  });
};

export const isUpdateDisabled = (): boolean => {
  return updatesDisabled;
};

export const installDownloadedUpdate = async (): Promise<void> => {
  if (updatesDisabled) {
    sendUpdateStateToWindow({
      phase: 'disabled',
      manual: true,
      message: 'Auto-updates are disabled for this installation.',
    });
    return;
  }

  if (updateInstallInProgress) {
    return;
  }

  if (!updateDownloadedReady) {
    const message = 'No downloaded update is ready to install.';
    sendStatusToWindow(message);
    sendUpdateStateToWindow({
      phase: 'error',
      manual: true,
      message,
    });
    throw new Error(message);
  }

  updateInstallInProgress = true;
  notifyUpdateMenuStateChange();
  sendStatusToWindow('Restarting to install update...');
  sendUpdateStateToWindow({
    phase: 'installing',
    manual: true,
    message: 'Restarting to install update...',
  });

  try {
    await updateInstallStartingHandler?.();
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    updateInstallInProgress = false;
    notifyUpdateMenuStateChange();
    const error = err instanceof Error ? err : new Error(String(err));
    sendStatusToWindow(`Update error: ${error.message}`);
    sendUpdateStateToWindow({
      phase: 'error',
      manual: true,
      message: `Update error: ${error.message}`,
    });
    throw error;
  }
};

export const checkForUpdatesSilent = (): void => {
  if (updatesDisabled) {
    return;
  }

  if (!beginUpdateCheck('silent')) {
    return;
  }

  stableFallbackInProgress = false;
  applyUpdaterChannel();
  if (!updateDownloadedReady) {
    sendUpdateStateToWindow({
      phase: 'checking',
      manual: false,
      message: 'Checking for updates...',
    });
  }
  autoUpdater.checkForUpdates().catch((err) => {
    if (!updateCheckInFlight) {
      return;
    }
    clearStableFallback();
    endUpdateCheck();
    console.error('Silent update check failed:', err);
    emitUpdateError(false, `Update error: ${err.message}`);
  });
};

export const downloadAvailableUpdate = (): void => {
  if (updatesDisabled) {
    sendUpdateStateToWindow({
      phase: 'disabled',
      manual: true,
      message: 'Auto-updates are disabled for this installation.',
    });
    return;
  }
  startUpdateDownload();
};

export const setUpdateChannel = (channel: UpdateChannel): void => {
  const changed = updateChannel !== channel;
  updateChannel = channel;
  if (updatesDisabled) {
    return;
  }
  applyUpdaterChannel();
  if (!changed || !listenersRegistered) {
    return;
  }
  updateOfferEpoch += 1;
  activeDownloadEpoch = null;
  clearDownloadedUpdate();
  clearStaleAvailableOffer();
  queueChannelRecheck();
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
