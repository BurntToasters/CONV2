import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GPUVendor, Preset, getPresetGpuCodec } from './presets';
import { AdvancedFormatSettings } from './advancedFormats';

type FFmpegPathModule = typeof import('./ffmpegPath');

let ffmpegPathModule: FFmpegPathModule | null = null;

const getFFmpegPathModule = (): FFmpegPathModule => {
  if (!ffmpegPathModule) {
    ffmpegPathModule = require('./ffmpegPath') as FFmpegPathModule;
  }
  return ffmpegPathModule;
};

const getFFmpegBinaryPath = (): string => getFFmpegPathModule().getFFmpegPath();
const getFFprobeBinaryPath = (): string => getFFmpegPathModule().getFFprobePath();

const getWindowsSystemBinaryPath = (binaryName: string): string => {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', binaryName);
};

const WINDOWS_TASKKILL_PATH = getWindowsSystemBinaryPath('taskkill.exe');

export const GPU_ENCODERS: Record<string, Record<GPUVendor, string>> = {
  h264: {
    nvidia: 'h264_nvenc',
    amd: 'h264_amf',
    intel: 'h264_qsv',
    apple: 'h264_videotoolbox',
    cpu: 'libx264',
  },
  h265: {
    nvidia: 'hevc_nvenc',
    amd: 'hevc_amf',
    intel: 'hevc_qsv',
    apple: 'hevc_videotoolbox',
    cpu: 'libx265',
  },
  av1: {
    nvidia: 'av1_nvenc',
    amd: 'av1_amf',
    intel: 'av1_qsv',
    apple: 'libsvtav1',
    cpu: 'libsvtav1',
  },
};

// Human-readable
const GPU_NAMES: Record<GPUVendor, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  apple: 'Apple',
  cpu: 'CPU',
};

const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264',
  h265: 'H.265/HEVC',
  av1: 'AV1',
};

const NVIDIA_DECODERS: Record<string, string> = {
  h264: 'h264_cuvid',
  hevc: 'hevc_cuvid',
  h265: 'hevc_cuvid',
  av1: 'av1_cuvid',
  vp9: 'vp9_cuvid',
  mpeg2video: 'mpeg2_cuvid',
  mpeg4: 'mpeg4_cuvid',
};

const INTEL_DECODERS: Record<string, string> = {
  h264: 'h264_qsv',
  hevc: 'hevc_qsv',
  h265: 'hevc_qsv',
  av1: 'av1_qsv',
  vp9: 'vp9_qsv',
};

const D3D11_DECODERS: Record<string, string> = {
  h264: 'h264_d3d11va',
  hevc: 'hevc_d3d11va',
  h265: 'hevc_d3d11va',
  av1: 'av1_d3d11va',
  vp9: 'vp9_d3d11va',
};

const VIDEOTOOLBOX_DECODERS: Record<string, string> = {
  h264: 'h264_videotoolbox',
  hevc: 'hevc_videotoolbox',
  h265: 'hevc_videotoolbox',
};

export interface GPUEncoderError {
  type: 'encoder_unavailable' | 'gpu_capability' | 'driver_error' | 'unknown';
  message: string;
  details: string;
  suggestion: string;
  canRetryWithCPU: boolean;
  codec?: string;
  gpu?: GPUVendor;
}

export interface ConversionProgress {
  percent: number;
  frame: number;
  fps: number;
  time: string;
  bitrate: string;
  speed: string;
}

export interface ConversionResult {
  success: boolean;
  outputPath: string;
  error?: string;
  retryWithCpuSuggested?: boolean;
}

export interface ConvertVideoOptions {
  removeSpacesFromOutputName?: boolean;
  useCpuDecodingWhenGpu?: boolean;
  advancedFormatSettings?: AdvancedFormatSettings;
}

export interface VideoInfo {
  duration: number;
  size: number;
  width: number;
  height: number;
  codec: string;
  format: string;
  pixFmt?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
}

let currentProcess: ChildProcess | null = null;
const outputPathByProcess = new Map<ChildProcess, string>();
const canceledProcesses = new Set<ChildProcess>();
const pendingForceKillTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();
const MAX_ERROR_OUTPUT_CHARS = 256 * 1024;
const MAX_PROGRESS_EMIT_INTERVAL_MS = 120;

const BINARY_CHECK_TIMEOUT_MS = 10000;
const FFMPEG_INSTALLED_CACHE_TTL_MS = 30_000;

const checkBinaryInstalled = async (binaryPath: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ['-version']);
    const timer = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, BINARY_CHECK_TIMEOUT_MS);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
};

let ffmpegInstalledCache: { result: boolean; expiresAt: number } | null = null;

