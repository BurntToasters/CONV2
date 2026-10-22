const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  authenticodeStrippedSha256Candidates,
  expectedChecksumForBinary,
  sha256File,
  verifyBundledBinaryChecksum,
} = require('../dist/main/ffmpegIntegrity.js');

// E2E: Authenticode-stripped verification on real signed and unsigned PE files.
// Failure modes:
// - A signed PE whose raw hash differs from the manifest is rejected (strip path required).
// - A tampered signed or unsigned PE is accepted.
// - Bytes appended after the cert table are accepted.
// - Zero padding before the cert table is not stripped, so a padded signed file never verifies.
// - A non-zero byte inside that padding is accepted.
// - A packaged layout walks to a dev manifest, or passes through, when the embedded one is missing.
// - Missing tools or binaries silently pass instead of skipping with a reason.
// - Temp copies stay on disk after a run.

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'resources', 'ffmpeg', 'checksums.json');
const X64_FFMPEG = path.join(ROOT, 'resources', 'ffmpeg', 'win', 'x64', 'ffmpeg.exe');
const ARM64_FFPROBE = path.join(ROOT, 'resources', 'ffmpeg', 'win', 'arm64', 'ffprobe.exe');
const VENDOR_DIR = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor');
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'e2e', 'authenticode-check.json');
const PE_SECURITY_ENTRY_OFFSET = 4 * 8;

const onPath = (command) =>
  (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return fs.statSync(path.join(dir, command)).isFile();
    } catch {
      return false;
    }
  });

const missingTools = ['osslsigncode', 'openssl'].filter((command) => !onPath(command));
const toolSkip = missingTools.length > 0 ? `${missingTools.join(', ')} not on PATH` : false;

const securityDirectoryAt = (bytes) => {
  const optionalAt = bytes.readUInt32LE(0x3c) + 24;
  const dataDirsAt = optionalAt + (bytes.readUInt16LE(optionalAt) === 0x20b ? 112 : 96);
  return dataDirsAt + PE_SECURITY_ENTRY_OFFSET;
};

const isUnsignedPe = (file) => {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    return false;
  }
  const at = securityDirectoryAt(bytes);
  return bytes.readUInt32LE(at) === 0 && bytes.readUInt32LE(at + 4) === 0;
};

// Smallest unsigned PE shipped in node_modules; used as the unsigned source for the fallback set.
const SIGNTOOL_PE = path.join(VENDOR_DIR, 'signtool.exe');
const signedVendorPe = fs.existsSync(SIGNTOOL_PE) ? SIGNTOOL_PE : null;

const unsignedVendorPe = (() => {
  if (!fs.existsSync(VENDOR_DIR)) {
    return null;
  }
  const candidates = fs
    .readdirSync(VENDOR_DIR)
    .filter((name) => name.endsWith('.exe'))
    .map((name) => path.join(VENDOR_DIR, name))
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  return candidates.find(isUnsignedPe) ?? null;
})();

const stagedSkip = (() => {
  if (toolSkip) {
    return toolSkip;
  }
  if (!fs.existsSync(X64_FFMPEG) || !fs.existsSync(ARM64_FFPROBE)) {
    return 'resources/ffmpeg/win x64 ffmpeg.exe or arm64 ffprobe.exe not staged';
  }
  return false;
})();

const fallbackSkip = (() => {
  if (toolSkip) {
    return toolSkip;
  }
  return unsignedVendorPe ? false : 'no unsigned PE found in node_modules/electron-winstaller';
})();

const artifactCases = [];

// Written once after every test in this file, so each suite's cases land in one artifact.
test.after(() => {
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(
    ARTIFACT_PATH,
    `${JSON.stringify({ tool: 'osslsigncode', cases: artifactCases }, null, 2)}\n`
  );
});

const recordCase = (suite, name, size, expected, actual) => {
  const entry = { suite, name, size, expected, actual, pass: actual === expected };
  artifactCases.push(entry);
  return entry;
};

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const zeroPeChecksum = (file) => {
  const bytes = fs.readFileSync(file);
  const checksumAt = bytes.readUInt32LE(0x3c) + 24 + 64;
  bytes.fill(0, checksumAt, checksumAt + 4);
  fs.writeFileSync(file, bytes);
};

const writeManifest = (dir, digest, target = 'win:x64') =>
  fs.writeFileSync(
    path.join(dir, 'checksums.json'),
    JSON.stringify({ [target]: { binaries: { ffmpeg: { sha256: digest } } } })
  );

