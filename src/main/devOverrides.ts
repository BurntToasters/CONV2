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

// Failure modes: Flatpak runs the Electron dist unpackaged, so app.isPackaged is false and
// dev flags would reach users. FLATPAK_ID is set in every Flatpak sandbox, so treat it as shipped.
// Dropping this check exposes overrides and --dev/--smoke in Flatpak; widening it hides them in dev.
const isShippedBuild = (env: NodeJS.ProcessEnv, isPackaged: boolean): boolean =>
  isPackaged || Boolean(env.FLATPAK_ID);

/** Test-only env overrides (E2E isolation, system FFmpeg). Never honoured in packaged builds. */
export const resolveDevOverrides = (env: NodeJS.ProcessEnv, isPackaged: boolean): DevOverrides => {
  if (isShippedBuild(env, isPackaged)) return {};
  const result: DevOverrides = {};
  if (isAbsoluteKind(env.CONV2_USER_DATA_DIR, 'dir')) result.userDataDir = env.CONV2_USER_DATA_DIR;
  if (isAbsoluteKind(env.CONV2_FFMPEG_PATH, 'file')) result.ffmpegPath = env.CONV2_FFMPEG_PATH;
  if (isAbsoluteKind(env.CONV2_FFPROBE_PATH, 'file')) result.ffprobePath = env.CONV2_FFPROBE_PATH;
  return result;
};

export interface LaunchFlags {
  openDevTools: boolean;
  runtimeSmoke: boolean;
  backgroundWindows: boolean;
}

// Failure modes for backgroundWindows: a shipped build honours it and starts hidden from the user
// (no Dock icon, never activated). E2E runs without it pop CONV2 to the front on every launch.
/** `--dev` and `--smoke` are dev/CI aids; a shipped build must not open DevTools or self-exit. */
export const resolveLaunchFlags = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  isPackaged: boolean
): LaunchFlags => {
  if (isShippedBuild(env, isPackaged)) {
    return { openDevTools: false, runtimeSmoke: false, backgroundWindows: false };
  }
  return {
    openDevTools: argv.includes('--dev'),
    runtimeSmoke: argv.includes('--smoke') || env.CONV2_SMOKE === '1',
    backgroundWindows: env.CONV2_E2E_BACKGROUND === '1',
  };
};
