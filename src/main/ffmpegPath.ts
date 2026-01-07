import * as path from 'path';
import * as fs from 'fs';

let cachedFFmpegPath: string | null = null;
let cachedFFprobePath: string | null = null;
let useSystemFFmpeg = false;

const ensureExecutable = (filePath: string): void => {
  if (process.platform === 'win32') {
    return;
  }

  try {
    const stats = fs.statSync(filePath);
    const isExecutable = (stats.mode & 0o111) !== 0;

    if (!isExecutable) {
      fs.chmodSync(filePath, stats.mode | 0o755);
    }
  } catch {
  }
};

export const setUseSystemFFmpeg = (value: boolean): void => {
  useSystemFFmpeg = value;
  cachedFFmpegPath = null;
  cachedFFprobePath = null;
};

const getBundledFFmpegDir = (): string | null => {
  if (typeof process.resourcesPath !== 'string') {
    return null;
  }

  const baseDir = path.join(process.resourcesPath, 'ffmpeg');

  if (process.platform === 'darwin' || process.platform === 'win32') {
    const archDir = path.join(baseDir, process.arch);
    if (fs.existsSync(archDir)) {
      return archDir;
    }
    // Fallback
    const x64Dir = path.join(baseDir, 'x64');
    if (process.arch === 'x64' && fs.existsSync(x64Dir)) {
      return x64Dir;
    }
    const arm64Dir = path.join(baseDir, 'arm64');
    if (process.arch === 'arm64' && fs.existsSync(arm64Dir)) {
      return arm64Dir;
    }
  }

  if (fs.existsSync(baseDir)) {
    return baseDir;
  }

  return null;
};

export const getFFmpegPath = (): string => {
  if (cachedFFmpegPath !== null) {
    return cachedFFmpegPath;
  }

  if (useSystemFFmpeg) {
    cachedFFmpegPath = 'ffmpeg';
    return 'ffmpeg';
  }

  const bundledDir = getBundledFFmpegDir();
  if (bundledDir) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const bundledPath = path.join(bundledDir, `ffmpeg${ext}`);
    if (fs.existsSync(bundledPath)) {
      ensureExecutable(bundledPath);
      cachedFFmpegPath = bundledPath;
      return bundledPath;
    }
  }

  cachedFFmpegPath = 'ffmpeg';
  return 'ffmpeg';
};

export const getFFprobePath = (): string => {
  if (cachedFFprobePath !== null) {
    return cachedFFprobePath;
  }

  if (useSystemFFmpeg) {
    cachedFFprobePath = 'ffprobe';
    return 'ffprobe';
  }

  const bundledDir = getBundledFFmpegDir();
  if (bundledDir) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const bundledPath = path.join(bundledDir, `ffprobe${ext}`);
    if (fs.existsSync(bundledPath)) {
      ensureExecutable(bundledPath);
      cachedFFprobePath = bundledPath;
      return bundledPath;
    }
  }

  cachedFFprobePath = 'ffprobe';
  return 'ffprobe';
};

export const hasBundledFFmpeg = (): boolean => {
  const ffmpegPath = getFFmpegPath();
  return ffmpegPath !== 'ffmpeg';
};

export const clearFFmpegPathCache = (): void => {
  cachedFFmpegPath = null;
  cachedFFprobePath = null;
};
