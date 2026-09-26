const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  isMissingBundledBinaryPath,
  runtimeFfmpegTarget,
  findChecksumsManifest,
  sha256File,
  expectedChecksumForBinary,
  verifyBundledBinaryChecksum,
} = require('../dist/main/ffmpegIntegrity.js');

test('missing bundled sentinels fail closed', () => {
  assert.equal(isMissingBundledBinaryPath('/res/ffmpeg/__missing_ffmpeg'), true);
  assert.equal(isMissingBundledBinaryPath('/res/ffmpeg/ffmpeg'), false);
});

test('runtime target keys match checksums.json', () => {
  assert.equal(runtimeFfmpegTarget('darwin', 'arm64'), 'mac:arm64');
  assert.equal(runtimeFfmpegTarget('win32', 'x64'), 'win:x64');
  assert.equal(runtimeFfmpegTarget('linux', 'x64'), 'linux:x64');
});

test('checksum verify matches a staged binary and rejects a swap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-hash-'));
  const binaryPath = path.join(dir, 'nested', 'ffmpeg');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, 'ffmpeg-bytes');
  const digest = crypto.createHash('sha256').update('ffmpeg-bytes').digest('hex');
  fs.writeFileSync(
    path.join(dir, 'checksums.json'),
    JSON.stringify({
      'mac:arm64': { binaries: { ffmpeg: { sha256: digest } } },
    })
  );

  assert.equal(findChecksumsManifest(path.dirname(binaryPath)), path.join(dir, 'checksums.json'));
  assert.equal(sha256File(binaryPath), digest);
  assert.equal(
    expectedChecksumForBinary(path.join(dir, 'checksums.json'), 'mac:arm64', 'ffmpeg'),
    digest
  );
  assert.equal(verifyBundledBinaryChecksum(binaryPath, 'ffmpeg', 'darwin', 'arm64'), true);

  fs.writeFileSync(binaryPath, 'tampered');
  assert.equal(verifyBundledBinaryChecksum(binaryPath, 'ffmpeg', 'darwin', 'arm64'), false);
});

test('PATH / system binaries skip checksums', () => {
  assert.equal(verifyBundledBinaryChecksum('ffmpeg', 'ffmpeg', 'darwin', 'arm64'), true);
});
