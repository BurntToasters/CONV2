const test = require('node:test');
const assert = require('node:assert/strict');
const { CONVERSION_IPC_CHANNELS } = require('../dist/main/conversionIpc.js');

test('conversion IPC channel registry', () => {
  assert.deepEqual(CONVERSION_IPC_CHANNELS, [
    'start-conversion',
    'start-conversion-queue',
    'cancel-conversion',
  ]);
});
