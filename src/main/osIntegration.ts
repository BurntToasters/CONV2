import {
  app,
  BrowserWindow,
  Notification,
  powerSaveBlocker,
  shell,
  type JumpListCategory,
  type JumpListItem,
} from 'electron';
import * as path from 'path';
import type { ConversionProgress } from './ffmpeg';
import type { QueueSnapshot } from './conversionQueue';
import { summarizeQueueForNotification as buildQueueNotification } from '../shared/queueSummary';

export interface OsIntegrationSettings {
  preventSleepWhileConverting: boolean;
  notifyOnConversionComplete: boolean;
}

export interface QueueProgressScope {
  fileIndex: number;
  fileCount: number;
}

export interface JumpListDeps {
  pickVideoFiles: () => Promise<string[]>;
  sendMenuAction: (action: 'open-files' | 'open-settings', payload?: { paths?: string[] }) => void;
  checkForUpdates: () => void;
  isUpdateDisabled: () => boolean;
}

let activeConversionSessions = 0;
let powerBlockerId: number | null = null;
let queueProgressScope: QueueProgressScope | null = null;
let cachedNotificationPermission: 'granted' | 'denied' | 'default' | null = null;

export const computeOverallProgress = (
  percent: number,
  scope: QueueProgressScope | null
): number => {
  const fileFraction = Math.min(100, Math.max(0, percent)) / 100;
  if (!scope || scope.fileCount <= 0) {
    return fileFraction;
  }
  return Math.min(1, (scope.fileIndex + fileFraction) / scope.fileCount);
};

export const summarizeQueueForNotification = (
  snapshot: QueueSnapshot
): { title: string; body: string } =>
  buildQueueNotification({
    total: snapshot.total,
    items: snapshot.items,
  });

export const initOsIntegration = (): void => {
  if (process.platform === 'win32') {
    const flags = process as NodeJS.Process & { windowsStore?: boolean };
    if (flags.windowsStore !== true) {
      app.setAppUserModelId('com.burnttoasters.conv2');
    }
  }

  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'CONV2',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright © BurntToasters',
      website: 'https://github.com/BurntToasters/CONV2',
      credits: 'https://help.rosie.run/conv2/en-us/faq',
    });
  }
};

export const setQueueProgressScope = (scope: QueueProgressScope | null): void => {
  queueProgressScope = scope;
};

export const conversionActivityStarted = (integrationSettings: OsIntegrationSettings): void => {
  activeConversionSessions += 1;
  if (
    activeConversionSessions === 1 &&
    integrationSettings.preventSleepWhileConverting &&
    (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId))
  ) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
};

export const conversionActivityEnded = (getMainWindow: () => BrowserWindow | null): void => {
  activeConversionSessions = Math.max(0, activeConversionSessions - 1);
  if (activeConversionSessions > 0) {
    return;
  }

  queueProgressScope = null;
  const windowRef = getMainWindow();
  windowRef?.setProgressBar(-1);

  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId);
  }
  powerBlockerId = null;
};

export const updateTaskbarProgress = (
  progress: ConversionProgress,
  getMainWindow: () => BrowserWindow | null
): void => {
  const windowRef = getMainWindow();
  if (!windowRef) {
    return;
  }
  const ratio = computeOverallProgress(progress.percent, queueProgressScope);
  windowRef.setProgressBar(ratio);
};

const ensureNotificationPermission = async (): Promise<boolean> => {
  if (!Notification.isSupported()) {
    return false;
  }
  if (process.platform !== 'darwin') {
    return true;
  }
  if (cachedNotificationPermission === 'denied') {
    return false;
  }
  if (cachedNotificationPermission === 'granted' || cachedNotificationPermission === 'default') {
    return true;
  }
  const notificationCtor = Notification as typeof Notification & {
    requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
  };
  if (typeof notificationCtor.requestPermission !== 'function') {
    return true;
  }
  const permission = await notificationCtor.requestPermission();
  cachedNotificationPermission = permission;
  return permission === 'granted' || permission === 'default';
};

