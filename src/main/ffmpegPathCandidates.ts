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
