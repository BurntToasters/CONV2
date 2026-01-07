import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { GPUVendor, Preset } from './presets';
import { getFFmpegPath, getFFprobePath } from './ffmpegPath';

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
}

export interface VideoInfo {
  duration: number;
  size: number;
  width: number;
  height: number;
  codec: string;
  format: string;
}

let currentProcess: ChildProcess | null = null;
const outputPathByProcess = new Map<ChildProcess, string>();
const canceledProcesses = new Set<ChildProcess>();

export const checkFFmpegInstalled = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    const process = spawn(getFFmpegPath(), ['-version']);
    process.on('close', (code) => {
      resolve(code === 0);
    });
    process.on('error', () => {
      resolve(false);
    });
  });
};

let encoderCache: Set<string> | null = null;
let decoderCache: Set<string> | null = null;

export const getAvailableEncoders = async (): Promise<Set<string>> => {
  if (encoderCache) {
    return encoderCache;
  }

  return new Promise((resolve) => {
    const process = spawn(getFFmpegPath(), ['-encoders', '-hide_banner']);
    let output = '';

    process.stdout?.on('data', (data) => {
      output += data.toString();
    });

    process.on('close', () => {
      const encoders = new Set<string>();
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*[VASFXBD.]+\s+(\S+)/);
        if (match && match[1]) {
          encoders.add(match[1]);
        }
      }
      encoderCache = encoders;
      resolve(encoders);
    });

    process.on('error', () => {
      resolve(new Set());
    });
  });
};

export const checkEncoderAvailable = async (encoder: string): Promise<boolean> => {
  const encoders = await getAvailableEncoders();
  return encoders.has(encoder);
};

