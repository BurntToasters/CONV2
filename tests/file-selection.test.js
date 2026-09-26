const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeSelectedFilePaths,
  removeSelectedFile,
  moveSelectedFile,
} = require('../dist/shared/fileSelection.js');

test('replace mode drops the previous selection', () => {
  assert.deepEqual(mergeSelectedFilePaths(['/a.mp4'], ['/b.mp4', '/c.mp4'], 'replace'), [
    '/b.mp4',
    '/c.mp4',
  ]);
});

test('append mode unions paths and skips duplicates', () => {
  assert.deepEqual(mergeSelectedFilePaths(['/a.mp4', '/b.mp4'], ['/b.mp4', '/c.mp4'], 'append'), [
    '/a.mp4',
    '/b.mp4',
    '/c.mp4',
  ]);
});

test('empty and blank incoming paths are ignored', () => {
  assert.deepEqual(mergeSelectedFilePaths(['/a.mp4'], ['', '/b.mp4'], 'append'), [
    '/a.mp4',
    '/b.mp4',
  ]);
});

test('removeSelectedFile drops one index', () => {
  assert.deepEqual(removeSelectedFile(['/a.mp4', '/b.mp4', '/c.mp4'], 1), ['/a.mp4', '/c.mp4']);
  assert.deepEqual(removeSelectedFile(['/a.mp4'], 4), ['/a.mp4']);
});

test('moveSelectedFile swaps neighbors and no-ops at edges', () => {
  assert.deepEqual(moveSelectedFile(['/a.mp4', '/b.mp4', '/c.mp4'], 0, 1), [
    '/b.mp4',
    '/a.mp4',
    '/c.mp4',
  ]);
  assert.deepEqual(moveSelectedFile(['/a.mp4', '/b.mp4'], 0, -1), ['/a.mp4', '/b.mp4']);
  assert.deepEqual(moveSelectedFile(['/a.mp4', '/b.mp4'], 1, 1), ['/a.mp4', '/b.mp4']);
});