const copyWithByteFlipped = (source, target, offset) => {
  fs.copyFileSync(source, target);
  const fd = fs.openSync(target, 'r+');
  try {
    const byte = Buffer.alloc(1);
    fs.readSync(fd, byte, 0, 1, offset);
    byte[0] ^= 0xff;
    fs.writeSync(fd, byte, 0, 1, offset);
  } finally {
    fs.closeSync(fd);
  }
};

const makeSigningPair = (dir) => {
  const certPem = path.join(dir, 'cert.pem');
  const keyPem = path.join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPem,
      '-out',
      certPem,
      '-days',
      '1',
      '-subj',
      '/CN=CONV2 Authenticode Test/',
    ],
    { stdio: 'pipe' }
  );
  return { certPem, keyPem };
};

const signPe = (input, output, pair) =>
  execFileSync(
    'osslsigncode',
    ['sign', '-certs', pair.certPem, '-key', pair.keyPem, '-in', input, '-out', output],
    { stdio: 'pipe' }
  );

test(
  'osslsigncode-signed Windows FFmpeg binaries verify through the stripped Authenticode hash',
  { skip: stagedSkip },
  async () => {
    const suite = 'staged-win-payload';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-authenticode-'));
    const cases = [];
    const record = (name, size, expected, actual) => {
      cases.push(recordCase(suite, name, size, expected, actual));
    };
    try {
      fs.copyFileSync(MANIFEST, path.join(dir, 'checksums.json'));
      const pair = makeSigningPair(dir);

      const signedX64 = path.join(dir, 'signed-ffmpeg.exe');
      const signedArm64 = path.join(dir, 'signed-ffprobe.exe');
      const inputX64 = path.join(dir, 'input-ffmpeg.exe');
      const inputArm64 = path.join(dir, 'input-ffprobe.exe');
      const sign = (source, input, output) => {
        fs.copyFileSync(source, input);
        signPe(input, output, pair);
        fs.rmSync(input, { force: true });
      };
      sign(X64_FFMPEG, inputX64, signedX64);
      sign(ARM64_FFPROBE, inputArm64, signedArm64);

      const x64Expected = expectedChecksumForBinary(
        path.join(dir, 'checksums.json'),
        'win:x64',
        'ffmpeg'
      );
      const x64Size = fs.statSync(signedX64).size;
      const rawSigned = await sha256File(signedX64);
      record(
        'signed x64 ffmpeg.exe raw sha256 differs from manifest',
        x64Size,
        false,
        rawSigned === x64Expected
      );

      const verify = async (name, file, binary, arch, expected) => {
        const size = fs.statSync(file).size;
        const actual = await verifyBundledBinaryChecksum(file, binary, 'win32', arch);
        record(name, size, expected, actual);
      };

      await verify('signed x64 ffmpeg.exe', signedX64, 'ffmpeg', 'x64', true);
      await verify('signed arm64 ffprobe.exe', signedArm64, 'ffprobe', 'arm64', true);

      const unsignedX64 = path.join(dir, 'unsigned-ffmpeg.exe');
      fs.copyFileSync(X64_FFMPEG, unsignedX64);
      await verify('unsigned x64 ffmpeg.exe (original bytes)', unsignedX64, 'ffmpeg', 'x64', true);
      fs.rmSync(unsignedX64, { force: true });

      const flippedSigned = path.join(dir, 'flipped-signed-ffmpeg.exe');
      copyWithByteFlipped(signedX64, flippedSigned, Math.floor(x64Size / 2));
      await verify(
        'signed x64 ffmpeg.exe with one byte flipped at 50%',
        flippedSigned,
        'ffmpeg',
        'x64',
        false
      );
      fs.rmSync(flippedSigned, { force: true });

      const appendedSigned = path.join(dir, 'appended-signed-ffmpeg.exe');
      fs.copyFileSync(signedX64, appendedSigned);
      fs.appendFileSync(appendedSigned, Buffer.alloc(16, 0xab));
      await verify(
        'signed x64 ffmpeg.exe with 16 bytes appended',
        appendedSigned,
        'ffmpeg',
        'x64',
        false
      );
      fs.rmSync(appendedSigned, { force: true });

      const flippedUnsigned = path.join(dir, 'flipped-unsigned-ffmpeg.exe');
      copyWithByteFlipped(X64_FFMPEG, flippedUnsigned, Math.floor(x64Size / 2));
      await verify(
        'unsigned x64 ffmpeg.exe with one byte flipped',
        flippedUnsigned,
        'ffmpeg',
        'x64',
        false
      );
      fs.rmSync(flippedUnsigned, { force: true });

      const candidates = await authenticodeStrippedSha256Candidates(signedX64);
      record(
        'signed x64 ffmpeg.exe yields stripped candidates',
        x64Size,
        true,
        candidates.length > 0
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const entry of cases) {
      assert.equal(entry.actual, entry.expected, entry.name);
    }
  }
);

test(
  'osslsigncode-signed unsigned PE verifies through the stripped hash, including cert padding',
  { skip: fallbackSkip },
  async () => {
    const suite = 'vendor-unsigned-pe';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-authenticode-vendor-'));
    const cases = [];
    const record = (name, size, expected, actual) => {
      cases.push(recordCase(suite, name, size, expected, actual));
    };
    try {
      const pair = makeSigningPair(dir);
      const mainDir = path.join(dir, 'main');
      fs.mkdirSync(mainDir);
      const original = path.join(mainDir, 'original.exe');
      fs.copyFileSync(unsignedVendorPe, original);
      writeManifest(mainDir, sha256Of(original));

      const signed = path.join(mainDir, 'signed.exe');
      signPe(original, signed, pair);
      const size = fs.statSync(signed).size;
      const verify = async (name, file, expected) => {
        const actual = await verifyBundledBinaryChecksum(file, 'ffmpeg', 'win32', 'x64');
        record(name, fs.statSync(file).size, expected, actual);
      };

      await verify('unsigned original PE (raw hash)', original, true);
      await verify('signed copy of unsigned original PE', signed, true);

      const flipped = path.join(mainDir, 'flipped-signed.exe');
      copyWithByteFlipped(signed, flipped, Math.floor(size / 2));
      await verify('signed copy with one byte flipped at 50%', flipped, false);

      const appended = path.join(mainDir, 'appended-signed.exe');
      fs.copyFileSync(signed, appended);
      fs.appendFileSync(appended, Buffer.alloc(16, 0xab));
      await verify('signed copy with 16 bytes appended', appended, false);

      const flippedOriginal = path.join(mainDir, 'flipped-original.exe');
      copyWithByteFlipped(original, flippedOriginal, Math.floor(size / 2));
      await verify('unsigned original with one byte flipped', flippedOriginal, false);

      // Odd-length content: 3 zero bytes make the length % 8 != 0, so signtool must pad.
      // The stored PE checksum is zeroed: appending bytes leaves it stale, and 0 is valid unsigned.
      const paddedDir = path.join(dir, 'padded');
      fs.mkdirSync(paddedDir);
      const padded = path.join(paddedDir, 'padded.exe');
      fs.copyFileSync(unsignedVendorPe, padded);
      fs.appendFileSync(padded, Buffer.alloc(3, 0));
      zeroPeChecksum(padded);
      writeManifest(paddedDir, sha256Of(padded));
      const paddedSigned = path.join(paddedDir, 'padded-signed.exe');
      signPe(padded, paddedSigned, pair);

      const signedBytes = fs.readFileSync(paddedSigned);
      const certOffset = signedBytes.readUInt32LE(securityDirectoryAt(signedBytes));
      const padLength = certOffset - fs.statSync(padded).size;
      record('signed padded PE has zero bytes before cert table', certOffset, true, padLength > 0);
      await verify('signed padded PE (stripped hash needs the pad removed)', paddedSigned, true);

      const nonZeroPad = path.join(paddedDir, 'nonzero-pad-signed.exe');
      copyWithByteFlipped(paddedSigned, nonZeroPad, certOffset - 1);
      await verify('signed padded PE with a non-zero pad byte', nonZeroPad, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const entry of cases) {
      assert.equal(entry.actual, entry.expected, entry.name);
    }
  }
);

// Tool-free strip coverage: signtool.exe ships Authenticode-signed in node_modules.
// Oracle: the Authenticode hash over [0, certOffset) with the Security entry and CheckSum zeroed.
test(
  'Authenticode-signed node_modules PE verifies through the stripped hash without any tools',
  {
    skip: signedVendorPe ? false : 'node_modules/electron-winstaller/vendor/signtool.exe not found',
  },
  async () => {
    const suite = 'signed-vendor-pe';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-authenticode-signed-'));
    const cases = [];
    const record = (name, size, expected, actual) => {
      cases.push(recordCase(suite, name, size, expected, actual));
    };
    try {
      const bytes = fs.readFileSync(signedVendorPe);
      const certOffset = bytes.readUInt32LE(securityDirectoryAt(bytes));
      const stripped = Buffer.from(bytes.subarray(0, certOffset));
      const securityAt = securityDirectoryAt(bytes);
      const checksumAt = bytes.readUInt32LE(0x3c) + 24 + 64;
      stripped.fill(0, securityAt, securityAt + 8);
      stripped.fill(0, checksumAt, checksumAt + 4);
      const oracle = crypto.createHash('sha256').update(stripped).digest('hex');

      const mainDir = path.join(dir, 'main');
      fs.mkdirSync(mainDir);
      writeManifest(mainDir, oracle);
      const copy = path.join(mainDir, 'signtool.exe');
      fs.copyFileSync(signedVendorPe, copy);
      const verify = async (name, file, expected) => {
        const actual = await verifyBundledBinaryChecksum(file, 'ffmpeg', 'win32', 'x64');
        record(name, fs.statSync(file).size, expected, actual);
      };

      await verify('signed signtool.exe (raw hash differs, stripped oracle matches)', copy, true);

      const flipped = path.join(mainDir, 'flipped.exe');
      copyWithByteFlipped(copy, flipped, Math.floor(certOffset / 2));
      await verify(
        'signed signtool.exe with one byte flipped at 50% of the content',
        flipped,
        false
      );

      const appended = path.join(mainDir, 'appended.exe');
      fs.copyFileSync(copy, appended);
      fs.appendFileSync(appended, Buffer.alloc(8, 0xcd));
      await verify('signed signtool.exe with 8 bytes appended', appended, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const entry of cases) {
      assert.equal(entry.actual, entry.expected, entry.name);
    }
  }
);

test(
  'packaged layout fails closed without a complete embedded manifest',
  { skip: unsignedVendorPe ? false : 'no unsigned PE found in node_modules/electron-winstaller' },
  async () => {
    const suite = 'packaged-layout';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-packaged-'));
    const cases = [];
    const record = (name, size, expected, actual) => {
      cases.push(recordCase(suite, name, size, expected, actual));
    };
    try {
      const resources = path.join(dir, 'resources');
      const bundled = path.join(resources, 'ffmpeg');
      fs.mkdirSync(bundled, { recursive: true });
      const binary = path.join(bundled, 'ffmpeg.exe');
      fs.copyFileSync(unsignedVendorPe, binary);
      const digest = sha256Of(binary);
      // A matching dev manifest next to the binary must not satisfy the packaged lookup.
      writeManifest(bundled, digest);
      const embedded = path.join(dir, 'dist-main', 'ffmpeg-checksums.json');
      const verify = (layout, file = binary) =>
        verifyBundledBinaryChecksum(file, 'ffmpeg', 'win32', 'x64', undefined, layout);
      const packaged = { resourcesPath: resources, embeddedManifestPath: embedded };
      const size = fs.statSync(binary).size;

      record('packaged layout, embedded manifest missing', size, false, await verify(packaged));

      fs.mkdirSync(path.dirname(embedded), { recursive: true });
      fs.writeFileSync(
        embedded,
        JSON.stringify({ 'win:x64': { binaries: { ffmpeg: { sha256: digest } } } })
      );
      record('packaged layout, embedded manifest matches', size, true, await verify(packaged));

      fs.writeFileSync(
        embedded,
        JSON.stringify({ 'win:arm64': { binaries: { ffmpeg: { sha256: digest } } } })
      );
      record(
        'packaged layout, target missing from embedded manifest',
        size,
        false,
        await verify(packaged)
      );

      fs.writeFileSync(
        embedded,
        JSON.stringify({ 'win:x64': { binaries: { ffprobe: { sha256: digest } } } })
      );
      record('packaged layout, ffmpeg entry missing', size, false, await verify(packaged));

      fs.writeFileSync(
        embedded,
        JSON.stringify({ 'win:x64': { binaries: { ffmpeg: { sha256: '' } } } })
      );
      record('packaged layout, digest empty', size, false, await verify(packaged));

      fs.writeFileSync(embedded, '{ not json');
      record('packaged layout, malformed embedded manifest', size, false, await verify(packaged));

      const outside = path.join(dir, 'outside', 'ffmpeg.exe');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.copyFileSync(binary, outside);
      writeManifest(path.dirname(outside), digest);
      record(
        'binary outside <resources>/ffmpeg uses the dev walk (no embedded manifest needed)',
        size,
        true,
        await verify(packaged, outside)
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const entry of cases) {
      assert.equal(entry.actual, entry.expected, entry.name);
    }
  }
);
