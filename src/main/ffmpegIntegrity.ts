import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { macAppBundleRoot, readMacTeamId, verifyMacCodeSignature } from './ffmpegMacSignature';

export { macAppBundleRoot, readMacTeamId, verifyMacCodeSignature };

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

const sha256Range = (filePath: string, start: number, length: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath, { start, end: start + length - 1 })
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

export type BundleLayout = {
  /** process.resourcesPath when packaged; null in dev and in tests. */
  resourcesPath: string | null;
  /** Manifest copied into dist/main by the build; ships inside app.asar. */
  embeddedManifestPath: string;
};

export const currentBundleLayout = (): BundleLayout => ({
  resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : null,
  embeddedManifestPath: path.join(__dirname, 'ffmpeg-checksums.json'),
});

/** True when binaryPath sits under <resourcesPath>/ffmpeg, the layout electron-builder ships. */
export const isPackagedFfmpegLayout = (
  binaryPath: string,
  resourcesPath: string | null
): boolean => {
  if (resourcesPath === null) {
    return false;
  }
  const relative = path.relative(path.resolve(resourcesPath, 'ffmpeg'), path.resolve(binaryPath));
  return relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
};

const MACH_FAT_MAGIC = 0xcafebabe;
const MACH_FAT64_MAGIC = 0xcafebabf;
const MACH_FAT_MAX_ARCHES = 16;
const MACH_CPU_TYPE_BY_ARCH: { [arch: string]: number } = {
  x64: 0x01000007,
  arm64: 0x0100000c,
};

// Failure modes for fat (universal) slices, used only when the mac signature path is not taken:
// - a flipped byte inside the arch slice: the slice digest differs from the manifest.
// - a flipped byte in the other arch's slice: the arch slice still matches, so it passes.
// - no slice for this arch: null, so the caller fails closed.
// - offset or size past EOF, or zero size: rejected before any slice is hashed.
// - truncated header or arch table: null, so the caller fails closed.
// - thin or non-Mach-O file: null, so only the raw hash can match.
const findMacFatSlice = async (
  filePath: string,
  arch: string
): Promise<{ offset: number; size: number } | null> => {
  const cpuType = MACH_CPU_TYPE_BY_ARCH[arch];
  if (cpuType === undefined) {
    return null;
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const head = Buffer.alloc(8);
    if ((await handle.read(head, 0, head.length, 0)).bytesRead < head.length) {
      return null;
    }
    const magic = head.readUInt32BE(0);
    if (magic !== MACH_FAT_MAGIC && magic !== MACH_FAT64_MAGIC) {
      return null;
    }
    const is64 = magic === MACH_FAT64_MAGIC;
    const entryBytes = is64 ? 32 : 20;
    const count = head.readUInt32BE(4);
    if (count === 0 || count > MACH_FAT_MAX_ARCHES) {
      return null;
    }
    const table = Buffer.alloc(count * entryBytes);
    if ((await handle.read(table, 0, table.length, 8)).bytesRead < table.length) {
      return null;
    }
    for (let at = 0; at < table.length; at += entryBytes) {
      if (table.readUInt32BE(at) !== cpuType) {
        continue;
      }
      const offset = is64 ? Number(table.readBigUInt64BE(at + 8)) : table.readUInt32BE(at + 8);
      const size = is64 ? Number(table.readBigUInt64BE(at + 16)) : table.readUInt32BE(at + 12);
      return size > 0 && offset + size <= fileSize ? { offset, size } : null;
    }
    return null;
  } finally {
    await handle.close();
  }
};

// Failure modes for Authenticode-stripped hashing (signed Windows binaries only):
// - code bytes tampered after signing: the stripped hash differs from the manifest.
// - data appended after the cert table: the table no longer ends at EOF, so no candidates.
// - malformed or truncated PE header: every header read is bounds-checked, so no candidates.
// - cert offset outside the file or inside the headers: no candidates.
// - non-PE file: no MZ or PE signature, so no candidates.
// - huge file: only the header and a tail of at most 7 bytes are read; the body is streamed.
// - unsigned file: no Security directory, so the raw hash alone decides.
// - non-zero byte before the cert table: that padding length gives no candidate.
// - tampered padding byte: the zero-pad check rejects that length.
const PE_HEADER_READ_BYTES = 4096;
const PE_SECURITY_DIRECTORY_INDEX = 4;
const PE_DIRECTORY_ENTRY_BYTES = 8;
const PE_DATA_DIRECTORIES_OFFSET: { [magic: number]: number } = { 0x10b: 96, 0x20b: 112 };
// signtool aligns the cert table to 8 bytes with up to 7 zero bytes before it.
const PE_PAD_MAX_BYTES = 7;

