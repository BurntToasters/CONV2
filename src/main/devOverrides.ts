import * as fs from 'fs';
import * as path from 'path';

export interface DevOverrides {
  userDataDir?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}

const isAbsoluteKind = (value: string | undefined, kind: 'file' | 'dir'): value is string => {
  if (!value || !path.isAbsolute(value)) return false;
  try {
    const stat = fs.statSync(value);
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
};

/** Test-only env overrides (E2E isolation, system FFmpeg). Never honoured in packaged builds. */
export const resolveDevOverrides = (env: NodeJS.ProcessEnv, isPackaged: boolean): DevOverrides => {
  if (isPackaged) return {};
  const result: DevOverrides = {};
  if (isAbsoluteKind(env.CONV2_USER_DATA_DIR, 'dir')) result.userDataDir = env.CONV2_USER_DATA_DIR;
  if (isAbsoluteKind(env.CONV2_FFMPEG_PATH, 'file')) result.ffmpegPath = env.CONV2_FFMPEG_PATH;
  if (isAbsoluteKind(env.CONV2_FFPROBE_PATH, 'file')) result.ffprobePath = env.CONV2_FFPROBE_PATH;
  return result;
};