export const checkFFmpegInstalled = async (): Promise<boolean> => {
  const now = Date.now();
  if (ffmpegInstalledCache && now < ffmpegInstalledCache.expiresAt) {
    return ffmpegInstalledCache.result;
  }
  const [ffmpegOk, ffprobeOk] = await Promise.all([
    checkBinaryInstalled(getFFmpegBinaryPath()),
    checkBinaryInstalled(getFFprobeBinaryPath()),
  ]);
  const result = ffmpegOk && ffprobeOk;
  ffmpegInstalledCache = { result, expiresAt: now + FFMPEG_INSTALLED_CACHE_TTL_MS };
  return result;
};

let encoderCache: Set<string> | null = null;
let decoderCache: Set<string> | null = null;
let encoderCacheInFlight: Promise<Set<string>> | null = null;
let decoderCacheInFlight: Promise<Set<string>> | null = null;
const hwEncoderProbeCache = new Map<string, boolean>();

export const clearFFmpegCaches = (): void => {
  encoderCache = null;
  decoderCache = null;
  encoderCacheInFlight = null;
  decoderCacheInFlight = null;
  hwEncoderProbeCache.clear();
  ffmpegInstalledCache = null;
};

const FFMPEG_LIST_TIMEOUT_MS = 15_000;

export const getAvailableEncoders = async (): Promise<Set<string>> => {
  if (encoderCache) {
    return encoderCache;
  }
  if (encoderCacheInFlight) {
    return encoderCacheInFlight;
  }

  encoderCacheInFlight = new Promise<Set<string>>((resolve) => {
    const proc = spawn(getFFmpegBinaryPath(), ['-encoders', '-hide_banner']);
    let output = '';

    const timer = setTimeout(() => {
      proc.kill();
      encoderCacheInFlight = null;
      resolve(new Set());
    }, FFMPEG_LIST_TIMEOUT_MS);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', () => {
      clearTimeout(timer);
      const encoders = new Set<string>();
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*[VASFXBD.]+\s+(\S+)/);
        if (match && match[1]) {
          encoders.add(match[1]);
        }
      }
      encoderCache = encoders;
      encoderCacheInFlight = null;
      resolve(encoders);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      encoderCacheInFlight = null;
      resolve(new Set());
    });
  });

  return encoderCacheInFlight;
};

export const checkEncoderAvailable = async (encoder: string): Promise<boolean> => {
  const encoders = await getAvailableEncoders();
  return encoders.has(encoder);
};

const HW_PROBE_TIMEOUT_MS = 8000;

const probeHwEncoderAvailable = async (encoder: string): Promise<boolean> => {
  const cached = hwEncoderProbeCache.get(encoder);
  if (cached !== undefined) return cached;

  const listed = await checkEncoderAvailable(encoder);
  if (!listed) {
    hwEncoderProbeCache.set(encoder, false);
    return false;
  }

  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=256x256:d=0.04:r=25,format=yuv420p',
      '-frames:v',
      '1',
      '-c:v',
      encoder,
      '-f',
      'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ];
    const proc = spawn(getFFmpegBinaryPath(), args);
    const timer = setTimeout(() => {
      proc.kill();
      hwEncoderProbeCache.set(encoder, false);
      resolve(false);
    }, HW_PROBE_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const available = code === 0;
      hwEncoderProbeCache.set(encoder, available);
      resolve(available);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      hwEncoderProbeCache.set(encoder, false);
      resolve(false);
    });
  });
};

export const getAvailableDecoders = async (): Promise<Set<string>> => {
  if (decoderCache) {
    return decoderCache;
  }
  if (decoderCacheInFlight) {
    return decoderCacheInFlight;
  }

  decoderCacheInFlight = new Promise<Set<string>>((resolve) => {
    const proc = spawn(getFFmpegBinaryPath(), ['-decoders', '-hide_banner']);
    let output = '';

    const timer = setTimeout(() => {
      proc.kill();
      decoderCacheInFlight = null;
      resolve(new Set());
    }, FFMPEG_LIST_TIMEOUT_MS);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', () => {
      clearTimeout(timer);
      const decoders = new Set<string>();
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*[VASFXBD.]+\s+(\S+)/);
        if (match && match[1]) {
          decoders.add(match[1]);
        }
      }
      decoderCache = decoders;
      decoderCacheInFlight = null;
      resolve(decoders);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      decoderCacheInFlight = null;
      resolve(new Set());
    });
  });

  return decoderCacheInFlight;
};

export const checkDecoderAvailable = async (decoder: string): Promise<boolean> => {
  const decoders = await getAvailableDecoders();
  return decoders.has(decoder);
};