type AuthenticodeLayout = {
  certOffset: number;
  checksumAt: number;
  securityEntryAt: number;
  patchEnd: number;
};

const readFileHead = async (filePath: string): Promise<{ head: Buffer; size: number }> => {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, PE_HEADER_READ_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return { head: head.subarray(0, bytesRead), size };
  } finally {
    await handle.close();
  }
};

const readRange = async (filePath: string, start: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  if (length === 0) {
    return buffer;
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) {
      throw new Error(`short read at ${start}`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
};

const readAuthenticodeLayout = (head: Buffer, fileSize: number): AuthenticodeLayout | null => {
  if (head.length < 0x40 || head.readUInt16LE(0) !== 0x5a4d) {
    return null;
  }
  const peAt = head.readUInt32LE(0x3c);
  if (peAt + 24 > head.length || head.readUInt32LE(peAt) !== 0x00004550) {
    return null;
  }
  const optionalAt = peAt + 24;
  const relativeDataDirs: number | undefined =
    PE_DATA_DIRECTORIES_OFFSET[head.readUInt16LE(optionalAt)];
  if (relativeDataDirs === undefined) {
    return null;
  }
  const dataDirsAt = optionalAt + relativeDataDirs;
  const securityEntryAt = dataDirsAt + PE_SECURITY_DIRECTORY_INDEX * PE_DIRECTORY_ENTRY_BYTES;
  const checksumAt = optionalAt + 64;
  if (securityEntryAt + PE_DIRECTORY_ENTRY_BYTES > head.length || checksumAt + 4 > head.length) {
    return null;
  }
  if (head.readUInt32LE(dataDirsAt - 4) <= PE_SECURITY_DIRECTORY_INDEX) {
    return null;
  }
  const certOffset = head.readUInt32LE(securityEntryAt);
  const certSize = head.readUInt32LE(securityEntryAt + 4);
  const headerEnd = head.readUInt32LE(optionalAt + 60);
  const patchEnd = Math.max(checksumAt + 4, securityEntryAt + PE_DIRECTORY_ENTRY_BYTES);
  if (certOffset === 0 || certSize === 0) {
    return null;
  }
  if (certOffset <= headerEnd || certOffset < patchEnd) {
    return null;
  }
  if (certOffset + certSize !== fileSize) {
    return null;
  }
  return { certOffset, checksumAt, securityEntryAt, patchEnd };
};

// Header bytes up to patchEnd, with the Security entry zeroed and CheckSum set to `checksum`.
const patchedHeader = (head: Buffer, layout: AuthenticodeLayout, checksum: number): Buffer => {
  const patched = Buffer.from(head.subarray(0, layout.patchEnd));
  patched.fill(0, layout.securityEntryAt, layout.securityEntryAt + PE_DIRECTORY_ENTRY_BYTES);
  patched.writeUInt32LE(checksum, layout.checksumAt);
  return patched;
};

// Streams bytes [start, end) of the file to onChunk.
const streamRange = (
  filePath: string,
  start: number,
  end: number,
  onChunk: (chunk: Buffer) => void
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (end <= start) {
      resolve();
      return;
    }
    fs.createReadStream(filePath, { start, end: end - 1 })
      .on('data', (chunk) => onChunk(chunk as Buffer))
      .on('error', reject)
      .on('end', () => resolve());
  });

const foldPeSum = (value: number): number => (value & 0xffff) + (value >>> 16);

// Sums 16-bit little-endian words; a trailing odd byte counts as its low byte.
const peWordSum = () => {
  let sum = 0;
  let pendingLow = -1;
  return {
    add(chunk: Buffer): void {
      let i = 0;
      if (pendingLow >= 0 && chunk.length > 0) {
        sum = foldPeSum(sum + (pendingLow | (chunk[0] << 8)));
        pendingLow = -1;
        i = 1;
      }
      for (; i + 1 < chunk.length; i += 2) {
        sum = foldPeSum(sum + (chunk[i] | (chunk[i + 1] << 8)));
      }
      if (i < chunk.length) {
        pendingLow = chunk[i];
      }
    },
    folded(): number {
      return foldPeSum(pendingLow >= 0 ? foldPeSum(sum + pendingLow) : sum);
    },
  };
};

/** SHA-256 candidates for a signed PE with its Authenticode blob removed; [] if not signed. */
export const authenticodeStrippedSha256Candidates = async (filePath: string): Promise<string[]> => {
  const { head, size } = await readFileHead(filePath);
  const layout = readAuthenticodeLayout(head, size);
  if (!layout) {
    return [];
  }
  const { certOffset, patchEnd } = layout;
  const tailStart = Math.max(patchEnd, certOffset - PE_PAD_MAX_BYTES);
  const tail = await readRange(filePath, tailStart, certOffset - tailStart);

  // Pass 1: PE checksum over the whole stripped content, which is zero-padded up to certOffset.
  const wordSum = peWordSum();
  wordSum.add(patchedHeader(head, layout, 0));
  await streamRange(filePath, patchEnd, tailStart, (chunk) => wordSum.add(chunk));
  wordSum.add(tail);
  const folded = wordSum.folded();

  // A padding length k is a candidate only when the k bytes before certOffset are zero.
  // Zero bytes add nothing to the word sum, so the checksum for that length is folded + length.
  const contents: { length: number; checksum: number }[] = [];
  for (let pad = 0; pad <= tail.length; pad += 1) {
    if (tail.subarray(tail.length - pad).every((byte) => byte === 0)) {
      const length = certOffset - pad;
      contents.push({ length, checksum: 0 }, { length, checksum: (folded + length) >>> 0 });
    }
  }

  // Pass 2: one header-plus-body hash per distinct CheckSum value, extended by the tail per length.
  const bases = new Map<number, crypto.Hash>();
  for (const { checksum } of contents) {
    if (!bases.has(checksum)) {
      bases.set(
        checksum,
        crypto.createHash('sha256').update(patchedHeader(head, layout, checksum))
      );
    }
  }
  await streamRange(filePath, patchEnd, tailStart, (chunk) => {
    for (const base of bases.values()) {
      base.update(chunk);
    }
  });
  const candidates = new Set<string>();
  for (const { length, checksum } of contents) {
    const base = bases.get(checksum);
    if (base) {
      const hash = base.copy().update(tail.subarray(0, length - tailStart));
      candidates.add(hash.digest('hex'));
    }
  }
  return Array.from(candidates);
};

// Failure modes: tampered bytes, adhoc or foreign-team re-signing, and unsigned binaries must
// return false. A codesign spawn error or timeout must fail closed. An unsigned app has no team
// to compare, so it falls back to the manifest. A binary outside the app bundle uses the manifest.
// A valid fat x86_64+arm64 binary must return true.
// Manifest lookup: packaged layout without the embedded manifest, or with a missing target,
// entry, or digest, returns false and never walks to a dev manifest. Malformed JSON returns false.
// Dev layout with no manifest in reach returns true, so unpacked dev runs keep working.
export const verifyBundledBinaryChecksum = async (
  binaryPath: string,
  binary: 'ffmpeg' | 'ffprobe',
  platform = process.platform,
  arch = process.arch,
  appExecutablePath: string = process.execPath,
  layout: BundleLayout = currentBundleLayout()
): Promise<boolean> => {
  if (binaryPath === binary || isMissingBundledBinaryPath(binaryPath)) {
    return !isMissingBundledBinaryPath(binaryPath);
  }
  if (!fs.existsSync(binaryPath)) {
    return false;
  }
  if (platform === 'darwin') {
    const bundleRoot = macAppBundleRoot(binaryPath);
    if (bundleRoot !== null && bundleRoot === macAppBundleRoot(appExecutablePath)) {
      const appTeam = await readMacTeamId(appExecutablePath);
      if (appTeam) {
        return verifyMacCodeSignature(binaryPath, appExecutablePath, appTeam);
      }
    }
  }
  const packaged = isPackagedFfmpegLayout(binaryPath, layout.resourcesPath);
  const manifestPath = packaged
    ? fs.existsSync(layout.embeddedManifestPath)
      ? layout.embeddedManifestPath
      : null
    : findChecksumsManifest(path.dirname(binaryPath));
  if (!manifestPath) {
    return !packaged;
  }
  const target = runtimeFfmpegTarget(platform, arch);
  if (!target) {
    return !packaged;
  }
  try {
    const expected = expectedChecksumForBinary(manifestPath, target, binary);
    if (!expected) {
      return !packaged;
    }
    if ((await sha256File(binaryPath)) === expected) {
      return true;
    }
    if (platform === 'darwin') {
      const slice = await findMacFatSlice(binaryPath, arch);
      return (
        slice !== null && (await sha256Range(binaryPath, slice.offset, slice.size)) === expected
      );
    }
    if (platform === 'win32') {
      return (await authenticodeStrippedSha256Candidates(binaryPath)).includes(expected);
    }
    return false;
  } catch {
    return false;
  }
};