export const maybeNotifyConversionComplete = async (
  summary: { title: string; body: string },
  integrationSettings: OsIntegrationSettings,
  getMainWindow: () => BrowserWindow | null,
  options?: { revealOutputPath?: string }
): Promise<void> => {
  if (!integrationSettings.notifyOnConversionComplete) {
    return;
  }
  const windowRef = getMainWindow();
  if (!windowRef || windowRef.isFocused()) {
    return;
  }
  const allowed = await ensureNotificationPermission();
  if (!allowed) {
    return;
  }

  const revealPath = options?.revealOutputPath;
  const body =
    revealPath && revealPath.length > 0
      ? `${summary.body}\nClick to show output in folder.`
      : summary.body;

  const notification = new Notification({
    title: summary.title,
    body,
    silent: false,
  });
  notification.on('click', () => {
    if (windowRef.isDestroyed()) {
      return;
    }
    if (windowRef.isMinimized()) {
      windowRef.restore();
    }
    windowRef.show();
    windowRef.focus();
    const revealPath = options?.revealOutputPath;
    if (revealPath) {
      shell.showItemInFolder(revealPath);
    }
  });
  notification.show();
};

export const registerRecentOutput = (outputPath: string): void => {
  if (process.platform !== 'darwin' || !outputPath) {
    return;
  }
  try {
    app.addRecentDocument(outputPath);
  } catch {
    // ignore invalid paths
  }
};

const resolveJumpListIcon = (): string => {
  return path.join(__dirname, '../../assets/icon.ico');
};

export const buildWindowsJumpList = (deps: JumpListDeps): JumpListCategory[] => {
  const iconPath = resolveJumpListIcon();
  const execPath = process.execPath;
  const items: JumpListItem[] = [
    {
      type: 'task',
      title: 'Open video files…',
      description: 'Choose videos to convert',
      program: execPath,
      args: '--conv2-jump=open-files',
      iconPath,
      iconIndex: 0,
    },
    {
      type: 'task',
      title: 'Settings…',
      description: 'Open CONV2 settings',
      program: execPath,
      args: '--conv2-jump=open-settings',
      iconPath,
      iconIndex: 0,
    },
  ];

  if (!deps.isUpdateDisabled()) {
    items.push({
      type: 'task',
      title: 'Check for updates…',
      description: 'Look for a new CONV2 version',
      program: execPath,
      args: '--conv2-jump=check-updates',
      iconPath,
      iconIndex: 0,
    });
  }

  return [{ type: 'tasks', items }];
};

export const installWindowsJumpList = (deps: JumpListDeps): void => {
  if (process.platform !== 'win32') {
    return;
  }
  app.setJumpList(buildWindowsJumpList(deps));
};

export type Conv2JumpAction = 'open-files' | 'open-settings' | 'check-updates';

export const parseConv2JumpArg = (argv: string[]): Conv2JumpAction | null => {
  const entry = argv.find((arg) => arg.startsWith('--conv2-jump='));
  if (!entry) {
    return null;
  }
  const action = entry.slice('--conv2-jump='.length);
  if (action === 'open-files' || action === 'open-settings' || action === 'check-updates') {
    return action;
  }
  return null;
};

export const runConv2JumpAction = async (
  action: Conv2JumpAction,
  deps: JumpListDeps
): Promise<void> => {
  switch (action) {
    case 'open-files': {
      const paths = await deps.pickVideoFiles();
      if (paths.length > 0) {
        deps.sendMenuAction('open-files', { paths });
      }
      break;
    }
    case 'open-settings':
      deps.sendMenuAction('open-settings');
      break;
    case 'check-updates':
      if (!deps.isUpdateDisabled()) {
        deps.checkForUpdates();
      }
      break;
    default:
      break;
  }
};
