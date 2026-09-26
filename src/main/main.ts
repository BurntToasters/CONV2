import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  shell,
  IpcMainInvokeEvent,
  IpcMainEvent,
  FileFilter,
  MessageBoxOptions,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { presets, GPUCodec } from './presets';
import {
  createDefaultAdvancedFormatSettings,
  mergeAdvancedFormatSettings,
} from './advancedFormats';
import { checkFFmpegInstalled, getVideoInfo, redactPaths } from './ffmpeg';
import {
  initUpdater,
  checkForUpdates,
  checkForUpdatesSilent,
  downloadAvailableUpdate,
  installDownloadedUpdate,
  isUpdateDisabled,
  isUpdateReadyToInstall,
  onUpdateMenuStateChange,
  setUpdateChannel,
  setUpdateInstallStartingHandler,
  setUpdaterWindow,
} from './updater';
import { setUseSystemFFmpeg, setFFmpegBinaryOverrides } from './ffmpegPath';
import { resolveDevOverrides } from './devOverrides';
import { clearFFmpegCaches, clearHwProbeResults, setHwProbeStoreFactory } from './ffmpeg';
import { binaryFingerprint, createHwProbeStore } from './hwProbeStore';
import { normalizeFileUrl, isFrameUrlTrusted } from './ipcTrust';
import { createQuitGuard } from './quitGuard';
import { createConversionController, type ConversionController } from './conversionController';
import { buildGpuCapabilitiesPayload } from './gpuCapabilities';
import { isWindowBoundsOnScreen, loadWindowState, saveWindowState } from './windowState';
import { createFatalErrorHandler } from './fatalErrors';
import { isAllowedNavigation, toSafeExternalUrl } from './navigationPolicy';
import {
  ALLOWED_SETTINGS_KEYS,
  createDefaultSettings,
  normalizeGpuMode,
  normalizeGpuVendor,
  normalizeSettings,
  normalizeUpdateChannel,
  readSettingsFile,
  writeJsonAtomic,
} from './settingsStore';
import { resolveAbsolutePath, resolveExistingFilePath } from './pathResolvers';
import { UIPanelSettings, normalizeUiPanels } from './settingsSchema';
import { mapPresetsForRenderer } from './presetProjection';
import type { QueueSnapshot } from './conversionQueue';
import { registerConversionCancelIpc } from './conversionIpc';
import type { AppSettings } from '../shared/appContract';
import {
  installApplicationMenu,
  type AppMenuActionId,
  type ApplicationMenuController,
  type ConversionMenuState,
} from './applicationMenu';
import {
  initOsIntegration,
  installWindowsJumpList,
  parseConv2JumpArg,
  runConv2JumpAction,
  type JumpListDeps,
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

const devOverrides = resolveDevOverrides(process.env, app.isPackaged);
if (devOverrides.userDataDir) app.setPath('userData', devOverrides.userDataDir);
setFFmpegBinaryOverrides(devOverrides.ffmpegPath, devOverrides.ffprobePath);

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
  const candidatePaths = argv.filter((arg) => {
    if (typeof arg !== 'string' || arg.length === 0) {
      return false;
    }
    if (arg.startsWith('-')) {
      return false;
    }
    if (arg === process.execPath) {
      return false;
    }
    return path.isAbsolute(arg);
  });
  ingestOpenPaths(candidatePaths);
});

const pendingOpenPaths: string[] = [];

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

if (process.platform === 'darwin') {
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    ingestOpenPaths([filePath]);
  });
}

let isUpdateInstallInProgress = false;
let trustedRendererUrl: string | null = null;
const isRuntimeSmoke = process.argv.includes('--smoke') || process.env.CONV2_SMOKE === '1';
const handleNativeThemeUpdated = (): void => {
  mainWindow?.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
};

type SaveSettingsPayload = Omit<Partial<AppSettings>, 'uiPanels'> & {
  uiPanels?: Partial<UIPanelSettings>;
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
  const result = readSettingsFile(getSettingsPath());
  settings = result.settings;
  const shouldPersist = result.shouldPersist;
  setUpdateChannel(settings.updateChannel);
  setUseSystemFFmpeg(settings.useSystemFFmpeg);
  clearFFmpegCaches();
  if (shouldPersist) {
    trySaveSettings();
  }
};

const saveSettings = (): void => {
  writeJsonAtomic(getSettingsPath(), settings);
};

const trySaveSettings = (): boolean => {
  try {
    saveSettings();
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err);
    return false;
  }
};

const prepareForUpdateInstall = async (): Promise<void> => {
  isUpdateInstallInProgress = true;
  if (!conversions.isActive()) return;
  await conversions.stop();
};

const confirmQuitDuringConversion = async (): Promise<boolean> => {
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Conversion in Progress',
    message: 'A conversion is still running.',
    detail:
      'Quitting stops it and deletes the partially converted file. Files already finished are kept.',
    buttons: ['Keep Converting', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
  };
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) {
    return (await dialog.showMessageBox(options)).response === 1;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return (await dialog.showMessageBox(win, options)).response === 1;
};

