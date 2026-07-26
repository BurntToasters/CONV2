const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  PRESERVED_DEST_FILES,
  findExtractedFile,
  installVerifiedBinaries,
  verifyStagedBinaries,
} = require('../build-scripts/get-ffmpeg.js');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const makeTempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `conv2-test-${label}-`));

test('requiring get-ffmpeg does not start a download', () => {
  // The module is only safe to unit test because main() is guarded by
  // require.main. If that guard regresses, importing it would hit the network.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'build-scripts', 'get-ffmpeg.js'),
    'utf8'
  );
  assert.match(source, /if \(require\.main === module\) \{/);
});

test('staged payload is rejected when it has no recorded checksums', () => {
  const staging = makeTempDir('staging');
  try {
    fs.writeFileSync(path.join(staging, 'ffmpeg'), 'fake');
    fs.writeFileSync(path.join(staging, 'ffprobe'), 'fake');
    // "linux:mips" has no manifest entry, standing in for an unknown target.
    assert.throws(
      () => verifyStagedBinaries(staging, 'linux', 'mips', {}),
      /No known binary layout/
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('staged payload is rejected when a hash does not match the manifest', () => {
  const staging = makeTempDir('staging');
  try {
    // Real target with real recorded hashes, but tampered contents.
    fs.writeFileSync(path.join(staging, 'ffmpeg'), 'tampered');
    fs.writeFileSync(path.join(staging, 'ffprobe'), 'tampered');
    assert.throws(
      () => verifyStagedBinaries(staging, 'linux', 'x64', {}),
      /SHA-256 mismatch for (ffmpeg|ffprobe)/
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('verification fails when the archive is missing an expected binary', () => {
  const staging = makeTempDir('staging');
  try {
    fs.writeFileSync(path.join(staging, 'ffmpeg'), 'only ffmpeg here');
    assert.throws(
      () => verifyStagedBinaries(staging, 'linux', 'x64', {}),
      /did not contain the expected binary: ffprobe/
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('binaries are found inside a nested archive root', () => {
  const staging = makeTempDir('staging');
  try {
    const nested = path.join(staging, 'ffmpeg-8.1.2', 'bin');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'ffprobe'), 'nested');
    assert.equal(findExtractedFile(staging, 'ffprobe'), path.join(nested, 'ffprobe'));
    assert.equal(findExtractedFile(staging, 'does-not-exist'), null);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('install replaces stale files but preserves tracked placeholders', () => {
  const staging = makeTempDir('staging');
  const dest = makeTempDir('dest');
  try {
    const ffmpegPath = path.join(staging, 'ffmpeg');
    const ffprobePath = path.join(staging, 'ffprobe');
    fs.writeFileSync(ffmpegPath, 'new ffmpeg');
    fs.writeFileSync(ffprobePath, 'new ffprobe');

    // Pre-existing destination: a tracked placeholder, an old binary, and a
    // stale leftover from a previous archive that must not survive.
    for (const preserved of PRESERVED_DEST_FILES) {
      fs.writeFileSync(path.join(dest, preserved), 'keep me');
    }
    fs.writeFileSync(path.join(dest, 'ffmpeg'), 'old ffmpeg');
    fs.writeFileSync(path.join(dest, 'stale-extra-file.dll'), 'stale');

    installVerifiedBinaries({ ffmpeg: ffmpegPath, ffprobe: ffprobePath }, dest, 'linux');

    const remaining = fs.readdirSync(dest).sort();
    assert.deepEqual(remaining, ['PLACE_BINARIES_HERE.txt', 'ffmpeg', 'ffprobe']);
    assert.equal(fs.readFileSync(path.join(dest, 'ffmpeg'), 'utf8'), 'new ffmpeg');
    assert.equal(fs.readFileSync(path.join(dest, 'PLACE_BINARIES_HERE.txt'), 'utf8'), 'keep me');
    assert.equal(
      sha256(fs.readFileSync(path.join(dest, 'ffprobe'))),
      sha256(Buffer.from('new ffprobe'))
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('installed binaries are executable on POSIX targets', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permission bits are not meaningful on Windows');
    return;
  }
  const staging = makeTempDir('staging');
  const dest = makeTempDir('dest');
  try {
    const ffmpegPath = path.join(staging, 'ffmpeg');
    fs.writeFileSync(ffmpegPath, 'binary', { mode: 0o600 });
    installVerifiedBinaries({ ffmpeg: ffmpegPath }, dest, 'linux');
    const mode = fs.statSync(path.join(dest, 'ffmpeg')).mode & 0o777;
    assert.equal(mode, 0o755);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('install preserves sidecar files shipped alongside the binaries', () => {
  // Only ffmpeg/ffprobe are checksum-verified, but a future payload could ship
  // shared libraries next to them; truncating the payload would break the build.
  const staging = makeTempDir('staging');
  const dest = makeTempDir('dest');
  try {
    const ffmpegPath = path.join(staging, 'ffmpeg');
    const ffprobePath = path.join(staging, 'ffprobe');
    fs.writeFileSync(ffmpegPath, 'ffmpeg');
    fs.writeFileSync(ffprobePath, 'ffprobe');
    fs.writeFileSync(path.join(staging, 'libsomething.so.1'), 'sidecar');
    fs.mkdirSync(path.join(staging, 'presets'));
    fs.writeFileSync(path.join(staging, 'presets', 'libx264-medium.avpreset'), 'preset');

    installVerifiedBinaries({ ffmpeg: ffmpegPath, ffprobe: ffprobePath }, dest, 'linux');

    const remaining = fs.readdirSync(dest).sort();
    assert.deepEqual(remaining, ['ffmpeg', 'ffprobe', 'libsomething.so.1', 'presets']);
    assert.equal(
      fs.readFileSync(path.join(dest, 'presets', 'libx264-medium.avpreset'), 'utf8'),
      'preset'
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('install refuses an empty payload', () => {
  const dest = makeTempDir('dest');
  try {
    assert.throws(() => installVerifiedBinaries({}, dest, 'linux'), /No verified binaries/);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
