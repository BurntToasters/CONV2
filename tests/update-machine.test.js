const test = require('node:test');
const assert = require('node:assert/strict');
const { initialUpdateState, transition } = require('../dist/main/updateMachine.js');

// Failure modes for the update-check lifecycle. Written before updateMachine.ts.
//  - a check that never ends ("already checking" forever), incl. U1: channel change mid-fallback
//  - beta users never offered a newer stable, or offered an older one
//  - a stale Download dialog (after a channel switch) downloads the wrong feed
//  - a background check hides a ready "Restart Now"
//  - installing twice, or installing with nothing downloaded

const BETA = { betaFeed: true };
const STABLE = { betaFeed: false };

const run = (events, ctx = STABLE, start = initialUpdateState()) => {
  let state = start;
  const log = [];
  for (const event of events) {
    const result = transition(state, event, ctx);
    state = result.state;
    log.push(...result.effects);
  }
  return { state, effects: log };
};
const sends = (effects) => effects.filter((e) => e.type === 'send').map((e) => e.payload.phase);
const has = (effects, type, extra = {}) =>
  effects.some((e) => e.type === type && Object.entries(extra).every(([k, v]) => e[k] === v));

test('manual check starts a check on the current channel', () => {
  const { state, effects } = run([{ type: 'check', mode: 'manual' }]);
  assert.equal(state.check.mode, 'manual');
  assert.ok(has(effects, 'apply-channel', { forceStable: false }));
  assert.ok(has(effects, 'start-check'));
  assert.deepEqual(sends(effects), ['checking']);
});

test('a second manual check while one runs reports already-checking; silent stays quiet', () => {
  const started = run([{ type: 'check', mode: 'silent' }]).state;
  const manual = transition(started, { type: 'check', mode: 'manual' }, STABLE);
  assert.deepEqual(sends(manual.effects), ['already-checking']);
  assert.ok(!has(manual.effects, 'start-check'));
  const silent = transition(started, { type: 'check', mode: 'silent' }, STABLE);
  assert.deepEqual(silent.effects, []);
});

test('no update: check ends, manual gets a dialog, silent does not', () => {
  const manual = run([{ type: 'check', mode: 'manual' }, { type: 'checker-not-available' }]);
  assert.equal(manual.state.check, null);
  assert.ok(sends(manual.effects).includes('not-available'));
  assert.ok(has(manual.effects, 'dialog', { dialog: 'no-updates' }));
  const silent = run([{ type: 'check', mode: 'silent' }, { type: 'checker-not-available' }]);
  assert.ok(!has(silent.effects, 'dialog'));
});

test('beta feed empty: falls back to stable once, then ends and restores the channel', () => {
  const first = run([{ type: 'check', mode: 'silent' }, { type: 'checker-not-available' }], BETA);
  assert.notEqual(first.state.check, null, 'check must stay open during fallback');
  assert.ok(has(first.effects, 'schedule-fallback'));
  const tick = run([{ type: 'fallback-tick' }], BETA, first.state);
  assert.ok(has(tick.effects, 'apply-channel', { forceStable: true }));
  assert.ok(has(tick.effects, 'start-check'));
  const done = run([{ type: 'checker-not-available' }], BETA, tick.state);
  assert.equal(done.state.check, null);
  assert.ok(has(done.effects, 'apply-channel', { forceStable: false }), 'channel not restored');
  assert.ok(!has(done.effects, 'schedule-fallback'), 'fell back twice');
});

test('beta: older stable is refused, newer stable found by fallback is offered', () => {
  const r = run(
    [
      { type: 'check', mode: 'silent' },
      { type: 'checker-available', version: '1.5.1', accepted: false },
      { type: 'fallback-tick' },
      { type: 'checker-available', version: '1.6.0', accepted: true },
    ],
    BETA
  );
  assert.deepEqual(r.state.offer, { version: '1.6.0', epoch: 0 });
  assert.equal(r.state.check, null);
});

test('refused version with no fallback ends the check with no offer', () => {
  const r = run([
    { type: 'check', mode: 'manual' },
    { type: 'checker-available', version: '1.5.1', accepted: false },
  ]);
  assert.equal(r.state.offer, null);
  assert.equal(r.state.check, null);
  assert.ok(sends(r.effects).includes('not-available'));
});

test('U1: channel change while the fallback is scheduled does not wedge the next check', () => {
  const r = run(
    [
      { type: 'check', mode: 'silent' },
      { type: 'checker-not-available' },
      { type: 'channel-changed' },
      { type: 'fallback-tick' },
    ],
    BETA
  );
  assert.equal(r.state.check, null, 'check wedged');
  assert.ok(has(r.effects, 'schedule-silent-check'), 'queued re-check lost');
  const next = transition(r.state, { type: 'check', mode: 'manual' }, BETA);
  assert.ok(!sends(next.effects).includes('already-checking'));
});

test('results of a check that straddled a channel change are discarded', () => {
  const r = run([
    { type: 'check', mode: 'manual' },
    { type: 'channel-changed' },
    { type: 'checker-available', version: '9.9.9', accepted: true },
  ]);
  assert.equal(r.state.offer, null);
  assert.ok(!has(r.effects, 'dialog'));
  assert.ok(has(r.effects, 'schedule-silent-check'));
});

