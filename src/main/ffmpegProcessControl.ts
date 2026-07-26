import { spawnSync, type ChildProcess } from 'child_process';
import * as path from 'path';

const resolveWindowsTaskkillPath = (): string => {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', 'taskkill.exe');
};

/** Force-terminate an FFmpeg child process (Windows taskkill or POSIX process group). */
export const forceKillFfmpegProcess = (processToKill: ChildProcess): void => {
  if (processToKill.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32' && processToKill.pid) {
    try {
      spawnSync(resolveWindowsTaskkillPath(), ['/pid', processToKill.pid.toString(), '/t', '/f'], {
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

  if (processToKill.pid) {
    try {
      process.kill(-processToKill.pid, 'SIGKILL');
      return;
    } catch {
      // fall through
    }
  }

  try {
    processToKill.kill('SIGKILL');
  } catch {
    return;
  }
};
