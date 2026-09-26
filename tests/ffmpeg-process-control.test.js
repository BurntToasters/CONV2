const test = require('node:test');
const assert = require('node:assert/strict');
const { forceKillFfmpegProcess } = require('../dist/main/ffmpegProcessControl.js');

test('forceKillFfmpegProcess no-ops when the child already exited', () => {
  let killed = false;
  forceKillFfmpegProcess({
    exitCode: 0,
    pid: 424242,
    kill: () => {
      killed = true;
      return true;
    },
  });
  assert.equal(killed, false);
});

test('forceKillFfmpegProcess SIGKILLs the child when group kill cannot run', () => {
  let signal = null;
  forceKillFfmpegProcess({
    exitCode: null,
    pid: 424242424,
    kill: (sig) => {
      signal = sig;
      return true;
    },
  });
  if (process.platform === 'win32') {
    assert.ok(signal === 'SIGKILL' || signal === null);
    return;
  }
  assert.equal(signal, 'SIGKILL');
});
