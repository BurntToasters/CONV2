// Compile-time gated WebDriver guest plugin for unpackaged E2E builds only.
// Comparing the Vite define directly lets Rollup drop this chunk in
// production builds.
import { api, type AppMenuActionEvent, type Conv2RendererApi } from './api';
import type * as Ipc from './generated/ipc-types';

interface Collected {
  snapshots: Ipc.QueueSnapshot[];
  progress: Ipc.ConversionProgress[];
  logs: string[];
  gpuErrors: Ipc.GPUEncoderError[];
  menuActions: AppMenuActionEvent[];
  /** The resolved value of the last detached start, or null while running. */
  startResult: Ipc.QueueSnapshot | null;
}

type HelperFn = (...args: never[]) => unknown;

export interface Conv2E2eHook {
  ready: boolean;
  api: Conv2RendererApi;
  /** Test-only helpers; the renderer never calls these. */
  helpers: Record<string, HelperFn>;
}

declare global {
  interface Window {
    __CONV2_E2E__?: Conv2E2eHook;
  }
}

export async function installE2eHookIfEnabled(): Promise<void> {
  if (import.meta.env.VITE_CONV2_E2E !== '1') return;
  await import('@wdio/tauri-plugin');
  const collected: Collected = {
    snapshots: [],
    progress: [],
    logs: [],
    gpuErrors: [],
    menuActions: [],
    startResult: null,
  };
  api.onConversionQueueUpdated((snapshot) => collected.snapshots.push(snapshot));
  api.onConversionProgress((progress) => collected.progress.push(progress));
  api.onConversionLog((message) => collected.logs.push(message));
  api.onGPUEncoderError((error) => collected.gpuErrors.push(error));
  api.onAppMenuAction((event) => collected.menuActions.push(event));

  const original = {
    selectInputFiles: api.selectInputFiles,
    selectOutputDirectory: api.selectOutputDirectory,
  };
  const helpers = {
    collected: (): Collected => structuredClone(collected),
    resetCollected: (): void => {
      collected.snapshots.length = 0;
      collected.progress.length = 0;
      collected.logs.length = 0;
      collected.gpuErrors.length = 0;
      collected.menuActions.length = 0;
      collected.startResult = null;
    },
    /**
     * Starts a queue without waiting: the command resolves only when the batch
     * ends, and specs must be able to cancel while it runs.
     */
    startQueueDetached: (payload: Ipc.StartConversionQueuePayload): void => {
      collected.startResult = null;
      void api.startConversionQueue(payload).then((snapshot) => {
        collected.startResult = snapshot;
      });
    },
    /** File dialogs answer with `paths` (empty means cancelled). */
    stubInputFiles: (paths: string[]): void => {
      api.selectInputFiles = async () => paths;
    },
    /** Folder dialogs answer with `path` (null means cancelled). */
    stubOutputDirectory: (path: string | null): void => {
      api.selectOutputDirectory = async () => path;
    },
    restoreDialogs: (): void => {
      api.selectInputFiles = original.selectInputFiles;
      api.selectOutputDirectory = original.selectOutputDirectory;
    },
  };
  window.__CONV2_E2E__ = {
    ready: true,
    api,
    helpers: helpers as unknown as Record<string, HelperFn>,
  };
}
