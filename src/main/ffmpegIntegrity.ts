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

/** Streams the file so hashing a ~50 MB binary does not block the main process. */
export const sha256File = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

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

export const verifyBundledBinaryChecksum = async (
  binaryPath: string,
  binary: 'ffmpeg' | 'ffprobe',
  platform = process.platform,
  arch = process.arch
): Promise<boolean> => {
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
  try {
    return (await sha256File(binaryPath)) === expected;
  } catch {
    return false;
  }
};
