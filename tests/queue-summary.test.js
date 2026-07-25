const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeQueueForNotification,
  summarizeQueueForUiStatus,
} = require('../dist/shared/queueSummary.js');

test('batch partial failure notification and UI match', () => {
  const input = {
    total: 2,
    items: [
      { status: 'done', fileName: 'a.mp4' },
      { status: 'failed', fileName: 'b.mp4', error: 'boom' },
    ],
  };
  const notification = summarizeQueueForNotification(input);
  const ui = summarizeQueueForUiStatus(input);
  assert.equal(ui.message, notification.body);
  assert.match(notification.body, /1 succeeded/);
});

test('batch cancel with partial success uses shared copy', () => {
  const input = {
    total: 3,
    items: [
      { status: 'done', fileName: 'a.mp4' },
      { status: 'cancelled', fileName: 'b.mp4' },
      { status: 'cancelled', fileName: 'c.mp4' },
    ],
  };
  const notification = summarizeQueueForNotification(input);
  const ui = summarizeQueueForUiStatus(input, { wasCancelled: true });
  assert.equal(notification.body, '1 of 3 videos converted before cancel.');
  assert.equal(ui.message, notification.body);
});
