const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHwProbeStore, binaryFingerprint } = require('../dist/main/hwProbeStore.js');

// Failure modes for caching hardware-encoder probe results on disk. Written before the store.
//  - a stale "unavailable" survives an FFmpeg upgrade or driver install forever
//  - a corrupt or hand-edited cache file crashes startup or yields non-boolean results
//  - a write failure (read-only profile) throws into the conversion path
//  - a half-written file is read back after a crash
//  - the Refresh button cannot force a re-probe

const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-probe-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const DAY = 24 * 60 * 60 * 1000;

test('missing file starts empty', () => {
  withDir((dir) => {
    const store = createHwProbeStore({ filePath: path.join(dir, 'p.json'), fingerprint: 'a' });
    assert.equal(store.get('h264_nvenc'), undefined);
  });
});

test('results persist across instances with the same fingerprint', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'p.json');
    const first = createHwProbeStore({ filePath, fingerprint: 'ffmpeg-8.1.2' });
    first.set('h264_nvenc', true);
    first.set('av1_nvenc', false);
    const second = createHwProbeStore({ filePath, fingerprint: 'ffmpeg-8.1.2' });
    assert.equal(second.get('h264_nvenc'), true);
    assert.equal(second.get('av1_nvenc'), false);
  });
});

test('a different FFmpeg binary invalidates every result', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'p.json');
    createHwProbeStore({ filePath, fingerprint: 'old' }).set('h264_nvenc', false);
    assert.equal(createHwProbeStore({ filePath, fingerprint: 'new' }).get('h264_nvenc'), undefined);
  });
});

test('results older than the TTL are ignored', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'p.json');
    let now = 1_000_000;
    createHwProbeStore({ filePath, fingerprint: 'a', now: () => now }).set('hevc_qsv', true);
    now += 8 * DAY;
    assert.equal(
      createHwProbeStore({ filePath, fingerprint: 'a', now: () => now }).get('hevc_qsv'),
      undefined
    );
  });
});

test('corrupt, truncated, or wrongly shaped files are ignored without throwing', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'p.json');
    const bad = [
      '{',
      'null',
      '[]',
      '"x"',
      JSON.stringify({ fingerprint: 'a', savedAt: Date.now(), results: 'yes' }),
    ];
    for (const content of bad) {
      fs.writeFileSync(filePath, content);
      assert.equal(
        createHwProbeStore({ filePath, fingerprint: 'a' }).get('h264_nvenc'),
        undefined,
        content
      );
    }
  });
});

test('non-boolean entries are dropped', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'p.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        fingerprint: 'a',
        savedAt: Date.now(),
        results: { h264_nvenc: 'true', hevc_qsv: true },
      })
    );
    const store = createHwProbeStore({ filePath, fingerprint: 'a' });
    assert.equal(store.get('h264_nvenc'), undefined);
    assert.equal(store.get('hevc_qsv'), true);
  });
});

test('clear forgets memory and disk so Refresh re-probes', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'p.json');
    const store = createHwProbeStore({ filePath, fingerprint: 'a' });
    store.set('h264_nvenc', true);
    store.clear();
    assert.equal(store.get('h264_nvenc'), undefined);
    assert.equal(createHwProbeStore({ filePath, fingerprint: 'a' }).get('h264_nvenc'), undefined);
  });
});

test('write failures are swallowed and memory still works', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'missing-dir', 'nested', 'p.json');
    fs.writeFileSync(path.join(dir, 'missing-dir'), 'a file where a directory should be');
    const store = createHwProbeStore({ filePath, fingerprint: 'a' });
    assert.doesNotThrow(() => store.set('h264_nvenc', true));
    assert.equal(store.get('h264_nvenc'), true);
  });
});

test('writes are atomic: no temp file is left behind', () => {
  withDir((dir) => {
    const filePath = path.join(dir, 'p.json');
    createHwProbeStore({ filePath, fingerprint: 'a' }).set('h264_nvenc', true);
    assert.deepEqual(fs.readdirSync(dir), ['p.json']);
  });
});

test('fingerprint changes when the binary changes and is stable otherwise', () => {
  withDir((dir) => {
    const bin = path.join(dir, 'ffmpeg');
    fs.writeFileSync(bin, 'v1');
    const a = binaryFingerprint(bin, '1.6.0');
    assert.equal(binaryFingerprint(bin, '1.6.0'), a);
    fs.writeFileSync(bin, 'version two');
    assert.notEqual(binaryFingerprint(bin, '1.6.0'), a);
    assert.notEqual(binaryFingerprint(bin, '1.6.1'), binaryFingerprint(bin, '1.6.0'));
    assert.match(binaryFingerprint('ffmpeg', '1.6.0'), /ffmpeg/);
  });
});
