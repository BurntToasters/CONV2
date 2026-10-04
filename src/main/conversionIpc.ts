import { ipcMain, type IpcMainInvokeEvent } from 'electron';

export const CONVERSION_IPC_CHANNELS = ['start-conversion-queue', 'cancel-conversion'] as const;

export type ConversionIpcChannel = (typeof CONVERSION_IPC_CHANNELS)[number];

export interface ConversionCancelIpcDeps {
  assertTrustedIpcSender: (event: IpcMainInvokeEvent) => void;
  markQueueCancelled: () => void;
  cancelActiveConversion: (force: boolean) => void;
}

/** Registers cancel-conversion; queue handler remains in main until next refactor slice. */
export const registerConversionCancelIpc = (deps: ConversionCancelIpcDeps): void => {
  ipcMain.handle('cancel-conversion', (event: IpcMainInvokeEvent, force?: boolean) => {
    deps.assertTrustedIpcSender(event);
    deps.markQueueCancelled();
    deps.cancelActiveConversion(!!force);
  });
};
