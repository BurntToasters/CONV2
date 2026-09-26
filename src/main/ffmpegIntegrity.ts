import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const isMissingBundledBinaryPath = (binaryPath: string): boolean => {
  return path.basename(binaryPath).startsWith('__missing_');
};

export const runtimeFfmpegTarget = (platform: string, arch: string): string | null => {
  const os =
    platform === 'win32'
      ? 'win'
      : platform === 'darwin'
        ? 'mac'
        : platform === 'linux'
          ? 'linux'
          : null;
  if (!os) {
    return null;
  }
  return `${os}:${arch}`;
};

export const findChecksumsManifest = (startDir: string): string | null => {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'checksums.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
};

export const sha256File = (filePath: string): string => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

export const expectedChecksumForBinary = (
  manifestPath: string,
  target: string,
  binary: 'ffmpeg' | 'ffprobe'
): string | null => {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    [key: string]: { binaries?: { [name: string]: { sha256?: string } } };
  };
  const digest = raw[target]?.binaries?.[binary]?.sha256;
  return typeof digest === 'string' && digest.length > 0 ? digest : null;
};

export const verifyBundledBinaryChecksum = (
  binaryPath: string,
  binary: 'ffmpeg' | 'ffprobe',
  platform = process.platform,
  arch = process.arch
): boolean => {
  if (binaryPath === binary || isMissingBundledBinaryPath(binaryPath)) {
    return !isMissingBundledBinaryPath(binaryPath);
  }
  if (!fs.existsSync(binaryPath)) {
    return false;
  }
  const manifestPath = findChecksumsManifest(path.dirname(binaryPath));
  if (!manifestPath) {
    return true;
  }
  const target = runtimeFfmpegTarget(platform, arch);
  if (!target) {
    return true;
  }
  const expected = expectedChecksumForBinary(manifestPath, target, binary);
  if (!expected) {
    return true;
  }
  return sha256File(binaryPath) === expected;
};
