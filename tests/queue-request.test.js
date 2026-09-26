const test = require('node:test');
const assert = require('node:assert/strict');
const { validateQueueRequest } = require('../dist/main/conversionController.js');
const { MAX_QUEUE_ITEMS } = require('../dist/main/conversionQueue.js');

// Failure modes for the start-conversion-queue IPC payload. Written before validateQueueRequest.
//  - a malformed payload (null, wrong types) throws out of the IPC handler
//  - a second batch starts while one is running
//  - an oversized batch is queued anyway
//  - an unknown preset or GPU vendor reaches FFmpeg
//  - non-string or empty paths are passed on

const presets = { 'h264-fast': { id: 'h264-fast' } };
const validate = (payload, isBusy = false) =>
  validateQueueRequest(payload, { isBusy, getPreset: (id) => presets[id] });

test('malformed payloads never throw and produce an empty rejection', () => {
  for (const payload of [null, undefined, 42, 'x', [], { inputPaths: 'a.mp4' }]) {
    const result = validate(payload);
    assert.equal(result.kind, 'reject', JSON.stringify(payload));
    assert.deepEqual(result.snapshot.items, []);
  }
});

test('non-string and empty paths are dropped', () => {
  const result = validate({
    inputPaths: ['a.mp4', '', 7, null, 'b.mp4'],
    presetId: 'h264-fast',
    gpu: 'cpu',
  });
  assert.equal(result.kind, 'run');
  assert.deepEqual(result.inputPaths, ['a.mp4', 'b.mp4']);
});

test('a busy app rejects every file with a clear reason', () => {
  const result = validate(
    { inputPaths: ['a.mp4', 'b.mp4'], presetId: 'h264-fast', gpu: 'cpu' },
    true
  );
  assert.equal(result.kind, 'reject');
  assert.equal(result.snapshot.total, 2);
  assert.ok(
    result.snapshot.items.every(
      (item) => item.status === 'failed' && /already in progress/.test(item.error)
    )
  );
});

test('oversized batches are refused, not truncated and run', () => {
  const inputPaths = Array.from({ length: MAX_QUEUE_ITEMS + 1 }, (_, i) => `f${i}.mp4`);
  const result = validate({ inputPaths, presetId: 'h264-fast', gpu: 'cpu' });
  assert.equal(result.kind, 'reject');
  assert.equal(result.snapshot.total, MAX_QUEUE_ITEMS + 1);
  assert.equal(result.snapshot.items.length, MAX_QUEUE_ITEMS);
  assert.match(result.snapshot.items[0].error, new RegExp(`limited to ${MAX_QUEUE_ITEMS} files`));
});

test('a batch of exactly the limit is accepted', () => {
  const inputPaths = Array.from({ length: MAX_QUEUE_ITEMS }, (_, i) => `f${i}.mp4`);
  assert.equal(validate({ inputPaths, presetId: 'h264-fast', gpu: 'cpu' }).kind, 'run');
});

test('unknown presets are rejected per file', () => {
  const result = validate({ inputPaths: ['a.mp4'], presetId: 'nope', gpu: 'cpu' });
  assert.equal(result.kind, 'reject');
  assert.equal(result.snapshot.items[0].error, 'Invalid preset selected');
});

test('unknown GPU vendors are coerced to CPU', () => {
  const result = validate({ inputPaths: ['a.mp4'], presetId: 'h264-fast', gpu: 'quantum' });
  assert.equal(result.kind, 'run');
  assert.equal(result.gpu, 'cpu');
});

test('optional flags keep only correctly typed values', () => {
  const result = validate({
    inputPaths: ['a.mp4'],
    presetId: 'h264-fast',
    gpu: 'apple',
    removeSpacesFromFilenames: 'yes',
    outputDirectory: 42,
    showDebugOutput: true,
  });
  assert.equal(result.removeSpacesFromFilenames, undefined);
  assert.equal(result.outputDirectory, undefined);
  assert.equal(result.showDebugOutput, true);
  assert.equal(result.gpu, 'apple');
});
