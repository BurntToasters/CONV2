import * as fs from 'fs';
import * as path from 'path';

export const ffmpegPlatformFolder = (platform: string): 'win' | 'mac' | 'linux' | null => {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  return null;
};

export const bundledFFmpegRelDirs = (platform: string, arch: string): string[] => {
  const folder = ffmpegPlatformFolder(platform);
  const dirs = new Set<string>(['', arch]);
  if (folder) {
    dirs.add(path.join(folder, arch));
  }
  return Array.from(dirs);
};

export const bundledBinaryFileName = (platform: string, binary: 'ffmpeg' | 'ffprobe'): string => {
  return platform === 'win32' ? `${binary}.exe` : binary;
};

const isExecutableFile = (filePath: string, platform: string): boolean => {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** First absolute PATH match for a command; relative/empty entries are ignored (no cwd hijack). */
export const resolveExecutableOnPath = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
  delimiter: string = path.delimiter
): string | null => {
  const rawPath = env.PATH ?? env.Path ?? '';
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)
      : [''];
  for (const dir of rawPath.split(delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      for (const candidate of new Set([`${command}${ext}`, `${command}${ext.toLowerCase()}`])) {
        const full = path.join(dir, candidate);
        if (isExecutableFile(full, platform)) return full;
      }
    }
  }
  return null;
};
