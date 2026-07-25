import type { ConversionProgress, ConversionResult } from './ffmpeg';
import type { GPUVendor } from './presets';

export type QueueItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueItemSnapshot {
  id: string;
  inputPath: string;
  fileName: string;
  status: QueueItemStatus;
  error?: string;
  outputPath?: string;
  usedCpuFallback?: boolean;
}

export interface QueueSnapshot {
  active: boolean;
  presetId: string;
  currentIndex: number;
  total: number;
  items: QueueItemSnapshot[];
}

export interface QueueRunOptions {
  inputPaths: string[];
  presetId: string;
  gpu: GPUVendor;
  removeSpacesFromFilenames?: boolean;
  outputDirectory?: string;
  showDebugOutput?: boolean;
}

export interface QueueRunCallbacks {
  onSnapshot: (snapshot: QueueSnapshot) => void;
  onProgress: (progress: ConversionProgress) => void;
  onProgressScope?: (fileIndex: number, fileCount: number) => void;
  onLog?: (message: string) => void;
  convertOne: (args: {
    inputPath: string;
    presetId: string;
    gpu: GPUVendor;
    options: {
      suppressGpuErrorEvent: boolean;
      removeSpacesFromFilenames?: boolean;
      outputDirectory?: string;
      showDebugOutput?: boolean;
    };
  }) => Promise<ConversionResult>;
  shouldRetryWithCpu: (
    result: ConversionResult,
    attemptedGpu: GPUVendor,
    hasVideoCodec: boolean
  ) => boolean;
  hasVideoCodec: boolean;
  isCancelled: () => boolean;
}

const basename = (inputPath: string): string => {
  const parts = inputPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || inputPath;
};

export const createEmptyQueueSnapshot = (): QueueSnapshot => ({
  active: false,
  presetId: '',
  currentIndex: 0,
  total: 0,
  items: [],
});

/**
 * Sequential conversion queue with optional CPU fallback after GPU failure.
 * Orchestration lives in main; the renderer only renders snapshots.
 */
export const runConversionQueue = async (
  options: QueueRunOptions,
  callbacks: QueueRunCallbacks
): Promise<QueueSnapshot> => {
  const items: QueueItemSnapshot[] = options.inputPaths.map((inputPath, index) => ({
    id: `q-${index}-${Date.now()}`,
    inputPath,
    fileName: basename(inputPath),
    status: 'pending' as const,
  }));

  let gpu: GPUVendor = options.gpu;
  const snapshot = (): QueueSnapshot => ({
    active: items.some((item) => item.status === 'pending' || item.status === 'running'),
    presetId: options.presetId,
    currentIndex: Math.max(
      0,
      items.findIndex((item) => item.status === 'running' || item.status === 'pending')
    ),
    total: items.length,
    items: items.map((item) => ({ ...item })),
  });

  callbacks.onSnapshot(snapshot());

  for (let index = 0; index < items.length; index += 1) {
    if (callbacks.isCancelled()) {
      for (let rest = index; rest < items.length; rest += 1) {
        if (items[rest].status === 'pending') {
          items[rest].status = 'cancelled';
        }
      }
      callbacks.onSnapshot(snapshot());
      break;
    }

    const item = items[index];
    item.status = 'running';
    callbacks.onSnapshot(snapshot());
    callbacks.onProgressScope?.(index, items.length);

    if (options.showDebugOutput && items.length > 1) {
      callbacks.onLog?.(`\n=== [${index + 1}/${items.length}] ${item.fileName} ===\n`);
    }

    const convertOptions = {
      suppressGpuErrorEvent: true as const,
      removeSpacesFromFilenames: options.removeSpacesFromFilenames,
      outputDirectory: options.outputDirectory,
      showDebugOutput: options.showDebugOutput,
    };

    let result = await callbacks.convertOne({
      inputPath: item.inputPath,
      presetId: options.presetId,
      gpu,
      options: convertOptions,
    });

    let usedCpuFallback = false;
    if (
      !callbacks.isCancelled() &&
      callbacks.shouldRetryWithCpu(result, gpu, callbacks.hasVideoCodec)
    ) {
      callbacks.onLog?.(`[GPU fallback] Retry with CPU for ${item.fileName}\n`);
      result = await callbacks.convertOne({
        inputPath: item.inputPath,
        presetId: options.presetId,
        gpu: 'cpu',
        options: convertOptions,
      });
      usedCpuFallback = true;
      if (usedCpuFallback && gpu !== 'cpu') {
        gpu = 'cpu';
      }
    }

    if (result.success) {
      item.status = 'done';
      item.outputPath = result.outputPath;
      item.usedCpuFallback = usedCpuFallback || undefined;
    } else if (result.error === 'Conversion cancelled' || callbacks.isCancelled()) {
      item.status = 'cancelled';
      item.error = result.error;
      for (let rest = index + 1; rest < items.length; rest += 1) {
        items[rest].status = 'cancelled';
      }
      callbacks.onSnapshot(snapshot());
      break;
    } else {
      item.status = 'failed';
      item.error = result.error;
      item.usedCpuFallback = usedCpuFallback || undefined;
    }

    callbacks.onSnapshot(snapshot());
  }

  const finalSnapshot = snapshot();
  finalSnapshot.active = false;
  callbacks.onSnapshot(finalSnapshot);
  return finalSnapshot;
};

export const shouldRetryWithCpu = (
  result: ConversionResult,
  attemptedGpu: GPUVendor,
  hasVideoCodec: boolean
): boolean => {
  if (attemptedGpu === 'cpu' || !hasVideoCodec || result.success) {
    return false;
  }
  if (result.error === 'Conversion cancelled') {
    return false;
  }
  const message = (result.error || '').toLowerCase();
  const inputErrorMarkers = [
    'error opening input',
    'no such file or directory',
    'invalid data found when processing input',
    'moov atom not found',
    'permission denied',
  ];
  if (inputErrorMarkers.some((marker) => message.includes(marker))) {
    return false;
  }
  if (result.retryWithCpuSuggested === true) {
    return true;
  }
  const gpuMarkers = [
    'nvenc',
    'amf init',
    'amf failed',
    'amf error',
    'amf encoder',
    'qsv',
    'videotoolbox',
    'no capable devices found',
    'cannot load nvencode',
    'hardware acceleration',
    'gpu',
  ];
  return gpuMarkers.some((marker) => message.includes(marker));
};
