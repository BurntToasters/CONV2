const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeOverallProgress,
  summarizeQueueForNotification,
  buildWindowsJumpList,
  parseConv2JumpArg,
} = require('../dist/main/osIntegration.js');
const { createEmptyQueueSnapshot } = require('../dist/main/conversionQueue.js');

test('computeOverallProgress single file', () => {
  assert.equal(computeOverallProgress(50, null), 0.5);
  assert.equal(computeOverallProgress(100, null), 1);
});

test('computeOverallProgress batch blends file index', () => {
  assert.equal(computeOverallProgress(50, { fileIndex: 0, fileCount: 2 }), 0.25);
  assert.equal(computeOverallProgress(100, { fileIndex: 1, fileCount: 2 }), 1);
});

test('summarizeQueueForNotification batch outcomes', () => {
  const snapshot = createEmptyQueueSnapshot();
  snapshot.total = 2;
  snapshot.items = [
    {
      id: 'a',
      inputPath: '/a.mp4',
      fileName: 'a.mp4',
      status: 'done',
      outputPath: '/out/a.mp4',
    },
    {
      id: 'b',
      inputPath: '/b.mp4',
      fileName: 'b.mp4',
      status: 'failed',
      error: 'boom',
    },
  ];
  const summary = summarizeQueueForNotification(snapshot);
  assert.match(summary.body, /1 succeeded/);
});

test('buildWindowsJumpList includes core tasks', () => {
  const categories = buildWindowsJumpList({
    pickVideoFiles: async () => [],
    sendMenuAction: () => {},
    checkForUpdates: () => {},
    isUpdateDisabled: () => false,
  });
  assert.equal(categories.length, 1);
  assert.equal(categories[0].type, 'tasks');
  const tasks = categories[0].items ?? [];
  assert.ok(tasks.length >= 3);
  assert.ok(tasks.every((task) => task.type === 'task'));
});

test('parseConv2JumpArg reads argv flag', () => {
  assert.equal(parseConv2JumpArg(['electron', '.', '--conv2-jump=open-settings']), 'open-settings');
  assert.equal(parseConv2JumpArg(['electron', '.']), null);
});
