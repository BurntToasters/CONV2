import { shell, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings } from '../shared/appContract';
import {
  cancelConversion as cancelFFmpegConversion,
  checkGPUEncoderSupport,
  convertVideo,
  parseGPUError,
  redactPaths,
  waitForConversionStop,
  type ConversionResult,
} from './ffmpeg';
import {
  MAX_QUEUE_ITEMS,
  createEmptyQueueSnapshot,
  runConversionQueue,
  shouldRetryWithCpu,
  type QueueSnapshot,
} from './conversionQueue';
import {
  conversionActivityEnded,
  conversionActivityStarted,
  maybeNotifyConversionComplete,
  registerRecentOutput,
  setQueueProgressScope,
  summarizeQueueForNotification,
  updateTaskbarProgress,
  type OsIntegrationSettings,
} from './osIntegration';
import { resolveExistingDirectoryPath, resolveExistingFilePath } from './pathResolvers';
import { getPresetById, getPresetGpuCodec, type GPUVendor, type Preset } from './presets';
import { normalizeGpuVendor } from './settingsStore';

// Owns the conversion lifecycle: request validation, one-at-a-time queue runs, cancel and stop.

export interface ValidatedQueueRequest {
  kind: 'run';
  inputPaths: string[];
  preset: Preset;
  presetId: string;
  gpu: GPUVendor;
  removeSpacesFromFilenames?: boolean;
  outputDirectory?: string;
  showDebugOutput?: boolean;
}

export type QueueRequestValidation =
  ValidatedQueueRequest | { kind: 'reject'; snapshot: QueueSnapshot };

const rejectAll = (
  inputPaths: string[],
  idPrefix: string,
  error: string,
  total = inputPaths.length
): { kind: 'reject'; snapshot: QueueSnapshot } => {
  const snapshot = createEmptyQueueSnapshot();
  snapshot.total = total;
  snapshot.items = inputPaths.slice(0, MAX_QUEUE_ITEMS).map((inputPath, index) => ({
    id: `${idPrefix}-${index}`,
    inputPath,
    fileName: path.basename(inputPath),
    status: 'failed' as const,
    error,
  }));
  return { kind: 'reject', snapshot };
};

/** Validates an untrusted IPC payload before any field is used. */
export const validateQueueRequest = (
  payload: unknown,
  options: { isBusy: boolean; getPreset: (id: string) => Preset | undefined }
): QueueRequestValidation => {
  const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const inputPaths = Array.isArray(raw.inputPaths)
    ? raw.inputPaths.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0
      )
    : [];

  if (options.isBusy) {
    const busy = rejectAll(inputPaths, 'busy', 'Another conversion is already in progress');
    busy.snapshot.total = busy.snapshot.items.length;
    return busy;
  }
  if (inputPaths.length === 0) return { kind: 'reject', snapshot: createEmptyQueueSnapshot() };
  if (inputPaths.length > MAX_QUEUE_ITEMS) {
    return rejectAll(
      inputPaths,
      'too-many',
      `A single batch is limited to ${MAX_QUEUE_ITEMS} files`,
      inputPaths.length
    );
  }
  const presetId = typeof raw.presetId === 'string' ? raw.presetId : '';
  const preset = options.getPreset(presetId);
  if (!preset) {
    const invalid = rejectAll(inputPaths, 'invalid', 'Invalid preset selected');
    invalid.snapshot.presetId = presetId;
    return invalid;
  }
  return {
    kind: 'run',
    inputPaths,
    preset,
    presetId,
    gpu: normalizeGpuVendor(raw.gpu),
    ...(typeof raw.removeSpacesFromFilenames === 'boolean'
      ? { removeSpacesFromFilenames: raw.removeSpacesFromFilenames }
      : {}),
    ...(typeof raw.outputDirectory === 'string' ? { outputDirectory: raw.outputDirectory } : {}),
    ...(typeof raw.showDebugOutput === 'boolean' ? { showDebugOutput: raw.showDebugOutput } : {}),
  };
};

export interface ConversionControllerDeps {
  getSettings: () => AppSettings;
  getWindow: () => BrowserWindow | null;
  /** Called when a batch actually starts (e.g. re-arm the quit confirmation). */
  onQueueStart: () => void;
}

export interface ConversionController {
  isActive: () => boolean;
  /** Aborts preflight work and signals FFmpeg to stop. */
  cancel: (force: boolean) => void;
  markCancelled: () => void;
  /** Cancels and waits for FFmpeg to exit (quit / update install). */
  stop: () => Promise<void>;
  startQueue: (payload: unknown) => Promise<QueueSnapshot>;
}

