import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isPrereleaseVersion, shouldAcceptUpdate } from './updaterPolicy';
import {
  initialUpdateState,
  transition,
  type UpdateEffect,
  type UpdateEvent,
  type UpdateStatePayload,
} from './updateMachine';

// Adapter: feeds electron-updater events into updateMachine and performs its effects.

type UpdateChannel = 'auto' | 'stable' | 'beta';
type UpdateInstallStartingHandler = () => void | Promise<void>;
type UpdateMenuStateListener = () => void;

let mainWindow: BrowserWindow | null = null;
let updatesDisabled = false;
let updateChannel: UpdateChannel = 'auto';
let listenersRegistered = false;
let updateInstallStartingHandler: UpdateInstallStartingHandler | null = null;
let state = initialUpdateState();
const updateMenuStateListeners = new Set<UpdateMenuStateListener>();

const getMainWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

const sendUpdateStateToWindow = (payload: UpdateStatePayload): void => {
  getMainWindow()?.webContents.send('update-state', payload);
};

const sendDisabled = (manual: boolean): void => {
  sendUpdateStateToWindow({
    phase: 'disabled',
    manual,
    message: 'Auto-updates are disabled for this installation.',
  });
};

const shouldUseBetaChannel = (): boolean => {
  if (updateChannel === 'beta') return true;
  if (updateChannel === 'stable') return false;
  return isPrereleaseVersion(app.getVersion());
};

const applyUpdaterChannel = (forceStable: boolean): void => {
  const useBetaChannel = !forceStable && shouldUseBetaChannel();
  // Setting channel forces allowDowngrade=true inside electron-updater.
  autoUpdater.channel = useBetaChannel ? 'beta' : 'latest';
  autoUpdater.allowPrerelease = useBetaChannel;
  autoUpdater.allowDowngrade = false;
};

const showInstallError = (windowRef: BrowserWindow, err: unknown): void => {
  const error = err instanceof Error ? err : new Error(String(err));
  void dialog.showMessageBox(windowRef, {
    type: 'error',
    title: 'Update Error',
    message: `CONV2 could not restart to install the update: ${error.message}`,
    buttons: ['OK'],
  });
};

const offerRestart = (windowRef: BrowserWindow, message: string): void => {
  void dialog
    .showMessageBox(windowRef, {
      type: 'info',
      title: 'Update Ready',
      message,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    })
    .then((result) => {
      if (result.response === 0) {
        installDownloadedUpdate().catch((err) => showInstallError(windowRef, err));
      }
    });
};

const showDialog = (effect: Extract<UpdateEffect, { type: 'dialog' }>): void => {
  const windowRef = getMainWindow();
  if (!windowRef) return;
  switch (effect.dialog) {
    case 'no-updates':
      void dialog.showMessageBox(windowRef, {
        type: 'info',
        title: 'No Updates',
        message: 'You are already running the latest version of CONV2.',
        buttons: ['OK'],
      });
      return;
    case 'available': {
      const { version, epoch } = effect;
      void dialog
        .showMessageBox(windowRef, {
          type: 'info',
          title: 'Update Available',
          message: `A new version (${version}) is available. Would you like to download it now?`,
          buttons: ['Download', 'Later'],
          defaultId: 0,
        })
        .then((result) => {
          if (result.response === 0) dispatch({ type: 'download', version, epoch });
        });
      return;
    }
    case 'already-downloaded':
      offerRestart(
        windowRef,
        `Version ${effect.version} has already been downloaded. Restart now to install it.`
      );
      return;
    case 'downloaded':
      offerRestart(
        windowRef,
        `Version ${effect.version} has been downloaded. Restart now to install, or choose Later — the update will also install when CONV2 quits.`
      );
      return;
    case 'error':
      void dialog.showMessageBox(windowRef, {
        type: 'error',
        title: 'Update Error',
        message: `An error occurred while checking for updates: ${effect.message}`,
        buttons: ['OK'],
      });
      return;
  }
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const runEffect = (effect: UpdateEffect): void => {
  switch (effect.type) {
    case 'send':
      sendUpdateStateToWindow(effect.payload);
      return;
    case 'apply-channel':
      applyUpdaterChannel(effect.forceStable);
      return;
    case 'start-check':
      void Promise.resolve()
        .then(() => autoUpdater.checkForUpdates())
        .catch((err) => {
          console.error('Update check failed:', err);
          dispatch({ type: 'check-rejected', message: errorMessage(err) });
        });
      return;
    case 'schedule-fallback':
      // electron-updater holds its check promise until this handler stack unwinds.
      setImmediate(() => dispatch({ type: 'fallback-tick' }));
      return;
    case 'schedule-silent-check':
      setImmediate(() => checkForUpdatesSilent());
      return;
    case 'start-download':
      void Promise.resolve()
        .then(() => autoUpdater.downloadUpdate())
        .catch((err) => dispatch({ type: 'download-rejected', message: errorMessage(err) }));
      return;
    case 'menu-changed':
      for (const listener of updateMenuStateListeners) listener();
      return;
    case 'dialog':
      showDialog(effect);
      return;
    case 'run-install':
    case 'reject':
      // Handled by installDownloadedUpdate, which awaits them.
      return;
  }
};

function dispatch(event: UpdateEvent): UpdateEffect[] {
  const result = transition(state, event, { betaFeed: shouldUseBetaChannel() });
  state = result.state;
  for (const effect of result.effects) runEffect(effect);
  return result.effects;
}

const sendDownloadedUpdateStateToWindow = (): void => {
  if (!state.downloaded) return;
  sendUpdateStateToWindow({
    phase: 'downloaded',
    manual: false,
    message: `Version ${state.downloaded} downloaded.`,
  });
};

// ── Platform detection ───────────────────────────────────────────────────────

const WINDOWS_REG_PATH = path.join(
  process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
  'System32',
  'reg.exe'
);

const isStoreOrManagedBuild = (): boolean => {
  const flags = process as NodeJS.Process & { mas?: boolean; windowsStore?: boolean };
  if (flags.mas === true || flags.windowsStore === true) return true;
  if (process.env.FLATPAK_ID || fs.existsSync('/.flatpak-info')) return true;
  const disableFlag = process.env.CONV2_DISABLE_UPDATES;
  return disableFlag === '1' || disableFlag === 'true';
};

const hasRegistryDwordValue = (output: string, names: string[]): boolean => {
  const nameSet = new Set(names.map((name) => name.toLowerCase()));
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+REG_DWORD\s+(\S+)/i);
    if (!match || !nameSet.has(match[1].toLowerCase())) continue;
    const raw = match[2];
    if ((raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)) === 1) return true;
  }
  return false;
};

