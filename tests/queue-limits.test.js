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

test('queue IPC validates the payload before reading its fields', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8');
  const handlerStart = source.indexOf("ipcMain.handle(\n  'start-conversion-queue'");
  assert.ok(handlerStart > -1, 'start-conversion-queue handler not found');
  const handler = source.slice(handlerStart, handlerStart + 4000);

  // The busy branch must not dereference payload before it has been validated.
  assert.doesNotMatch(handler, /\(payload\.inputPaths \|\| \[\]\)/);
  assert.match(handler, /Array\.isArray\(payload\?\.inputPaths\)/);

  const guardIndex = handler.indexOf('Array.isArray(payload?.inputPaths)');
  const busyIndex = handler.indexOf('isConversionActive');
  assert.ok(
    guardIndex < busyIndex,
    'payload validation must happen before the busy-state branch reads inputPaths'
  );
  assert.match(handler, /MAX_QUEUE_ITEMS/);
});

test('oversized batches are refused rather than queued', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(source, /inputPaths\.length > MAX_QUEUE_ITEMS/);
  assert.match(source, /A single batch is limited to \$\{MAX_QUEUE_ITEMS\} files/);
});

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
