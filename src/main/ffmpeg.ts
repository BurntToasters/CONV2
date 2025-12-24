import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { GPUVendor, Preset } from './presets';

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

let currentProcess: ChildProcess | null = null;

export const checkFFmpegInstalled = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    const process = spawn('ffmpeg', ['-version'], { shell: true });
    process.on('close', (code) => {
      resolve(code === 0);
    });
    process.on('error', () => {
      resolve(false);
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

    const process = spawn('ffprobe', args, { shell: true });
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
  onProgress: (progress: ConversionProgress) => void
): Promise<ConversionResult> => {
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outputDir, `${inputBasename}_converted.${preset.extension}`);

  let totalDuration = 0;
  try {
    totalDuration = await getVideoDuration(inputPath);
  } catch {
    console.warn('Could not get video duration, progress may be inaccurate');
  }

  const args = ['-y', '-progress', 'pipe:1', ...preset.getArgs(inputPath, outputPath, gpu)];

  return new Promise((resolve) => {
    currentProcess = spawn('ffmpeg', args, { shell: true });

    let errorOutput = '';

    currentProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
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

    currentProcess.stderr?.on('data', (data) => {
      const line = data.toString();
      errorOutput += line;

      const progress = parseProgress(line, totalDuration);
      if (progress) {
        onProgress(progress);
      }
    });

    currentProcess.on('close', (code) => {
      currentProcess = null;
      if (code === 0) {
        resolve({ success: true, outputPath });
      } else {
        resolve({ success: false, outputPath, error: errorOutput });
      }
    });

    currentProcess.on('error', (err) => {
      currentProcess = null;
      resolve({ success: false, outputPath, error: err.message });
    });
  });
};

export const cancelConversion = (): void => {
  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
  }
};

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};