export const getAvailableDecoders = async (): Promise<Set<string>> => {
  if (decoderCache) {
    return decoderCache;
  }

  return new Promise((resolve) => {
    const process = spawn(getFFmpegPath(), ['-decoders', '-hide_banner']);
    let output = '';

    process.stdout?.on('data', (data) => {
      output += data.toString();
    });

    process.on('close', () => {
      const decoders = new Set<string>();
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*[VASFXBD.]+\s+(\S+)/);
        if (match && match[1]) {
          decoders.add(match[1]);
        }
      }
      decoderCache = decoders;
      resolve(decoders);
    });

    process.on('error', () => {
      resolve(new Set());
    });
  });
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

  const available = await checkEncoderAvailable(encoder);
  if (!available) {
    return {
      available: false,
      encoder,
      error: {
        type: 'encoder_unavailable',
        message: `${GPU_NAMES[gpu]} ${CODEC_NAMES[codec]} encoder not available`,
        details: `The encoder "${encoder}" was not found in your FFmpeg installation. This could mean:\n• Your GPU drivers don't support this codec\n• FFmpeg wasn't compiled with ${GPU_NAMES[gpu]} support\n• The required libraries are missing`,
        suggestion: gpu === 'nvidia' && codec === 'av1'
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

export const parseGPUError = (errorOutput: string, gpu: GPUVendor, codec?: string): GPUEncoderError | null => {
  const gpuName = GPU_NAMES[gpu];
  const codecName = codec ? CODEC_NAMES[codec] || codec : 'video';

  // NVIDIA specific errors
  if (gpu === 'nvidia') {
    if (errorOutput.includes('No capable devices found') ||
        errorOutput.includes('Cannot load nvEncodeAPI') ||
        errorOutput.includes('nvEncodeAPICreateInstance failed')) {
      return {
        type: 'gpu_capability',
        message: `${gpuName} encoder initialization failed`,
        details: 'FFmpeg could not initialize the NVIDIA encoder. This usually means:\n• Your GPU doesn\'t support hardware encoding\n• NVIDIA drivers are not installed or outdated\n• Another application is using the encoder',
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
        details: codec === 'av1'
          ? 'AV1 hardware encoding requires an RTX 40-series (Ada Lovelace) GPU or newer.'
          : `Your GPU model doesn't support hardware ${codecName} encoding.`,
        suggestion: codec === 'av1'
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
    if (errorOutput.includes('AMF') && (errorOutput.includes('failed') || errorOutput.includes('error'))) {
      return {
        type: 'gpu_capability',
        message: `${gpuName} encoder initialization failed`,
        details: 'FFmpeg could not initialize the AMD AMF encoder. This usually means:\n• Your GPU doesn\'t support AMF encoding\n• AMD drivers are not installed or outdated',
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
        details: codec === 'av1'
          ? 'AV1 hardware encoding requires an RX 7000 series (RDNA 3) GPU or newer.'
          : `Your GPU model doesn't support hardware ${codecName} encoding.`,
        suggestion: codec === 'av1'
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
    if (errorOutput.includes('QSV') && (errorOutput.includes('failed') || errorOutput.includes('error') || errorOutput.includes('not found'))) {
      return {
        type: 'gpu_capability',
        message: `${gpuName} Quick Sync encoder not available`,
        details: 'FFmpeg could not initialize Intel Quick Sync Video. This usually means:\n• Your CPU/GPU doesn\'t support Quick Sync\n• Intel graphics drivers are not installed\n• Quick Sync is disabled in BIOS',
        suggestion: 'Ensure Intel graphics drivers are installed and Quick Sync is enabled in BIOS, or try CPU encoding.',
        canRetryWithCPU: true,
        codec,
        gpu,
      };
    }
  }

  // Apple specific errors
  if (gpu === 'apple') {
    if (errorOutput.includes('videotoolbox') && (errorOutput.includes('failed') || errorOutput.includes('error'))) {
      return {
        type: 'gpu_capability',
        message: 'VideoToolbox encoder not available',
        details: 'FFmpeg could not initialize Apple VideoToolbox. This usually means:\n• Your Mac doesn\'t support hardware encoding for this codec\n• macOS version doesn\'t support this encoder',
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

const getHardwareDecodeArgs = async (
  gpu: GPUVendor,
  codec?: string
): Promise<string[]> => {
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
    if (decoder && await checkDecoderAvailable(decoder)) {
      return ['-hwaccel', 'videotoolbox', '-c:v', decoder];
    }
    return ['-hwaccel', 'videotoolbox'];
  }

  if (process.platform === 'win32') {
    if (gpu === 'nvidia') {
      const decoder = NVIDIA_DECODERS[normalized];
      if (decoder && await checkDecoderAvailable(decoder)) {
        return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', decoder];
      }
      return [];
    }

    if (gpu === 'intel') {
      const decoder = INTEL_DECODERS[normalized];
      if (decoder && await checkDecoderAvailable(decoder)) {
        return ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-c:v', decoder];
      }
      return [];
    }

    if (gpu === 'amd') {
      const decoder = D3D11_DECODERS[normalized];
      if (decoder && await checkDecoderAvailable(decoder)) {
        return ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11', '-c:v', decoder];
      }
      return [];
    }
  }

  if (process.platform === 'linux') {
    if (gpu === 'nvidia') {
      const decoder = NVIDIA_DECODERS[normalized];
      if (decoder && await checkDecoderAvailable(decoder)) {
        return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', decoder];
      }
      return [];
    }

    if (gpu === 'amd' || gpu === 'intel') {
      const vaapiDevice = '/dev/dri/renderD128';
      if (fs.existsSync(vaapiDevice) && ['h264', 'hevc', 'av1', 'vp9'].includes(normalized)) {
        return ['-hwaccel', 'vaapi', '-hwaccel_device', vaapiDevice, '-hwaccel_output_format', 'vaapi'];
      }
      return [];
    }
  }

  return [];
};

export const getVideoInfo = async (inputPath: string): Promise<VideoInfo> => {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ];

    const process = spawn(getFFprobePath(), args);
    let output = '';

    process.stdout.on('data', (data) => {
      output += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
          resolve({
            duration: parseFloat(data.format?.duration || '0'),
            size: parseInt(data.format?.size || '0'),
            width: videoStream?.width || 0,
            height: videoStream?.height || 0,
            codec: videoStream?.codec_name || 'unknown',
            format: data.format?.format_name || 'unknown',
          });
        } catch {
          reject(new Error('Failed to parse video info'));
        }
      } else {
        reject(new Error('Failed to get video info'));
      }
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
};

export const getVideoDuration = async (inputPath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-show_entries', 'format=duration',
      '-v', 'quiet',
      '-of', 'csv=p=0'
    ];

    const process = spawn(getFFprobePath(), args);
    let output = '';

    process.stdout.on('data', (data) => {
      output += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        const duration = parseFloat(output.trim());
        resolve(isNaN(duration) ? 0 : duration);
      } else {
        reject(new Error('Failed to get video duration'));
      }
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
};

const parseProgress = (line: string, totalDuration: number): ConversionProgress | null => {
  const frameMatch = line.match(/frame=\s*(\d+)/);
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  const timeMatch = line.match(/time=\s*([\d:.]+)/);
  const bitrateMatch = line.match(/bitrate=\s*([\d.]+\s*\w+)/);
  const speedMatch = line.match(/speed=\s*([\d.]+x)/);

  if (timeMatch) {
    const timeParts = timeMatch[1].split(':');
    const seconds =
      parseFloat(timeParts[0]) * 3600 +
      parseFloat(timeParts[1]) * 60 +
      parseFloat(timeParts[2]);

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

export const convertVideo = async (
  inputPath: string,
  outputDir: string,
  preset: Preset,
  gpu: GPUVendor,
  onProgress: (progress: ConversionProgress) => void,
  onLog?: (message: string) => void
): Promise<ConversionResult> => {
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outputDir, `${inputBasename}_converted.${preset.extension}`);

  let totalDuration = 0;
  let inputCodec: string | undefined;
  try {
    const info = await getVideoInfo(inputPath);
    totalDuration = info.duration;
    inputCodec = info.codec;
  } catch {
    try {
      totalDuration = await getVideoDuration(inputPath);
    } catch {
      console.warn('Could not get video duration, progress may be inaccurate');
    }
  }

  const isVideoPreset = ['av1', 'h264', 'h265'].includes(preset.category);
  const decodeArgs = isVideoPreset ? await getHardwareDecodeArgs(gpu, inputCodec) : [];
  const args = ['-y', '-progress', 'pipe:1', ...decodeArgs, ...preset.getArgs(inputPath, outputPath, gpu)];
  
  if (onLog) {
    onLog(`Running command: ffmpeg ${args.join(' ')}\n`);
  }

  return new Promise((resolve) => {
    const ffmpegProcess = spawn(getFFmpegPath(), args);
    currentProcess = ffmpegProcess;
    outputPathByProcess.set(ffmpegProcess, outputPath);

    let errorOutput = '';

    ffmpegProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      if (onLog) onLog(output);
      
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('out_time_ms=')) {
          const timeMs = parseInt(line.split('=')[1]);
          const seconds = timeMs / 1000000;
          const percent = totalDuration > 0 ? Math.min(100, (seconds / totalDuration) * 100) : 0;
          onProgress({
            percent,
            frame: 0,
            fps: 0,
            time: formatTime(seconds),
            bitrate: 'N/A',
            speed: 'N/A',
          });
        }
      }
    });

    ffmpegProcess.stderr?.on('data', (data) => {
      const line = data.toString();
      if (onLog) onLog(line);
      errorOutput += line;

      const progress = parseProgress(line, totalDuration);
      if (progress) {
        onProgress(progress);
      }
    });

    ffmpegProcess.on('close', (code) => {
      if (currentProcess === ffmpegProcess) {
        currentProcess = null;
      }
      const outputToDelete = outputPathByProcess.get(ffmpegProcess);
      outputPathByProcess.delete(ffmpegProcess);
      const wasCanceled = canceledProcesses.has(ffmpegProcess);
      canceledProcesses.delete(ffmpegProcess);
      if (wasCanceled) {
        if (outputToDelete && fs.existsSync(outputToDelete)) {
          try {
            fs.unlinkSync(outputToDelete);
          } catch (err) {
            console.error('Failed to delete partial file:', err);
          }
        }
        resolve({ success: false, outputPath, error: 'Conversion cancelled' });
        return;
      }
      if (code === 0) {
        resolve({ success: true, outputPath });
      } else {
        resolve({ success: false, outputPath, error: errorOutput });
      }
    });

    ffmpegProcess.on('error', (err) => {
      if (currentProcess === ffmpegProcess) {
        currentProcess = null;
      }
      const outputToDelete = outputPathByProcess.get(ffmpegProcess);
      outputPathByProcess.delete(ffmpegProcess);
      const wasCanceled = canceledProcesses.has(ffmpegProcess);
      canceledProcesses.delete(ffmpegProcess);
      if (wasCanceled) {
        if (outputToDelete && fs.existsSync(outputToDelete)) {
          try {
            fs.unlinkSync(outputToDelete);
          } catch (deleteErr) {
            console.error('Failed to delete partial file:', deleteErr);
          }
        }
        resolve({ success: false, outputPath, error: 'Conversion cancelled' });
        return;
      }
      resolve({ success: false, outputPath, error: err.message });
    });
  });
};

const forceKillProcess = (processToKill: ChildProcess): void => {
  if (processToKill.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32' && processToKill.pid) {
    try {
      spawnSync('taskkill', ['/pid', processToKill.pid.toString(), '/t', '/f'], { windowsHide: true });
    } catch {
      try {
        processToKill.kill('SIGKILL');
      } catch {
        return;
      }
    }
    return;
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

    try {
      processToKill.stdin?.write('q');
      processToKill.stdin?.end();
    } catch {
    }

    try {
      processToKill.kill('SIGTERM');
    } catch {
      if (force) {
        forceKillProcess(processToKill);
      }
    }

    if (force) {
      forceKillProcess(processToKill);
      return;
    }

    setTimeout(() => {
      if (currentProcess === processToKill && processToKill.exitCode === null) {
        forceKillProcess(processToKill);
      }
    }, 1500);
  }
};

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};