const resolveRevealOutputPath = (snapshot: QueueSnapshot): string | undefined => {
  const successes = snapshot.items.filter(
    (item) => item.status === 'done' && item.outputPath && item.outputPath.length > 0
  );
  return successes[successes.length - 1]?.outputPath;
};

export const createConversionController = (
  deps: ConversionControllerDeps
): ConversionController => {
  let active = false;
  let queueCancelled = false;
  let activeAbortController: AbortController | null = null;

  const cancel = (force: boolean): void => {
    activeAbortController?.abort();
    cancelFFmpegConversion(force);
  };

  const send = (channel: string, payload: unknown): void => {
    deps.getWindow()?.webContents.send(channel, payload);
  };

  const osSettings = (): OsIntegrationSettings => {
    const settings = deps.getSettings();
    return {
      notifyOnConversionComplete: settings.notifyOnConversionComplete,
      preventSleepWhileConverting: settings.preventSleepWhileConverting,
    };
  };

  const performSingleConversion = async (
    inputPath: string,
    presetId: string,
    gpuOverride: GPUVendor | undefined,
    options?: {
      suppressGpuErrorEvent?: boolean;
      removeSpacesFromFilenames?: boolean;
      outputDirectory?: string;
      showDebugOutput?: boolean;
      abortController?: AbortController;
    }
  ): Promise<ConversionResult> => {
    const resolvedInputPath = resolveExistingFilePath(inputPath);
    if (!resolvedInputPath) {
      return { success: false, outputPath: '', error: 'Invalid input file path' };
    }

    const suppressGpuErrorEvent = options?.suppressGpuErrorEvent === true;
    const showDebugOutput = options?.showDebugOutput ?? deps.getSettings().showDebugOutput;

    const preset = getPresetById(presetId);
    if (!preset) {
      return { success: false, outputPath: '', error: 'Invalid preset selected' };
    }

    const requestedGpu =
      gpuOverride === undefined
        ? deps.getSettings().gpuManualVendor
        : normalizeGpuVendor(gpuOverride);
    const codec = getPresetGpuCodec(preset, {
      advancedFormatSettings: deps.getSettings().advancedFormatSettings,
    });
    const effectiveGpu =
      requestedGpu === 'apple' && codec === 'av1'
        ? 'cpu'
        : requestedGpu === 'amd' && process.platform === 'linux'
          ? 'cpu'
          : requestedGpu;

    const conversionAbortController = options?.abortController ?? new AbortController();
    if (conversionAbortController.signal.aborted) {
      return { success: false, outputPath: '', error: 'Conversion cancelled' };
    }
    activeAbortController = conversionAbortController;
    try {
      if (codec !== null && effectiveGpu !== 'cpu') {
        const encoderCheck = await checkGPUEncoderSupport(
          effectiveGpu,
          codec,
          conversionAbortController.signal
        );
        if (conversionAbortController.signal.aborted) {
          return { success: false, outputPath: '', error: 'Conversion cancelled' };
        }
        if (!encoderCheck.available && encoderCheck.error) {
          if (!suppressGpuErrorEvent) {
            deps.getWindow()?.webContents.send('gpu-encoder-error', encoderCheck.error);
          }
          return {
            success: false,
            outputPath: '',
            error: encoderCheck.error.message,
            retryWithCpuSuggested: encoderCheck.error.canRetryWithCPU,
          };
        }
      }

      const outputDir =
        resolveExistingDirectoryPath(options?.outputDirectory) ??
        resolveExistingDirectoryPath(deps.getSettings().outputDirectory) ??
        path.dirname(resolvedInputPath);

      let result: ConversionResult;
      try {
        result = await convertVideo(
          resolvedInputPath,
          outputDir,
          preset,
          effectiveGpu,
          (progress) => {
            updateTaskbarProgress(progress, deps.getWindow);
            deps.getWindow()?.webContents.send('conversion-progress', progress);
          },
          showDebugOutput
            ? (message) => {
                deps.getWindow()?.webContents.send('conversion-log', redactPaths(message));
              }
            : undefined,
          {
            removeSpacesFromOutputName:
              options?.removeSpacesFromFilenames ?? deps.getSettings().removeSpacesFromFilenames,
            useCpuDecodingWhenGpu: deps.getSettings().useCpuDecodingWhenGpu,
            advancedFormatSettings: deps.getSettings().advancedFormatSettings,
            signal: conversionAbortController.signal,
          }
        );
      } catch (err) {
        result = {
          success: false,
          outputPath: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (!result.success && result.error && effectiveGpu !== 'cpu' && codec !== null) {
        const gpuError = parseGPUError(result.errorDetail ?? result.error, effectiveGpu, codec);
        if (gpuError) {
          result.retryWithCpuSuggested = gpuError.canRetryWithCPU;
          if (!suppressGpuErrorEvent) {
            deps.getWindow()?.webContents.send('gpu-encoder-error', gpuError);
          }
        }
      }

      if (result.success && deps.getSettings().moveOriginalToTrashOnSuccess) {
        const shouldSkipTrash = conversionAbortController.signal.aborted || queueCancelled;
        let outputReady = false;
        if (!shouldSkipTrash && result.outputPath) {
          try {
            const outputStat = fs.statSync(result.outputPath);
            outputReady = outputStat.isFile() && outputStat.size > 0;
          } catch {
            outputReady = false;
          }
        }

        if (!shouldSkipTrash && outputReady) {
          try {
            await shell.trashItem(resolvedInputPath);
            if (showDebugOutput) {
              deps
                .getWindow()
                ?.webContents.send(
                  'conversion-log',
                  redactPaths(`Moved original file to trash: ${resolvedInputPath}\n`)
                );
            }
          } catch (trashError) {
            const errorMessage =
              trashError instanceof Error ? trashError.message : String(trashError);
            deps
              .getWindow()
              ?.webContents.send(
                'conversion-log',
                redactPaths(`Failed to move original file to trash: ${errorMessage}\n`)
              );
            result = {
              ...result,
              error: result.error
                ? `${result.error}; also failed to trash original: ${errorMessage}`
                : `Conversion succeeded but failed to trash original: ${errorMessage}`,
            };
          }
        } else if (!shouldSkipTrash && !outputReady) {
          const message = 'Skipped trashing original: output file missing or empty.';
          deps.getWindow()?.webContents.send('conversion-log', redactPaths(`${message}\n`));
        }
      }

      const resultForRenderer: ConversionResult = result.error
        ? {
            ...result,
            error: redactPaths(result.error),
            ...(result.errorDetail ? { errorDetail: redactPaths(result.errorDetail) } : {}),
          }
        : result;
      if (result.success && result.outputPath) {
        registerRecentOutput(result.outputPath);
      }
      return resultForRenderer;
    } finally {
      if (activeAbortController === conversionAbortController) {
        activeAbortController = null;
      }
    }
  };

  const startQueue = async (payload: unknown): Promise<QueueSnapshot> => {
    const request = validateQueueRequest(payload, { isBusy: active, getPreset: getPresetById });
    if (request.kind === 'reject') {
      send('conversion-queue-updated', request.snapshot);
      return request.snapshot;
    }
    const codec = getPresetGpuCodec(request.preset, {
      advancedFormatSettings: deps.getSettings().advancedFormatSettings,
    });

    active = true;
    deps.onQueueStart();
    queueCancelled = false;
    const queueAbortController = new AbortController();
    activeAbortController = queueAbortController;
    setQueueProgressScope(null);
    conversionActivityStarted(osSettings());
    try {
      const snapshot = await runConversionQueue(
        {
          inputPaths: request.inputPaths,
          presetId: request.presetId,
          gpu: request.gpu,
          removeSpacesFromFilenames: request.removeSpacesFromFilenames,
          outputDirectory: request.outputDirectory,
          showDebugOutput: request.showDebugOutput,
        },
        {
          onSnapshot: (next) => send('conversion-queue-updated', next),
          onProgressScope: (fileIndex, fileCount) =>
            setQueueProgressScope({ fileIndex, fileCount }),
          onProgress: (progress) => {
            updateTaskbarProgress(progress, deps.getWindow);
            send('conversion-progress', progress);
          },
          onLog: (message) => send('conversion-log', redactPaths(message)),
          convertOne: async ({ inputPath, presetId, gpu, options }) =>
            performSingleConversion(inputPath, presetId, gpu, {
              ...options,
              abortController: queueAbortController,
            }),
          shouldRetryWithCpu,
          hasVideoCodec: codec !== null,
          isCancelled: () => queueCancelled || queueAbortController.signal.aborted,
        }
      );
      await maybeNotifyConversionComplete(
        summarizeQueueForNotification(snapshot),
        osSettings(),
        deps.getWindow,
        { revealOutputPath: resolveRevealOutputPath(snapshot) }
      );
      return snapshot;
    } finally {
      active = false;
      queueCancelled = false;
      if (activeAbortController === queueAbortController) activeAbortController = null;
      conversionActivityEnded(deps.getWindow);
    }
  };

  return {
    isActive: () => active,
    cancel,
    markCancelled: () => {
      queueCancelled = true;
    },
    stop: async () => {
      cancel(true);
      if (!(await waitForConversionStop(3000))) {
        cancel(true);
        await waitForConversionStop(1500);
      }
      active = false;
    },
    startQueue,
  };
};
