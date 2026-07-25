import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

export interface WindowChromeStylePayload {
  platform: NodeJS.Platform;
  customTitleBar: boolean;
}

export const usesCustomTitleBar = (): boolean => {
  if (process.mas) {
    return false;
  }
  return process.platform === 'darwin' || process.platform === 'win32';
};

export const getWindowChromeConstructorOptions = (): BrowserWindowConstructorOptions => {
  if (!usesCustomTitleBar()) {
    return {};
  }

  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 12 },
    };
  }

  if (process.platform === 'win32') {
    return {
      frame: false,
      thickFrame: true,
    };
  }

  return {};
};

export const getWindowChromeStylePayload = (): WindowChromeStylePayload => ({
  platform: process.platform,
  customTitleBar: usesCustomTitleBar(),
});

export const sendWindowChromeStyle = (window: BrowserWindow): void => {
  window.webContents.send('window-chrome-style', getWindowChromeStylePayload());
};

const isWindows = (): boolean => process.platform === 'win32';

export const attachWindowChromeListeners = (window: BrowserWindow): void => {
  const notifyMaximized = (): void => {
    if (!isWindows() || window.isDestroyed()) {
      return;
    }
    window.webContents.send('window-maximized-changed', window.isMaximized());
  };

  window.on('maximize', notifyMaximized);
  window.on('unmaximize', notifyMaximized);
};

type GetMainWindow = () => BrowserWindow | null;
type AssertTrustedIpcSender = (event: IpcMainInvokeEvent) => void;

export const registerWindowChromeIpc = (
  getMainWindow: GetMainWindow,
  assertTrustedIpcSender: AssertTrustedIpcSender
): void => {
  ipcMain.handle('window-minimize', (event: IpcMainInvokeEvent) => {
    assertTrustedIpcSender(event);
    if (!isWindows()) {
      return;
    }
    getMainWindow()?.minimize();
  });

  ipcMain.handle('window-toggle-maximize', (event: IpcMainInvokeEvent) => {
    assertTrustedIpcSender(event);
    if (!isWindows()) {
      return;
    }
    const win = getMainWindow();
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle('window-close', (event: IpcMainInvokeEvent) => {
    assertTrustedIpcSender(event);
    if (!isWindows()) {
      return;
    }
    getMainWindow()?.close();
  });

  ipcMain.handle('window-is-maximized', (event: IpcMainInvokeEvent) => {
    assertTrustedIpcSender(event);
    if (!isWindows()) {
      return false;
    }
    const win = getMainWindow();
    return win?.isMaximized() ?? false;
  });
};