let msiInstallationCache: boolean | null = null;

/** MSI/managed installs set a registry flag; queried once per launch. */
const checkMsiInstallation = (): boolean => {
  if (process.platform !== 'win32') return false;
  if (msiInstallationCache !== null) return msiInstallationCache;
  msiInstallationCache = ['HKLM\\Software\\CONV2', 'HKCU\\Software\\CONV2'].some((key) => {
    try {
      const result = execFileSync(WINDOWS_REG_PATH, ['query', key], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return hasRegistryDwordValue(result, ['InstalledViaMsi', 'DisableAutoUpdates']);
    } catch {
      return false;
    }
  });
  return msiInstallationCache;
};

// ── Public API ───────────────────────────────────────────────────────────────

export const isUpdateReadyToInstall = (): boolean =>
  state.downloaded !== null && !state.installing && !updatesDisabled;

export const onUpdateMenuStateChange = (listener: UpdateMenuStateListener): (() => void) => {
  updateMenuStateListeners.add(listener);
  return () => {
    updateMenuStateListeners.delete(listener);
  };
};

export const setUpdaterWindow = (window: BrowserWindow | null): void => {
  mainWindow = window;
};

export const setUpdateInstallStartingHandler = (
  handler: UpdateInstallStartingHandler | null
): void => {
  updateInstallStartingHandler = handler;
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const initUpdater = (window: BrowserWindow): void => {
  mainWindow = window;
  updatesDisabled = checkMsiInstallation() || isStoreOrManagedBuild();

  if (updatesDisabled) {
    console.log('Auto-updates disabled: MSI/Store/managed installation detected');
    sendDisabled(false);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  applyUpdaterChannel(false);

  if (listenersRegistered) {
    // macOS re-creates the window; restore a ready install once the renderer loads.
    window.webContents.once('did-finish-load', sendDownloadedUpdateStateToWindow);
    return;
  }

  autoUpdater.on('checking-for-update', () => dispatch({ type: 'checker-checking' }));
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    dispatch({
      type: 'checker-available',
      version: info.version,
      accepted: shouldAcceptUpdate(info.version, app.getVersion()),
    })
  );
  autoUpdater.on('update-not-available', () => dispatch({ type: 'checker-not-available' }));
  autoUpdater.on('error', (err: Error) =>
    dispatch({ type: 'checker-error', message: errorMessage(err) })
  );
  autoUpdater.on('download-progress', (progress) =>
    dispatch({
      type: 'download-progress',
      percent: progress.percent,
      message: `Download speed: ${formatBytes(progress.bytesPerSecond)}/s - ${Math.round(progress.percent)}% (${formatBytes(progress.transferred)}/${formatBytes(progress.total)})`,
    })
  );
  autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
    dispatch({ type: 'downloaded', version: info.version })
  );

  listenersRegistered = true;
};

export const isUpdateDisabled = (): boolean => updatesDisabled;

export const checkForUpdates = (): void => {
  if (updatesDisabled) {
    sendDisabled(true);
    const windowRef = getMainWindow();
    if (windowRef) {
      void dialog.showMessageBox(windowRef, {
        type: 'info',
        title: 'Updates Disabled',
        message:
          'Auto-updates are disabled for this installation.\n\nThis build is managed by MSI, the App Store / Microsoft Store, or an admin policy. Please update through that channel.',
        buttons: ['OK'],
      });
    }
    return;
  }
  dispatch({ type: 'check', mode: 'manual' });
};

export function checkForUpdatesSilent(): void {
  if (updatesDisabled) return;
  dispatch({ type: 'check', mode: 'silent' });
}

export const downloadAvailableUpdate = (): void => {
  if (updatesDisabled) {
    sendDisabled(true);
    return;
  }
  dispatch({ type: 'download' });
};

export const installDownloadedUpdate = async (): Promise<void> => {
  if (updatesDisabled) {
    sendDisabled(true);
    return;
  }
  const effects = dispatch({ type: 'install' });
  const rejection = effects.find((effect) => effect.type === 'reject');
  if (rejection) throw new Error(rejection.message);
  if (!effects.some((effect) => effect.type === 'run-install')) return;
  try {
    await updateInstallStartingHandler?.();
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    dispatch({ type: 'install-failed', message: errorMessage(err) });
    throw err instanceof Error ? err : new Error(String(err));
  }
};

export const setUpdateChannel = (channel: UpdateChannel): void => {
  const changed = updateChannel !== channel;
  updateChannel = channel;
  if (updatesDisabled) return;
  applyUpdaterChannel(false);
  if (changed && listenersRegistered) dispatch({ type: 'channel-changed' });
};
