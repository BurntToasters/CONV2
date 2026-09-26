const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { MAX_QUEUE_ITEMS, runConversionQueue } = require('../dist/main/conversionQueue');
const { redactPaths } = require('../dist/main/ffmpeg');

test('the queue exposes a bounded batch size', () => {
  assert.equal(typeof MAX_QUEUE_ITEMS, 'number');
  assert.ok(MAX_QUEUE_ITEMS > 0 && Number.isFinite(MAX_QUEUE_ITEMS));
});

// Payload validation, busy, and oversized-batch refusals are covered in queue-request.test.js.

test('queue still runs a normal batch to completion', async () => {
  const snapshots = [];
  const result = await runConversionQueue(
    { inputPaths: ['/videos/a.mp4', '/videos/b.mp4'], presetId: 'av1-balanced', gpu: 'cpu' },
    {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onProgress: () => {},
      convertOne: async ({ inputPath }) => ({
        success: true,
        outputPath: `${inputPath}.out`,
      }),
      shouldRetryWithCpu: () => false,
      hasVideoCodec: true,
      isCancelled: () => false,
    }
  );

  assert.equal(result.total, 2);
  assert.equal(result.active, false);
  assert.deepEqual(
    result.items.map((item) => item.status),
    ['done', 'done']
  );
  assert.ok(snapshots.length >= 2, 'progress snapshots should be emitted per item');
});

test('debug log redaction hides the current user home', () => {
  const os = require('node:os');
  const home = os.homedir();
  const redacted = redactPaths(`Running command: ffmpeg -i ${home}/Movies/clip.mp4\n`);
  assert.equal(redacted.includes(home), false);
  assert.match(redacted, /~\/Movies\/clip\.mp4/);
});

test('debug log redaction hides other accounts home-shaped paths', () => {
  // Paths from other volumes/accounts reached the log unredacted before.
  assert.match(redactPaths('/Users/someoneelse/Movies/a.mp4'), /^\/Users\/~\/Movies\/a\.mp4$/);
  assert.match(redactPaths('/home/otheruser/videos/b.mkv'), /^\/home\/~\/videos\/b\.mkv$/);
  assert.match(
    redactPaths('C:\\Users\\OtherPerson\\Videos\\c.mp4'),
    /^C:\\Users\\~\\Videos\\c\.mp4$/
  );
});

test('redaction leaves non-home paths and empty input intact', () => {
  assert.equal(redactPaths(''), '');
  assert.equal(redactPaths('/opt/media/clip.mp4'), '/opt/media/clip.mp4');
});