export const checkGPUEncoderSupport = async (
  gpu: GPUVendor,
  codec: 'h264' | 'h265' | 'av1'
): Promise<{ available: boolean; encoder: string; error?: GPUEncoderError }> => {
  if (gpu === 'cpu') {
    return { available: true, encoder: GPU_ENCODERS[codec].cpu };
  }

  const encoder = GPU_ENCODERS[codec]?.[gpu];
  if (!encoder) {
    return {
      available: false,
      encoder: '',
      error: {
        type: 'encoder_unavailable',
        message: `No ${CODEC_NAMES[codec]} encoder for ${GPU_NAMES[gpu]}`,
        details: `The selected GPU vendor does not have a ${codec} encoder configured.`,
        suggestion: 'Try using CPU encoding instead.',
        canRetryWithCPU: true,
        codec,
        gpu,
      },
    };
  }

  const available = await probeHwEncoderAvailable(encoder);
  if (!available) {
    return {
      available: false,
      encoder,
      error: {
        type: 'encoder_unavailable',
        message: `${GPU_NAMES[gpu]} ${CODEC_NAMES[codec]} encoder not available`,
        details: `The encoder "${encoder}" could not initialise on this system. This could mean:\n• No compatible ${GPU_NAMES[gpu]} hardware was detected\n• Your GPU drivers don't support this codec\n• FFmpeg wasn't compiled with ${GPU_NAMES[gpu]} support\n• The required libraries are missing`,
        suggestion:
          gpu === 'nvidia' && codec === 'av1'
            ? 'AV1 encoding requires an RTX 40-series GPU or newer. Try H.264 or H.265 instead, or use CPU encoding.'
            : `Try using CPU encoding, or ensure your ${GPU_NAMES[gpu]} drivers are up to date.`,
        canRetryWithCPU: true,
        codec,
        gpu,
      },
    };
  }

  return { available: true, encoder };
};

export const parseGPUError = (
  errorOutput: string,
  gpu: GPUVendor,
  codec?: string
): GPUEncoderError | null => {
  const gpuName = GPU_NAMES[gpu];
  const codecName = codec ? CODEC_NAMES[codec] || codec : 'video';

  // NVIDIA specific errors
  if (gpu === 'nvidia') {
    if (
      errorOutput.includes('No capable devices found') ||
      errorOutput.includes('Cannot load nvEncodeAPI') ||
      errorOutput.includes('nvEncodeAPICreateInstance failed')
    ) {
      return {
        type: 'gpu_capability',
        message: `${gpuName} encoder initialization failed`,
        details:
          "FFmpeg could not initialize the NVIDIA encoder. This usually means:\n• Your GPU doesn't support hardware encoding\n• NVIDIA drivers are not installed or outdated\n• Another application is using the encoder",
        suggestion: 'Update your NVIDIA drivers or try CPU encoding.',
        canRetryWithCPU: true,
        codec,
        gpu,
      };
    }
    if (errorOutput.includes('not capable') || errorOutput.includes('unsupported')) {
      return {
        type: 'gpu_capability',
        message: `Your ${gpuName} GPU doesn't support ${codecName} encoding`,
        details:
          codec === 'av1'
            ? 'AV1 hardware encoding requires an RTX 40-series (Ada Lovelace) GPU or newer.'
            : `Your GPU model doesn't support hardware ${codecName} encoding.`,
        suggestion:
          codec === 'av1'
            ? 'Use H.264 or H.265 for hardware encoding, or switch to CPU for AV1.'
            : 'Try using CPU encoding instead.',
        canRetryWithCPU: true,
        codec,
        gpu,
      };
    }
  }

  // AMD specific errors
  if (gpu === 'amd') {
    if (
      errorOutput.includes('AMF') &&
      (errorOutput.includes('failed') || errorOutput.includes('error'))
    ) {
      return {
        type: 'gpu_capability',
        message: `${gpuName} encoder initialization failed`,
        details:
          "FFmpeg could not initialize the AMD AMF encoder. This usually means:\n• Your GPU doesn't support AMF encoding\n• AMD drivers are not installed or outdated",
        suggestion: 'Update your AMD drivers or try CPU encoding.',
        canRetryWithCPU: true,
        codec,
        gpu,
      };
    }
    if (errorOutput.includes('not supported') || errorOutput.includes('unsupported')) {
      return {
        type: 'gpu_capability',
        message: `Your ${gpuName} GPU doesn't support ${codecName} encoding`,
        details:
          codec === 'av1'
            ? 'AV1 hardware encoding requires an RX 7000 series (RDNA 3) GPU or newer.'
            : `Your GPU model doesn't support hardware ${codecName} encoding.`,
        suggestion:
          codec === 'av1'
            ? 'Use H.264 or H.265 for hardware encoding, or switch to CPU for AV1.'
            : 'Try using CPU encoding instead.',
        canRetryWithCPU: true,
        codec,
        gpu,
      };
    }
  }

  // Intel specific errors
  if (gpu === 'intel') {
    if (
      errorOutput.includes('QSV') &&
      (errorOutput.includes('failed') ||
        errorOutput.includes('error') ||
        errorOutput.includes('not found'))
    ) {
      return {
        type: 'gpu_capability',
        message: `${gpuName} Quick Sync encoder not available`,
        details:
          "FFmpeg could not initialize Intel Quick Sync Video. This usually means:\n• Your CPU/GPU doesn't support Quick Sync\n• Intel graphics drivers are not installed\n• Quick Sync is disabled in BIOS",
        suggestion:
          'Ensure Intel graphics drivers are installed and Quick Sync is enabled in BIOS, or try CPU encoding.',
        canRetryWithCPU: true,
        codec,
        gpu,
      };
    }
  }

  // Apple specific errors
  if (gpu === 'apple') {
    if (
      errorOutput.includes('videotoolbox') &&
      (errorOutput.includes('failed') || errorOutput.includes('error'))
    ) {
      return {
        type: 'gpu_capability',
        message: 'VideoToolbox encoder not available',
        details:
          "FFmpeg could not initialize Apple VideoToolbox. This usually means:\n• Your Mac doesn't support hardware encoding for this codec\n• macOS version doesn't support this encoder",
        suggestion: 'Try using CPU encoding instead.',
        canRetryWithCPU: true,
        codec,
        gpu,
      };
    }
  }

  // Generic encoder errors
  if (errorOutput.includes('Encoder') && errorOutput.includes('not found')) {
    return {
      type: 'encoder_unavailable',
      message: `${codecName} encoder not found`,
      details: 'The selected encoder is not available in your FFmpeg installation.',
      suggestion: 'Try using CPU encoding instead.',
      canRetryWithCPU: true,
      codec,
      gpu,
    };
  }

  // DLL/library loading errors
  if (errorOutput.includes('DLL') || errorOutput.includes('LoadLibrary')) {
    return {
      type: 'driver_error',
      message: 'GPU driver or library error',
      details: 'A required library failed to load. This usually indicates a driver issue.',
      suggestion: 'Update your GPU drivers and restart your computer.',
      canRetryWithCPU: true,
      codec,
      gpu,
    };
  }

  return null;
};

