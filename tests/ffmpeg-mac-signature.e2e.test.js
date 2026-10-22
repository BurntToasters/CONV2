const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  verifyBundledBinaryChecksum,
  verifyMacCodeSignature,
} = require('../dist/main/ffmpegIntegrity.js');

// E2E (macOS only): real lipo and codesign runs against the bundled FFmpeg Mach-O binaries.
// Failure modes:
// - A universal binary built from the bundled x64 and arm64 slices is rejected.
// - A flipped byte inside the host arch slice is accepted.
// - A flipped byte in the other arch slice fails the host arch check.
// - A thin binary of the other arch passes the host arch manifest entry.
// - An unsigned or ad hoc binary passes the designated requirement check.
// - A binary identifier outside ffmpeg or ffprobe, or a malformed team ID, reaches codesign.
// - The installed CONV2.app ffmpeg fails the team requirement (when the app is installed).
// - Temp files stay on disk after a run.

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'resources', 'ffmpeg', 'checksums.json');
const BUNDLED = {
  x64: path.join(ROOT, 'resources', 'ffmpeg', 'mac', 'x64', 'ffmpeg'),
  arm64: path.join(ROOT, 'resources', 'ffmpeg', 'mac', 'arm64', 'ffmpeg'),
};
const LIPO_ARCH_NAME = { x64: 'x86_64', arm64: 'arm64' };
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'e2e', 'mac-signature-check.json');
const INSTALLED_APP = '/Applications/CONV2.app';
const INSTALLED_FFMPEG = path.join(INSTALLED_APP, 'Contents', 'Resources', 'ffmpeg', 'ffmpeg');
const INSTALLED_EXE = path.join(INSTALLED_APP, 'Contents', 'MacOS', 'CONV2');

const macSkip = process.platform === 'darwin' ? false : 'macOS only';
const hostArch = process.arch;
const archSkip = BUNDLED[hostArch] ? false : `no bundled mac binary for ${hostArch}`;
const otherArch = hostArch === 'x64' ? 'arm64' : 'x64';

const artifactCases = [];

// Written once after every test in this file.
test.after(() => {
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(
    ARTIFACT_PATH,
    `${JSON.stringify({ tool: 'lipo+codesign', host: hostArch, cases: artifactCases }, null, 2)}\n`
  );
});

const record = (suite, name, expected, actual) => {
  const entry = { suite, name, expected, actual, pass: actual === expected };
  artifactCases.push(entry);
  return entry;
};

const flipByte = (source, target, offset) => {
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

// Parses `lipo -detailed_info` into { [lipoArchName]: { offset, size } }.
const sliceRanges = (fatPath) => {
  const text = execFileSync('/usr/bin/lipo', ['-detailed_info', fatPath], { encoding: 'utf8' });
  const ranges = {};
  for (const block of text.split(/^architecture /m).slice(1)) {
    const name = block.split('\n')[0].trim();
    ranges[name] = {
      offset: Number(/\boffset (\d+)/.exec(block)[1]),
      size: Number(/\bsize (\d+)/.exec(block)[1]),
    };
  }
  return ranges;
};

test(
  'universal bundled binary verifies through the host arch slice only',
  { skip: macSkip || archSkip },
  async () => {
    const suite = 'fat-slice';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-mac-fat-'));
    const cases = [];
    const verify = async (file) =>
      verifyBundledBinaryChecksum(file, 'ffmpeg', 'darwin', hostArch, path.join(dir, 'host'));
    try {
      fs.copyFileSync(MANIFEST, path.join(dir, 'checksums.json'));
      const fat = path.join(dir, 'ffmpeg');
      execFileSync('/usr/bin/lipo', ['-create', BUNDLED.x64, BUNDLED.arm64, '-output', fat]);
      const ranges = sliceRanges(fat);
      const host = ranges[LIPO_ARCH_NAME[hostArch]];
      const other = ranges[LIPO_ARCH_NAME[otherArch]];
      assert.ok(host && other, 'lipo must emit both bundled slices');

      const thin = path.join(dir, 'thin-host');
      fs.copyFileSync(BUNDLED[hostArch], thin);
      cases.push(record(suite, 'thin host-arch binary (raw hash)', true, await verify(thin)));
      cases.push(record(suite, 'universal binary (host slice)', true, await verify(fat)));

      const flippedHost = path.join(dir, 'flipped-host');
      flipByte(fat, flippedHost, host.offset + Math.floor(host.size / 2));
      cases.push(
        record(
          suite,
          'universal binary with a byte flipped in host slice',
          false,
          await verify(flippedHost)
        )
      );

      const flippedOther = path.join(dir, 'flipped-other');
      flipByte(fat, flippedOther, other.offset + Math.floor(other.size / 2));
      cases.push(
        record(
          suite,
          'universal binary with a byte flipped in other slice',
          true,
          await verify(flippedOther)
        )
      );

      const thinOther = path.join(dir, 'thin-other');
      fs.copyFileSync(BUNDLED[otherArch], thinOther);
      cases.push(
        record(suite, 'thin other-arch binary under host manifest', false, await verify(thinOther))
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
  'designated requirement rejects unsigned, mis-named, and malformed-team inputs',
  { skip: macSkip },
  async () => {
    const suite = 'codesign-requirement';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-mac-sig-'));
    const cases = [];
    try {
      const app = path.join(dir, 'host');
      const named = (name) => {
        const target = path.join(dir, name, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(BUNDLED[hostArch], target);
        return target;
      };
      const unsignedFfmpeg = named('ffmpeg');
      const misnamed = named('conv2');

      cases.push(
        record(
          suite,
          'unsigned ffmpeg with a well-formed team ID',
          false,
          await verifyMacCodeSignature(unsignedFfmpeg, app, 'ABCDEFGHIJ')
        )
      );
      cases.push(
        record(
          suite,
          'identifier outside ffmpeg/ffprobe',
          false,
          await verifyMacCodeSignature(misnamed, app, 'ABCDEFGHIJ')
        )
      );
      cases.push(
        record(
          suite,
          'lowercase team ID is not interpolated',
          false,
          await verifyMacCodeSignature(unsignedFfmpeg, app, 'abcdefghij')
        )
      );
      cases.push(
        record(
          suite,
          'team ID with a quote is not interpolated',
          false,
          await verifyMacCodeSignature(unsignedFfmpeg, app, 'ABCDEFGHI"')
        )
      );
      cases.push(
        record(
          suite,
          'app without a team ID (null)',
          false,
          await verifyMacCodeSignature(unsignedFfmpeg, app, null)
        )
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
  'installed CONV2.app ffmpeg passes the team requirement and the full verify path',
  {
    skip:
      macSkip ||
      (fs.existsSync(INSTALLED_FFMPEG) && fs.existsSync(INSTALLED_EXE)
        ? false
        : `${INSTALLED_APP} not installed`),
  },
  async () => {
    const suite = 'installed-app';
    const cases = [
      record(
        suite,
        'signed release ffmpeg verifies against the app team',
        true,
        await verifyMacCodeSignature(INSTALLED_FFMPEG, INSTALLED_EXE)
      ),
      record(
        suite,
        'verifyBundledBinaryChecksum uses the signature path for the installed app',
        true,
        await verifyBundledBinaryChecksum(
          INSTALLED_FFMPEG,
          'ffmpeg',
          'darwin',
          hostArch,
          INSTALLED_EXE
        )
      ),
    ];
    for (const entry of cases) {
      assert.equal(entry.actual, entry.expected, entry.name);
    }
  }
);
