import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import {
  copyExecutableToPrivateDirectory,
  createPrivateExecutableDirectory,
  removePrivateExecutableDirectory,
} from './executableTemp';
import {
  bundledBinaryFileName,
  bundledFFmpegRelDirs,
  resolveExecutableOnPath,
} from './ffmpegPathCandidates';

let cachedFFmpegPath: string | null = null;
let cachedFFprobePath: string | null = null;
let useSystemFFmpeg = false;
let privateExecutableDirectory: string | null = null;

const getPrivateExecutableDirectory = (): string => {
  if (privateExecutableDirectory) {
    return privateExecutableDirectory;
  }

  privateExecutableDirectory = createPrivateExecutableDirectory(app.getPath('temp'));
  app.once('will-quit', () => {
    try {
      removePrivateExecutableDirectory(privateExecutableDirectory);
    } catch (error) {
      console.warn('Failed to remove temporary FFmpeg directory:', error);
    } finally {
      privateExecutableDirectory = null;
    }
  });
  return privateExecutableDirectory;
};

/**
 * Ensures the binary at filePath is executable. Returns the path to use —
 * this may differ from the input on read-only filesystems (e.g. Linux AppImage)
 * where the binary is copied to a writable temp directory first.
 */
const ensureExecutable = (filePath: string): string => {
  if (process.platform === 'win32') {
    return filePath;
  }

  try {
    const stats = fs.statSync(filePath);
    const isExecutable = (stats.mode & 0o111) !== 0;

    if (!isExecutable) {
      try {
        fs.chmodSync(filePath, stats.mode | 0o755);
      } catch (chmodErr) {
        const code = (chmodErr as NodeJS.ErrnoException).code;
        if (code === 'EROFS' || code === 'EACCES') {
          // Read-only filesystem (e.g. Linux AppImage) — check if already executable
          try {
            fs.accessSync(filePath, fs.constants.X_OK);
            // Already executable despite mode bits — use as-is
          } catch {
            // Not executable and can't chmod in place — copy to temp and chmod there
            return copyExecutableToPrivateDirectory(filePath, getPrivateExecutableDirectory());
          }
        }
        // Other errors: ignore and continue with the original path
      }
    }
  } catch {
    // statSync failed — ignore
  }

  return filePath;
};

export const setUseSystemFFmpeg = (value: boolean): void => {
  useSystemFFmpeg = value;
  cachedFFmpegPath = null;
  cachedFFprobePath = null;
};

let ffmpegOverride: string | null = null;
let ffprobeOverride: string | null = null;

/** Absolute binaries from resolveDevOverrides; take precedence over bundled/system lookup. */
export const setFFmpegBinaryOverrides = (ffmpeg?: string, ffprobe?: string): void => {
  ffmpegOverride = ffmpeg ?? null;
  ffprobeOverride = ffprobe ?? null;
  cachedFFmpegPath = null;
  cachedFFprobePath = null;
};

const getBundledFFmpegDir = (): string | null => {
  const candidateBaseDirs: string[] = [];

  if (typeof process.resourcesPath === 'string') {
    candidateBaseDirs.push(
      path.join(process.resourcesPath, 'ffmpeg'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'ffmpeg')
    );
  }

  const appPath = app.getAppPath();
  candidateBaseDirs.push(
    path.join(appPath, 'resources', 'ffmpeg'),
    path.resolve(appPath, '..', 'resources', 'ffmpeg'),
    path.resolve(appPath, '..', 'ffmpeg')
  );

  const seen = new Set<string>();
  const ffmpegName = bundledBinaryFileName(process.platform, 'ffmpeg');

  for (const baseDir of candidateBaseDirs) {
    const normalizedBaseDir = path.resolve(baseDir);
    if (seen.has(normalizedBaseDir)) {
      continue;
    }
    seen.add(normalizedBaseDir);

    if (!fs.existsSync(normalizedBaseDir)) {
      continue;
    }

    for (const relDir of bundledFFmpegRelDirs(process.platform, process.arch)) {
      const candidateDir = relDir ? path.join(normalizedBaseDir, relDir) : normalizedBaseDir;
      if (fs.existsSync(path.join(candidateDir, ffmpegName))) {
        return candidateDir;
      }
    }
  }

  return null;
};

const getMissingBundledBinaryPath = (binaryName: 'ffmpeg' | 'ffprobe'): string => {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const basePath =
    typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : path.dirname(app.getAppPath());
  return path.join(basePath, 'ffmpeg', `__missing_${binaryName}${ext}`);
};

export const getFFmpegPath = (): string => {
  if (cachedFFmpegPath !== null) {
    return cachedFFmpegPath;
  }

  if (ffmpegOverride) {
    cachedFFmpegPath = ffmpegOverride;
    return ffmpegOverride;
  }

  if (useSystemFFmpeg) {
    // Pin one absolute binary so later PATH changes cannot swap it mid-session.
    cachedFFmpegPath = resolveExecutableOnPath('ffmpeg', process.env) ?? 'ffmpeg';
    return cachedFFmpegPath;
  }

  const bundledDir = getBundledFFmpegDir();
  if (bundledDir) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const bundledPath = path.join(bundledDir, `ffmpeg${ext}`);
    if (fs.existsSync(bundledPath)) {
      const effectivePath = ensureExecutable(bundledPath);
      cachedFFmpegPath = effectivePath;
      return effectivePath;
    }
  }

  if (app.isPackaged) {
    const missingBundledPath = getMissingBundledBinaryPath('ffmpeg');
    console.error(
      `Bundled ffmpeg binary not found in packaged app. Expected under resources/ffmpeg for ${process.platform}/${process.arch}.`
    );
    cachedFFmpegPath = missingBundledPath;
    return missingBundledPath;
  }

  cachedFFmpegPath = 'ffmpeg';
  return 'ffmpeg';
};

export const getFFprobePath = (): string => {
  if (cachedFFprobePath !== null) {
    return cachedFFprobePath;
  }

  if (ffprobeOverride) {
    cachedFFprobePath = ffprobeOverride;
    return ffprobeOverride;
  }

  if (useSystemFFmpeg) {
    // Pin one absolute binary so later PATH changes cannot swap it mid-session.
    cachedFFprobePath = resolveExecutableOnPath('ffprobe', process.env) ?? 'ffprobe';
    return cachedFFprobePath;
  }

  const bundledDir = getBundledFFmpegDir();
  if (bundledDir) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const bundledPath = path.join(bundledDir, `ffprobe${ext}`);
    if (fs.existsSync(bundledPath)) {
      const effectivePath = ensureExecutable(bundledPath);
      cachedFFprobePath = effectivePath;
      return effectivePath;
    }
  }

  if (app.isPackaged) {
    const missingBundledPath = getMissingBundledBinaryPath('ffprobe');
    console.error(
      `Bundled ffprobe binary not found in packaged app. Expected under resources/ffmpeg for ${process.platform}/${process.arch}.`
    );
    cachedFFprobePath = missingBundledPath;
    return missingBundledPath;
  }

  cachedFFprobePath = 'ffprobe';
  return 'ffprobe';
};

/** Bundled binaries are checksum-verified; system and dev-override binaries are the user's choice. */
export const isUsingBundledFFmpeg = (): boolean => !useSystemFFmpeg && !ffmpegOverride;

export const clearFFmpegPathCache = (): void => {
  cachedFFmpegPath = null;
  cachedFFprobePath = null;
};