const normalizeCodec = (codec?: string): string | null => {
  if (!codec) return null;
  const normalized = codec.toLowerCase();
  if (normalized === 'h265') return 'hevc';
  return normalized;
};

const canAccessVaapiDevice = (devicePath: string): boolean => {
  try {
    fs.accessSync(devicePath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const findVaapiDevice = (): string | null => {
  const driDir = '/dev/dri';
  try {
    const entries = fs.readdirSync(driDir);
    const renderDevices = entries
      .filter((e) => e.startsWith('renderD'))
      .sort()
      .map((e) => path.join(driDir, e));
    for (const device of renderDevices) {
      if (canAccessVaapiDevice(device)) {
        return device;
      }
    }
  } catch {
    // /dev/dri doesn't exist or isn't readable
  }
  return null;
};

const getHardwareDecodeArgs = async (gpu: GPUVendor, codec?: string): Promise<string[]> => {
  if (gpu === 'cpu') {
    return [];
  }

  const normalized = normalizeCodec(codec);
  if (!normalized) {
    return [];
  }

  if (process.platform === 'darwin') {
    if (gpu !== 'apple') return [];
    const decoder = VIDEOTOOLBOX_DECODERS[normalized];
    if (decoder && (await checkDecoderAvailable(decoder))) {
      return ['-hwaccel', 'videotoolbox', '-c:v', decoder];
    }
    return [];
  }

  if (process.platform === 'win32') {
    if (gpu === 'nvidia') {
      const decoder = NVIDIA_DECODERS[normalized];
      if (decoder && (await checkDecoderAvailable(decoder))) {
        return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', decoder];
      }
      return [];
    }

    if (gpu === 'intel') {
      const decoder = INTEL_DECODERS[normalized];
      if (decoder && (await checkDecoderAvailable(decoder))) {
        return ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-c:v', decoder];
      }
      return [];
    }

    if (gpu === 'amd') {
      const decoder = D3D11_DECODERS[normalized];
      if (decoder && (await checkDecoderAvailable(decoder))) {
        return ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11', '-c:v', decoder];
      }
      return [];
    }
  }

  if (process.platform === 'linux') {
    if (gpu === 'nvidia') {
      const decoder = NVIDIA_DECODERS[normalized];
      if (decoder && (await checkDecoderAvailable(decoder))) {
        return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', decoder];
      }
      return [];
    }

    if (gpu === 'intel') {
      const decoder = INTEL_DECODERS[normalized];
      if (decoder && (await checkDecoderAvailable(decoder))) {
        return ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-c:v', decoder];
      }
      return [];
    }

    if (gpu === 'amd') {
      const vaapiDevice = findVaapiDevice();
      if (
        vaapiDevice &&
        canAccessVaapiDevice(vaapiDevice) &&
        ['h264', 'hevc', 'av1', 'vp9'].includes(normalized)
      ) {
        return [
          '-hwaccel',
          'vaapi',
          '-hwaccel_device',
          vaapiDevice,
          '-hwaccel_output_format',
          'vaapi',
        ];
      }
      return [];
    }
  }

  return [];
};

const FFPROBE_TIMEOUT_MS = 30_000;

export const getVideoInfo = async (inputPath: string): Promise<VideoInfo> => {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ];

    const proc = spawn(getFFprobeBinaryPath(), args);
    let output = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ffprobe timed out'));
    }, FFPROBE_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          const videoStream = data.streams?.find(
            (s: { codec_type: string }) => s.codec_type === 'video'
          );
          resolve({
            duration: parseFloat(data.format?.duration || '0'),
            size: parseInt(data.format?.size || '0'),
            width: videoStream?.width || 0,
            height: videoStream?.height || 0,
            codec: videoStream?.codec_name || 'unknown',
            format: data.format?.format_name || 'unknown',
            pixFmt: videoStream?.pix_fmt || undefined,
            colorPrimaries: videoStream?.color_primaries || undefined,
            colorTransfer: videoStream?.color_transfer || undefined,
            colorSpace: videoStream?.color_space || undefined,
            colorRange: videoStream?.color_range || undefined,
          });
        } catch {
          reject(new Error('Failed to parse video info'));
        }
      } else {
        reject(new Error('Failed to get video info'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

export const getVideoDuration = async (inputPath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const args = [
      '-i',
      inputPath,
      '-show_entries',
      'format=duration',
      '-v',
      'quiet',
      '-of',
      'csv=p=0',
    ];

    const proc = spawn(getFFprobeBinaryPath(), args);
    let output = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ffprobe timed out'));
    }, FFPROBE_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const duration = parseFloat(output.trim());
        resolve(isNaN(duration) ? 0 : duration);
      } else {
        reject(new Error('Failed to get video duration'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

export const parseProgress = (line: string, totalDuration: number): ConversionProgress | null => {
  const frameMatch = line.match(/frame=\s*(\d+)/);
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  const timeMatch = line.match(/time=\s*([\d:.]+)/);
  const bitrateMatch = line.match(/bitrate=\s*([\d.]+\s*\w+)/);
  const speedMatch = line.match(/speed=\s*([\d.]+x)/);

  if (timeMatch) {
    const timeParts = timeMatch[1].split(':');
    // Support H:MM:SS, MM:SS, and bare-seconds formats from FFmpeg output
    const [p0, p1, p2] = timeParts.map((p) => parseFloat(p) || 0);
    const seconds =
      timeParts.length >= 3 ? p0 * 3600 + p1 * 60 + p2 : timeParts.length === 2 ? p0 * 60 + p1 : p0;

    const percent = totalDuration > 0 ? Math.min(100, (seconds / totalDuration) * 100) : 0;

    return {
      percent,
      frame: frameMatch ? parseInt(frameMatch[1]) : 0,
      fps: fpsMatch ? parseFloat(fpsMatch[1]) : 0,
      time: timeMatch[1],
      bitrate: bitrateMatch ? bitrateMatch[1] : 'N/A',
      speed: speedMatch ? speedMatch[1] : 'N/A',
    };
  }

  return null;
};

export const appendBoundedErrorOutput = (current: string, nextChunk: string): string => {
  if (!nextChunk) {
    return current;
  }
  const combined = current + nextChunk;
  if (combined.length <= MAX_ERROR_OUTPUT_CHARS) {
    return combined;
  }
  let start = combined.length - MAX_ERROR_OUTPUT_CHARS;
  // Don't split a UTF-16 surrogate pair at the cut boundary
  const c = combined.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) {
    start += 1;
  }
  return combined.slice(start);
};

export const shouldRetryWithSoftwareDecode = (errorOutput: string): boolean => {
  const lowered = errorOutput.toLowerCase();
  const inputErrorMarkers = [
    'error opening input',
    'no such file or directory',
    'invalid data found when processing input',
    'moov atom not found',
    'permission denied',
  ];
  if (inputErrorMarkers.some((marker) => lowered.includes(marker))) {
    return false;
  }
  const markers = [
    'hwaccel',
    'device setup failed',
    'failed setup for format',
    'no device available',
    'error while opening decoder',
    'hardware acceleration',
    'cannot load libmfx',
    'failed to initialise vaapi',
    'vaapi init',
    'vaapi device',
    'qsv init',
    'qsv session',
  ];
  return markers.some((marker) => lowered.includes(marker));
};

export const resolveUniqueOutputPath = (
  outputDir: string,
  outputBaseName: string,
  extension: string
): string => {
  const MAX_SUFFIX = 10000;
  let suffix = 0;
  while (suffix <= MAX_SUFFIX) {
    const suffixPart = suffix === 0 ? '' : `_${suffix}`;
    const candidate = path.join(outputDir, `${outputBaseName}_converted${suffixPart}.${extension}`);

    // Skip paths already claimed by an in-progress conversion in this process
    if ([...outputPathByProcess.values()].includes(candidate)) {
      suffix += 1;
      continue;
    }

    try {
      // Atomically claim the path: 'wx' (exclusive create) throws EEXIST if already present,
      // preventing a TOCTOU race with other processes writing to the same output directory.
      const fd = fs.openSync(candidate, 'wx');
      fs.closeSync(fd);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        suffix += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not find unique output path after ${MAX_SUFFIX} attempts`);
};

export const ensureMp4PlaybackCompatibilityArgs = (
  preset: Preset,
  presetArgs: string[]
): string[] => {
  if (preset.extension !== 'mp4' || presetArgs.length === 0) {
    return presetArgs;
  }

  const outputArg = presetArgs[presetArgs.length - 1];
  const argsWithoutOutput = [...presetArgs.slice(0, -1)];

  const movflagsIndex = argsWithoutOutput.findIndex((arg) => arg === '-movflags');
  if (movflagsIndex >= 0 && movflagsIndex + 1 < argsWithoutOutput.length) {
    const currentFlags = argsWithoutOutput[movflagsIndex + 1];
    if (!/\bfaststart\b/.test(currentFlags)) {
      argsWithoutOutput[movflagsIndex + 1] = `${currentFlags}+faststart`;
    }
  } else {
    argsWithoutOutput.push('-movflags', '+faststart');
  }

  if (preset.category === 'h265') {
    const hasHvc1Tag = argsWithoutOutput.some(
      (arg, index) => arg === '-tag:v' && argsWithoutOutput[index + 1] === 'hvc1'
    );
    if (!hasHvc1Tag) {
      argsWithoutOutput.push('-tag:v', 'hvc1');
    }
  }

  return [...argsWithoutOutput, outputArg];
};

/**
 * Returns true only for colour-space values that are safe to pass to FFmpeg.
 * FFprobe emits "unknown", "unspecified", or "reserved" for unset fields;
 * passing those strings to FFmpeg causes an "Invalid option" error.
 */
export const isKnownColorValue = (v: string): boolean =>
  v !== 'unknown' && v !== 'unspecified' && v !== 'reserved' && v.length > 0;

/**
 * Replaces the user's home-directory prefix in log output with `~` so that
 * absolute paths sent to the renderer don't reveal the system username.
 */
const HOME_DIR = os.homedir();
export const redactPaths = (s: string): string => {
  if (!HOME_DIR || !s.includes(HOME_DIR)) return s;
  return s.split(HOME_DIR).join('~');
};

export const convertVideo = async (
  inputPath: string,
  outputDir: string,
  preset: Preset,
  gpu: GPUVendor,
  onProgress: (progress: ConversionProgress) => void,
  onLog?: (message: string) => void,
  options: ConvertVideoOptions = {}
): Promise<ConversionResult> => {
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const basenameWithoutSpaces = inputBasename.replace(/\s+/g, '');
  const outputBaseName =
    options.removeSpacesFromOutputName && basenameWithoutSpaces.length > 0
      ? basenameWithoutSpaces
      : inputBasename;
  try {
    fs.accessSync(outputDir, fs.constants.W_OK);
  } catch {
    return {
      success: false,
      outputPath: '',
      error: `Output directory is not writable: ${outputDir}`,
    };
  }

  const outputPath = resolveUniqueOutputPath(outputDir, outputBaseName, preset.extension);

  let totalDuration = 0;
  let inputCodec: string | undefined;
  let videoInfo: VideoInfo | null = null;
  try {
    videoInfo = await getVideoInfo(inputPath);
    totalDuration = Number.isFinite(videoInfo.duration) ? videoInfo.duration : 0;
    inputCodec = videoInfo.codec;
  } catch {
    // ignore
  }
  if (totalDuration <= 0) {
    try {
      totalDuration = await getVideoDuration(inputPath);
    } catch {
      console.warn('Could not get video duration, progress may be inaccurate');
    }
  }

  // Warn if disk space on output volume looks tight (non-fatal)
  try {
    const inputStat = fs.statSync(inputPath);
    const dirStats = fs.statfsSync(outputDir);
    const freeBytes = dirStats.bavail * dirStats.bsize;
    if (freeBytes < inputStat.size) {
      onLog?.(
        `Warning: Low disk space – available: ${Math.round(freeBytes / 1024 / 1024)} MB, input size: ${Math.round(inputStat.size / 1024 / 1024)} MB\n`
      );
    }
  } catch {
    // statfs unavailable or failed – skip check
  }

  const isVideoPreset =
    getPresetGpuCodec(
      preset,
      options.advancedFormatSettings
        ? { advancedFormatSettings: options.advancedFormatSettings }
        : undefined
    ) !== null;
  const shouldUseHardwareDecode =
    isVideoPreset && !(options.useCpuDecodingWhenGpu === true && gpu !== 'cpu');
  const decodeArgs = shouldUseHardwareDecode ? await getHardwareDecodeArgs(gpu, inputCodec) : [];
  const presetContext = options.advancedFormatSettings
    ? { advancedFormatSettings: options.advancedFormatSettings }
    : undefined;
  let presetArgs = ensureMp4PlaybackCompatibilityArgs(
    preset,
    preset.getArgs(inputPath, outputPath, gpu, presetContext)
  );

  // Inject color metadata passthrough and pix_fmt for video encodes (skip remux/audio/gif)
  if (isVideoPreset && videoInfo && presetArgs.length > 0) {
    const extraArgs: string[] = [];
    if (videoInfo.colorPrimaries && isKnownColorValue(videoInfo.colorPrimaries))
      extraArgs.push('-color_primaries', videoInfo.colorPrimaries);
    if (videoInfo.colorTransfer && isKnownColorValue(videoInfo.colorTransfer))
      extraArgs.push('-color_trc', videoInfo.colorTransfer);
    if (videoInfo.colorSpace && isKnownColorValue(videoInfo.colorSpace))
      extraArgs.push('-colorspace', videoInfo.colorSpace);
    if (videoInfo.colorRange && isKnownColorValue(videoInfo.colorRange))
      extraArgs.push('-color_range', videoInfo.colorRange);

    // Preserve 10-bit depth for CPU H.265/AV1 encodes. H.264 CPU is already locked to
    // yuv420p in the preset builder. Hardware encoders manage their own pixel format pipeline.
    const is10bitSource =
      videoInfo.pixFmt !== undefined &&
      (videoInfo.pixFmt.includes('10') || videoInfo.pixFmt.includes('12'));
    if (
      gpu === 'cpu' &&
      is10bitSource &&
      (preset.category === 'h265' || preset.category === 'av1')
    ) {
      extraArgs.push('-pix_fmt', 'yuv420p10le');
    }

    if (extraArgs.length > 0) {
      presetArgs = [...presetArgs.slice(0, -1), ...extraArgs, presetArgs[presetArgs.length - 1]];
    }
  }
  const tryDeleteOutputFile = (filePath: string | undefined, label: string): void => {
    if (!filePath) return;
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to delete ${label}:`, err);
      }
    }
  };

  let conversionCanceled = false;
  const runAttempt = async (
    activeDecodeArgs: string[],
    allowRetry: boolean
  ): Promise<ConversionResult> => {
    const args = ['-y', '-progress', 'pipe:1', ...activeDecodeArgs, ...presetArgs];

    if (onLog) {
      onLog(`Running command: ffmpeg ${args.join(' ')}\n`);
    }

    return new Promise((resolve) => {
      const ffmpegProcess = spawn(
        getFFmpegBinaryPath(),
        args,
        process.platform !== 'win32' ? { detached: true } : {}
      );
      currentProcess = ffmpegProcess;
      outputPathByProcess.set(ffmpegProcess, outputPath);

      let errorOutput = '';
      let lastProgressEmitAt = 0;
      let pendingProgress: ConversionProgress | null = null;
      let pendingProgressTimer: NodeJS.Timeout | null = null;

      const emitProgressThrottled = (progress: ConversionProgress): void => {
        const now = Date.now();
        const elapsed = now - lastProgressEmitAt;
        if (
          lastProgressEmitAt === 0 ||
          elapsed >= MAX_PROGRESS_EMIT_INTERVAL_MS ||
          progress.percent >= 100
        ) {
          if (pendingProgressTimer) {
            clearTimeout(pendingProgressTimer);
            pendingProgressTimer = null;
          }
          pendingProgress = null;
          lastProgressEmitAt = now;
          onProgress(progress);
          return;
        }

        pendingProgress = progress;
        if (!pendingProgressTimer) {
          pendingProgressTimer = setTimeout(() => {
            pendingProgressTimer = null;
            if (pendingProgress) {
              lastProgressEmitAt = Date.now();
              onProgress(pendingProgress);
              pendingProgress = null;
            }
          }, MAX_PROGRESS_EMIT_INTERVAL_MS - elapsed);
        }
      };

      const flushAndCleanupProgressTimer = (): void => {
        if (pendingProgressTimer) {
          clearTimeout(pendingProgressTimer);
          pendingProgressTimer = null;
        }
        if (pendingProgress) {
          onProgress(pendingProgress);
          pendingProgress = null;
        }
      };

      ffmpegProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        if (onLog) onLog(output);

        const lines = output.split('\n');
        for (const line of lines) {
          if (!line.includes('out_time_ms=')) {
            continue;
          }
          const rawTimeMs = line.split('=')[1];
          const timeMs = parseInt(rawTimeMs, 10);
          if (!Number.isFinite(timeMs) || timeMs < 0) {
            continue;
          }
          const seconds = timeMs / 1000000;
          const percent = totalDuration > 0 ? Math.min(100, (seconds / totalDuration) * 100) : 0;
          emitProgressThrottled({
            percent,
            frame: 0,
            fps: 0,
            time: formatTime(seconds),
            bitrate: 'N/A',
            speed: 'N/A',
          });
        }
      });

      ffmpegProcess.stderr?.on('data', (data) => {
        const line = data.toString();
        if (onLog) onLog(line);
        errorOutput = appendBoundedErrorOutput(errorOutput, line);

        const progress = parseProgress(line, totalDuration);
        if (progress) {
          emitProgressThrottled(progress);
        }
      });

      ffmpegProcess.on('close', async (code) => {
        flushAndCleanupProgressTimer();
        if (currentProcess === ffmpegProcess) {
          currentProcess = null;
        }
        // Clear any pending force-kill timer; process already exited
        const forceKillTimer = pendingForceKillTimers.get(ffmpegProcess);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
          pendingForceKillTimers.delete(ffmpegProcess);
        }
        const outputToDelete = outputPathByProcess.get(ffmpegProcess);
        outputPathByProcess.delete(ffmpegProcess);
        const wasCanceled = canceledProcesses.has(ffmpegProcess);
        canceledProcesses.delete(ffmpegProcess);
        if (wasCanceled) {
          conversionCanceled = true;
          tryDeleteOutputFile(outputToDelete, 'partial output file');
          resolve({ success: false, outputPath, error: 'Conversion cancelled' });
          return;
        }

        if (code === 0) {
          resolve({ success: true, outputPath });
          return;
        }

        tryDeleteOutputFile(outputToDelete, 'failed output file');

        if (
          !conversionCanceled &&
          allowRetry &&
          activeDecodeArgs.length > 0 &&
          shouldRetryWithSoftwareDecode(errorOutput)
        ) {
          if (onLog) {
            onLog('Hardware decode failed; retrying with software decode.\n');
          }
          const retried = await runAttempt([], false);
          resolve(retried);
          return;
        }

        resolve({ success: false, outputPath, error: errorOutput });
      });

      ffmpegProcess.on('error', (err) => {
        flushAndCleanupProgressTimer();
        if (currentProcess === ffmpegProcess) {
          currentProcess = null;
        }
        const forceKillTimer = pendingForceKillTimers.get(ffmpegProcess);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
          pendingForceKillTimers.delete(ffmpegProcess);
        }
        const outputToDelete = outputPathByProcess.get(ffmpegProcess);
        outputPathByProcess.delete(ffmpegProcess);
        const wasCanceled = canceledProcesses.has(ffmpegProcess);
        canceledProcesses.delete(ffmpegProcess);
        if (wasCanceled) {
          conversionCanceled = true;
          tryDeleteOutputFile(outputToDelete, 'partial output file');
          resolve({ success: false, outputPath, error: 'Conversion cancelled' });
          return;
        }
        tryDeleteOutputFile(outputToDelete, 'failed output file');
        resolve({ success: false, outputPath, error: err.message });
      });
    });
  };

  return runAttempt(decodeArgs, true);
};