const quitGuard = createQuitGuard({
  isConversionActive: () => conversions.isActive(),
  isUpdateInstallInProgress: () => isUpdateInstallInProgress,
  confirmQuit: confirmQuitDuringConversion,
  stopConversion: () => conversions.stop(),
  onError: (error) => console.error('Quit guard error:', error),
});

const conversions: ConversionController = createConversionController({
  getSettings: () => settings,
  getWindow: () => mainWindow,
  onQueueStart: () => quitGuard.reset(),
});

const getWindowStatePath = (): string => path.join(app.getPath('userData'), 'windowState.json');

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

  const windowState = loadWindowState(getWindowStatePath());
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
      webviewTag: false,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
    show: false,
  });

  attachWindowChromeListeners(mainWindow);

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    }
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

  // The renderer opens links through the open-external IPC; it never needs new windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const blockForeignNavigation = (event: { preventDefault: () => void }, targetUrl: string) => {
    if (!isAllowedNavigation(targetUrl, trustedRendererUrl)) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', blockForeignNavigation);
  mainWindow.webContents.on('will-redirect', blockForeignNavigation);
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.loadFile(rendererEntryPath);

  mainWindow.webContents.once('did-finish-load', () => {
    const loadedWindow = mainWindow;
    setTimeout(() => {
      if (loadedWindow && !loadedWindow.isDestroyed()) sendWindowChromeStyle(loadedWindow);
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
            hasFileList: !!document.getElementById('selectedFileList'),
            dropZoneRole: document.getElementById('dropZone')?.getAttribute('role'),
          }))`,
          true
        )
        .then((result) => {
          if (
            result?.title !== 'CONV2' ||
            result.version !== app.getVersion() ||
            result.hasFileList !== true ||
            result.dropZoneRole !== 'region'
          ) {
            throw new Error(
              `Runtime smoke returned invalid renderer state: ${JSON.stringify(result)}`
            );
          }
          const artifactDir = path.join(process.cwd(), 'coverage');
          fs.mkdirSync(artifactDir, { recursive: true });
          fs.writeFileSync(
            path.join(artifactDir, 'smoke-runtime.json'),
            JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2)
          );
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
    saveWindowState(mainWindow, getWindowStatePath());
    const closingWindow = mainWindow;
    const proceed = quitGuard.request(() => {
      if (closingWindow && !closingWindow.isDestroyed()) closingWindow.destroy();
    });
    if (!proceed) {
      e.preventDefault();
    }
  });

  initUpdater(mainWindow);
};

app.whenReady().then(() => {
  initOsIntegration();
  setHwProbeStoreFactory((binaryPath) =>
    createHwProbeStore({
      filePath: path.join(app.getPath('userData'), 'gpu-probe-cache.json'),
      fingerprint: binaryFingerprint(binaryPath, app.getVersion()),
    })
  );
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

app.on('before-quit', (e) => {
  if (!quitGuard.request(() => app.quit())) {
    e.preventDefault();
    return;
  }
  nativeTheme.removeListener('updated', handleNativeThemeUpdated);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

const fatalErrors = createFatalErrorHandler({
  logPath: path.join(app.getPath('userData'), 'logs', 'main-errors.log'),
  redact: redactPaths,
  isReady: () => app.isReady(),
  showError: (title, body) => dialog.showErrorBox(title, body),
});
process.on('uncaughtException', fatalErrors.onUncaughtException);
process.on('unhandledRejection', fatalErrors.onUnhandledRejection);

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
  markQueueCancelled: () => conversions.markCancelled(),
  cancelActiveConversion: (force) => conversions.cancel(!!force),
});

ipcMain.handle(
  'start-conversion-queue',
  (event: IpcMainInvokeEvent, payload: unknown): Promise<QueueSnapshot> => {
    assertTrustedIpcSender(event);
    return conversions.startQueue(payload);
  }
);

ipcMain.handle('select-output-directory', async (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  const win = mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
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

ipcMain.handle('refresh-gpu-capabilities', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  clearHwProbeResults();
});

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
  try {
    saveSettings();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to save settings: ${message}`);
  }
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

ipcMain.handle('download-update', (event: IpcMainInvokeEvent) => {
  assertTrustedIpcSender(event);
  downloadAvailableUpdate();
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

ipcMain.handle('reveal-path', async (event: IpcMainInvokeEvent, filePath: string) => {
  assertTrustedIpcSender(event);
  const resolvedPath = resolveAbsolutePath(filePath);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return;
  }
  shell.showItemInFolder(resolvedPath);
});

ipcMain.handle('open-external', async (event: IpcMainInvokeEvent, url: string) => {
  assertTrustedIpcSender(event);
  const safeUrl = toSafeExternalUrl(url);
  if (!safeUrl) return;
  try {
    await shell.openExternal(safeUrl);
  } catch {
    // browser launch failure is not actionable in the renderer
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
  try {
    saveSettings();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reset settings: ${message}`);
  }
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
