const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFatalErrorHandler } = require('../dist/main/fatalErrors.js');

// Failure modes for main-process crashes. Written before fatalErrors.ts.
//  - errors are swallowed with no trace for the user or for a bug report
//  - an error loop opens dozens of dialogs
//  - showing the dialog before the app is ready throws a second error
//  - the crash log grows without bound or leaks home-directory paths
//  - a non-Error rejection (string, undefined) crashes the handler itself

const withLog = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-crash-'));
  try {
    return fn(path.join(dir, 'logs', 'main-errors.log'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const setup = (logPath, overrides = {}) => {
  const shown = [];
  const handler = createFatalErrorHandler({
    logPath,
    redact: (text) => text.replaceAll('/Users/alice', '~'),
    isReady: () => true,
    showError: (title, body) => shown.push({ title, body }),
    now: () => new Date('2026-09-26T00:00:00Z'),
    ...overrides,
  });
  return { handler, shown };
};

test('uncaught exceptions are logged and shown once per session', () => {
  withLog((logPath) => {
    const { handler, shown } = setup(logPath);
    handler.onUncaughtException(new Error('boom at /Users/alice/Videos/a.mp4'));
    handler.onUncaughtException(new Error('boom again'));
    assert.equal(shown.length, 1);
    assert.match(shown[0].body, /boom at ~\/Videos\/a\.mp4/);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /2026-09-26T00:00:00\.000Z uncaughtException/);
    assert.match(log, /boom again/);
    assert.doesNotMatch(log, /\/Users\/alice/);
  });
});

test('unhandled rejections are logged but never interrupt the user', () => {
  withLog((logPath) => {
    const { handler, shown } = setup(logPath);
    for (const reason of ['plain string', undefined, null, 42, { code: 'EPIPE' }]) {
      assert.doesNotThrow(() => handler.onUnhandledRejection(reason));
    }
    assert.equal(shown.length, 0);
    assert.match(fs.readFileSync(logPath, 'utf8'), /unhandledRejection\nplain string/);
  });
});

test('no dialog before the app is ready; the log is still written', () => {
  withLog((logPath) => {
    const { handler, shown } = setup(logPath, { isReady: () => false });
    handler.onUncaughtException(new Error('early'));
    assert.equal(shown.length, 0);
    assert.match(fs.readFileSync(logPath, 'utf8'), /early/);
  });
});

test('a failing dialog or unwritable log never throws out of the handler', () => {
  const { handler } = setup('/dev/null/not-a-dir/log.txt', {
    showError: () => {
      throw new Error('dialog failed');
    },
  });
  assert.doesNotThrow(() => handler.onUncaughtException(new Error('x')));
});

test('the log is capped and keeps the newest entries', () => {
  withLog((logPath) => {
    const { handler } = setup(logPath, { maxLogBytes: 2048 });
    for (let i = 0; i < 200; i += 1) handler.onUnhandledRejection(`entry-${i}-${'x'.repeat(40)}`);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.ok(Buffer.byteLength(log) <= 2048, `log is ${Buffer.byteLength(log)} bytes`);
    assert.match(log, /entry-199-/);
    assert.doesNotMatch(log, /entry-0-/);
  });
});