test('idle channel change clears offer and download, bumps epoch, re-checks now', () => {
  const ready = run([{ type: 'downloaded', version: '1.6.1' }]).state;
  const r = transition(
    { ...ready, offer: { version: '1.6.2', epoch: 0 } },
    { type: 'channel-changed' },
    STABLE
  );
  assert.equal(r.state.epoch, 1);
  assert.equal(r.state.offer, null);
  assert.equal(r.state.downloaded, null);
  assert.ok(has(r.effects, 'menu-changed'));
  assert.ok(has(r.effects, 'start-check'));
});

test('a stale Download dialog cannot start a download after a channel change', () => {
  const offered = run([
    { type: 'check', mode: 'manual' },
    { type: 'checker-available', version: '1.6.1', accepted: true },
  ]);
  const dialog = offered.effects.find((e) => e.type === 'dialog' && e.dialog === 'available');
  assert.deepEqual([dialog.version, dialog.epoch], ['1.6.1', 0]);
  const changed = run([{ type: 'channel-changed' }], STABLE, offered.state).state;
  const late = transition(changed, { type: 'download', version: '1.6.1', epoch: 0 }, STABLE);
  assert.ok(!has(late.effects, 'start-download'));
});

test('download with nothing offered reports an error', () => {
  const r = transition(initialUpdateState(), { type: 'download' }, STABLE);
  assert.ok(!has(r.effects, 'start-download'));
  assert.deepEqual(sends(r.effects), ['error']);
});

test('a download that finishes after a channel change is dropped', () => {
  const r = run([
    { type: 'check', mode: 'silent' },
    { type: 'checker-available', version: '1.6.1', accepted: true },
    { type: 'download' },
    { type: 'channel-changed' },
    { type: 'downloaded', version: '1.6.1' },
  ]);
  assert.equal(r.state.downloaded, null);
});

test('ready update survives background checks and errors', () => {
  const ready = run([{ type: 'downloaded', version: '1.6.1' }]).state;
  const r = run(
    [
      { type: 'check', mode: 'silent' },
      { type: 'checker-checking' },
      { type: 'checker-error', message: 'offline' },
      { type: 'check', mode: 'manual' },
      { type: 'checker-available', version: '1.6.1', accepted: true },
    ],
    STABLE,
    ready
  );
  assert.equal(r.state.downloaded, '1.6.1');
  const phases = sends(r.effects);
  assert.ok(!phases.includes('checking') && !phases.includes('error'), phases.join(','));
  assert.ok(phases.includes('downloaded'));
});

test('manual check with a ready update offers Restart instead of "latest version"', () => {
  const ready = run([{ type: 'downloaded', version: '1.6.1' }]).state;
  const r = run(
    [{ type: 'check', mode: 'manual' }, { type: 'checker-not-available' }],
    STABLE,
    ready
  );
  assert.ok(has(r.effects, 'dialog', { dialog: 'already-downloaded' }));
  assert.ok(!has(r.effects, 'dialog', { dialog: 'no-updates' }));
});

test('a newer version replaces a stale ready download', () => {
  const ready = run([{ type: 'downloaded', version: '1.6.1' }]).state;
  const r = run(
    [
      { type: 'check', mode: 'silent' },
      { type: 'checker-available', version: '1.6.2', accepted: true },
    ],
    STABLE,
    ready
  );
  assert.equal(r.state.downloaded, null);
  assert.deepEqual(r.state.offer, { version: '1.6.2', epoch: 0 });
});

test('check start failure ends the check with an error', () => {
  const r = run([
    { type: 'check', mode: 'manual' },
    { type: 'check-rejected', message: 'boom' },
  ]);
  assert.equal(r.state.check, null);
  assert.ok(sends(r.effects).includes('error'));
  const late = transition(r.state, { type: 'check-rejected', message: 'again' }, STABLE);
  assert.deepEqual(late.effects, [], 'rejection after the check ended must be ignored');
});

test('install requires a download, runs once, and recovers from failure', () => {
  const none = transition(initialUpdateState(), { type: 'install' }, STABLE);
  assert.ok(has(none.effects, 'reject'));
  const ready = run([{ type: 'downloaded', version: '1.6.1' }]).state;
  const first = transition(ready, { type: 'install' }, STABLE);
  assert.ok(has(first.effects, 'run-install'));
  assert.equal(first.state.installing, true);
  assert.deepEqual(transition(first.state, { type: 'install' }, STABLE).effects, []);
  const failed = transition(first.state, { type: 'install-failed', message: 'x' }, STABLE);
  assert.equal(failed.state.installing, false);
  assert.ok(sends(failed.effects).includes('error'));
});

test('transition never mutates the previous state', () => {
  const before = initialUpdateState();
  const snapshot = JSON.stringify(before);
  run(
    [
      { type: 'check', mode: 'manual' },
      { type: 'channel-changed' },
      { type: 'downloaded', version: '2' },
    ],
    BETA,
    before
  );
  assert.equal(JSON.stringify(before), snapshot);
});