const forceKillProcess = (processToKill: ChildProcess): void => {
  if (processToKill.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32' && processToKill.pid) {
    try {
      spawnSync(WINDOWS_TASKKILL_PATH, ['/pid', processToKill.pid.toString(), '/t', '/f'], {
        windowsHide: true,
      });
    } catch {
      try {
        processToKill.kill('SIGKILL');
      } catch {
        return;
      }
    }
    return;
  }

  // POSIX: kill entire process group to reap any sub-spawned children
  if (processToKill.pid) {
    try {
      process.kill(-processToKill.pid, 'SIGKILL');
      return;
    } catch {
      // fall through to direct kill if group kill fails (e.g. process already exited)
    }
  }

  try {
    processToKill.kill('SIGKILL');
  } catch {
    return;
  }
};

export const cancelConversion = (force = false): void => {
  if (currentProcess) {
    const processToKill = currentProcess;
    canceledProcesses.add(processToKill);

    if (!force) {
      try {
        processToKill.stdin?.write('q');
        processToKill.stdin?.end();
      } catch {}
    }

    try {
      processToKill.kill('SIGTERM');
    } catch {
      if (force) {
        forceKillProcess(processToKill);
        return;
      }
    }

    if (force) {
      forceKillProcess(processToKill);
      return;
    }

    const forceKillTimer = setTimeout(() => {
      pendingForceKillTimers.delete(processToKill);
      if (currentProcess === processToKill && processToKill.exitCode === null) {
        forceKillProcess(processToKill);
      }
    }, 1500);
    pendingForceKillTimers.set(processToKill, forceKillTimer);
  }
};

export const waitForConversionStop = async (timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (currentProcess && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return currentProcess === null;
};

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};
