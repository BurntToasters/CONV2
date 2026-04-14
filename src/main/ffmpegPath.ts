import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

let cachedFFmpegPath: string | null = null;
let cachedFFprobePath: string | null = null;
let useSystemFFmpeg = false;

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
            const binaryName = path.basename(filePath);
            const tmpDir = path.join(app.getPath('temp'), 'conv2-bin');
            if (!fs.existsSync(tmpDir)) {
              fs.mkdirSync(tmpDir, { recursive: true });
            }
            const tmpBin = path.join(tmpDir, binaryName);
            fs.copyFileSync(filePath, tmpBin);
            fs.chmodSync(tmpBin, 0o755);
            return tmpBin;
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
  const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  for (const baseDir of candidateBaseDirs) {
    const normalizedBaseDir = path.resolve(baseDir);
    if (seen.has(normalizedBaseDir)) {
      continue;
    }
    seen.add(normalizedBaseDir);

    if (!fs.existsSync(normalizedBaseDir)) {
      continue;
    }

    if (fs.existsSync(path.join(normalizedBaseDir, ffmpegName))) {
      return normalizedBaseDir;
    }

    if (process.platform === 'darwin' || process.platform === 'win32') {
      const archDir = path.join(normalizedBaseDir, process.arch);
      if (fs.existsSync(path.join(archDir, ffmpegName))) {
        return archDir;
      }

      const x64Dir = path.join(normalizedBaseDir, 'x64');
      if (process.arch === 'x64' && fs.existsSync(path.join(x64Dir, ffmpegName))) {
        return x64Dir;
      }

      const arm64Dir = path.join(normalizedBaseDir, 'arm64');
      if (process.arch === 'arm64' && fs.existsSync(path.join(arm64Dir, ffmpegName))) {
        return arm64Dir;
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

  if (useSystemFFmpeg) {
    cachedFFmpegPath = 'ffmpeg';
    return 'ffmpeg';
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

  if (useSystemFFmpeg) {
    cachedFFprobePath = 'ffprobe';
    return 'ffprobe';
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

export const hasBundledFFmpeg = (): boolean => {
  const ffmpegPath = getFFmpegPath();
  if (ffmpegPath === 'ffmpeg') {
    return false;
  }
  return fs.existsSync(ffmpegPath);
};

export const clearFFmpegPathCache = (): void => {
  cachedFFmpegPath = null;
  cachedFFprobePath = null;
};
