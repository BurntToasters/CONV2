const test = require('node:test');
const assert = require('node:assert/strict');
const { forceKillFfmpegProcess } = require('../dist/main/ffmpegProcessControl.js');

// Failure modes:
//  - a child that already exited is killed again (its PID may now belong to another process)
//  - a child killed by a signal (exitCode null, signalCode set) is treated as still running
//  - a live child survives a force kill

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

test('forceKillFfmpegProcess no-ops when the child died from a signal', () => {
  const calls = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => {
    calls.push(['group', pid, sig]);
    return true;
  };
  try {
    forceKillFfmpegProcess({
      exitCode: null,
      signalCode: 'SIGSEGV',
      pid: 424242,
      kill: (sig) => {
        calls.push(['child', sig]);
        return true;
      },
    });
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(calls, []);
});
