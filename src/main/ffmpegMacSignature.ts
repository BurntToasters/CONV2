import { execFile } from 'child_process';
import * as path from 'path';

const CODESIGN_PATH = '/usr/bin/codesign';
const CODESIGN_TIMEOUT_MS = 10_000;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const FFMPEG_IDENTIFIERS = new Set(['ffmpeg', 'ffprobe']);

const runCodesign = (args: string[]): Promise<{ ok: boolean; output: string }> =>
  new Promise((resolve) => {
    execFile(CODESIGN_PATH, args, { timeout: CODESIGN_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}` });
    });
  });

/** codesign -dv prints to stderr; returns null for unsigned or team-less (adhoc) code. */
export const readMacTeamId = async (codePath: string): Promise<string | null> => {
  const result = await runCodesign(['-dv', codePath]);
  if (!result.ok) {
    return null;
  }
  const match = /^TeamIdentifier=(.+)$/m.exec(result.output);
  const team = match?.[1].trim() ?? '';
  return team.length > 0 && team !== 'not set' ? team : null;
};

/** Returns the outermost `*.app` bundle root (e.g. /Applications/CONV2.app) containing the path. */
export const macAppBundleRoot = (filePath: string): string | null => {
  const segments = path.resolve(filePath).split(path.sep);
  for (let i = 1; i < segments.length - 1; i += 1) {
    if (segments[i].endsWith('.app') && segments[i + 1] === 'Contents') {
      return segments.slice(0, i + 1).join(path.sep);
    }
  }
  return null;
};

// Failure modes: tampered bytes fail --verify. A binary re-signed by another team or ad hoc
// fails the team leaf check. An identifier other than ffmpeg or ffprobe is never interpolated.
// A malformed team ID is never interpolated. A missing codesign, spawn error, or timeout fails
// closed. An unsigned app has no team, so the caller falls back to the manifest.
export const verifyMacCodeSignature = async (
  binaryPath: string,
  appExecutablePath: string,
  knownAppTeam?: string | null
): Promise<boolean> => {
  const identifier = path.basename(binaryPath);
  const appTeam =
    knownAppTeam !== undefined ? knownAppTeam : await readMacTeamId(appExecutablePath);
  if (!appTeam || !TEAM_ID_PATTERN.test(appTeam) || !FFMPEG_IDENTIFIERS.has(identifier)) {
    return false;
  }
  const requirement = `anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${appTeam}"`;
  const verify = await runCodesign(['--verify', '--strict', `-R=${requirement}`, binaryPath]);
  return verify.ok;
};
