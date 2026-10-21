const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuitGuard } = require('../dist/main/quitGuard.js');

// Failure modes for quitting while a conversion runs. Written before quitGuard.ts.

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const setup = (overrides = {}) => {
  const calls = [];
  const state = { active: true, updating: false, answers: [] };
  const deps = {
    isConversionActive: () => state.active,
    isUpdateInstallInProgress: () => state.updating,
    confirmQuit: () => {
      calls.push('confirm');
      const next = state.answers.shift();
      return next ? next.promise : Promise.resolve(true);
    },
    stopConversion: async () => {
      calls.push('stop');
    },
    onError: (error) => calls.push(`error:${error instanceof Error ? error.message : error}`),
    ...overrides,
  };
  return { guard: createQuitGuard(deps), calls, state };
};

test('quit during a conversion is deferred and asks first', async () => {
  const { guard, calls } = setup();
  const proceed = guard.request(() => calls.push('resume'));
  assert.equal(proceed, false);
  await guard.settled();
  assert.deepEqual(calls, ['confirm', 'stop', 'resume']);
});

test('idle quit proceeds without a prompt', async () => {
  const { guard, calls, state } = setup();
  state.active = false;
  assert.equal(
    guard.request(() => calls.push('resume')),
    true
  );
  await guard.settled();
  assert.deepEqual(calls, []);
});

test('update install quits without a prompt', async () => {
  const { guard, calls, state } = setup();
  state.updating = true;
  assert.equal(
    guard.request(() => calls.push('resume')),
    true
  );
  await guard.settled();
  assert.deepEqual(calls, []);
});

test('declining keeps the conversion running and the app open', async () => {
  const { guard, calls, state } = setup();
  const answer = deferred();
  state.answers.push(answer);
  guard.request(() => calls.push('resume'));
  answer.resolve(false);
  await guard.settled();
  assert.deepEqual(calls, ['confirm']);
});

test('declining does not wedge the guard; the next quit asks again', async () => {
  const { guard, calls, state } = setup();
  const first = deferred();
  state.answers.push(first);
  guard.request(() => calls.push('resume'));
  first.resolve(false);
  await guard.settled();
  assert.equal(
    guard.request(() => calls.push('resume')),
    false
  );
  await guard.settled();
  assert.deepEqual(calls, ['confirm', 'confirm', 'stop', 'resume']);
});

test('confirmed quit waits for FFmpeg to stop before resuming', async () => {
  const stopped = deferred();
  const calls = [];
  const guard = createQuitGuard({
    isConversionActive: () => true,
    isUpdateInstallInProgress: () => false,
    confirmQuit: async () => true,
    stopConversion: () => stopped.promise,
  });
  guard.request(() => calls.push('resume'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  stopped.resolve();
  await guard.settled();
  assert.deepEqual(calls, ['resume']);
});

test('repeated quit requests share one dialog and all resume', async () => {
  const { guard, calls, state } = setup();
  const answer = deferred();
  state.answers.push(answer);
  assert.equal(
    guard.request(() => calls.push('close-window')),
    false
  );
  assert.equal(
    guard.request(() => calls.push('app-quit')),
    false
  );
  answer.resolve(true);
  await guard.settled();
  assert.deepEqual(calls, ['confirm', 'stop', 'close-window', 'app-quit']);
});

test('re-entrant quit after confirmation does not prompt again', async () => {
  const { guard, calls } = setup();
  guard.request(() => calls.push('resume'));
  await guard.settled();
  // FFmpeg may outlive the stop timeout, so the conversion can still look active.
  assert.equal(
    guard.request(() => calls.push('again')),
    true
  );
  assert.deepEqual(calls, ['confirm', 'stop', 'resume']);
});

test('dialog failure keeps the app open and re-arms the prompt', async () => {
  const { guard, calls, state } = setup();
  const answer = deferred();
  state.answers.push(answer);
  guard.request(() => calls.push('resume'));
  answer.reject(new Error('dialog failed'));
  await guard.settled();
  assert.deepEqual(calls, ['confirm', 'error:dialog failed']);
  assert.equal(
    guard.request(() => calls.push('resume')),
    false
  );
  await guard.settled();
});

test('stop failure still honours the confirmed quit', async () => {
  const calls = [];
  const guard = createQuitGuard({
    isConversionActive: () => true,
    isUpdateInstallInProgress: () => false,
    confirmQuit: async () => true,
    stopConversion: async () => {
      throw new Error('stop failed');
    },
    onError: (error) => calls.push(`error:${error.message}`),
  });
  guard.request(() => calls.push('resume'));
  await guard.settled();
  assert.deepEqual(calls, ['error:stop failed', 'resume']);
});

test('a throwing resume does not block the others', async () => {
  const { guard, calls } = setup();
  guard.request(() => {
    throw new Error('window gone');
  });
  guard.request(() => calls.push('app-quit'));
  await guard.settled();
  assert.deepEqual(calls, ['confirm', 'stop', 'error:window gone', 'app-quit']);
});

test('confirmation does not carry over to the next conversion', async () => {
  const { guard, calls } = setup();
  guard.request(() => calls.push('resume'));
  await guard.settled();
  guard.reset();
  assert.equal(
    guard.request(() => calls.push('resume')),
    false
  );
  await guard.settled();
  assert.deepEqual(calls, ['confirm', 'stop', 'resume', 'confirm', 'stop', 'resume']);
});
