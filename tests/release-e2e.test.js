// Release E2E gate: build-scripts/release-e2e.js, run by release:prepare on the release VMs.
// Failure modes covered here:
//  1. Linux without a display launches Electron with no X server instead of under xvfb-run.
//  2. Linux without a display or xvfb-run fails the release instead of skipping loudly.
//  3. A machine that has a display still gets wrapped in xvfb-run.
//  4. A probe failure on macOS, Windows, or Linux with a real display is skipped and ships untested.
//  5. A probe failure inside the gate's own xvfb-run display runs the suite anyway or skips silently.
//  6. A skip is silent: no warning, or no record in coverage/e2e.
//  7. A failing suite (the app did launch) is treated as a skip and the release goes on.
//  8. Conversion tests skip because CONV2_REQUIRE_FFMPEG_TESTS=1 is not set on the suite.
//  9. A build failure is reported as a display skip.
// 10. release:prepare does not run the gate, or runs it before test:all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const gate = () => require('../build-scripts/release-e2e.js');

const isProbe = (step) => step.args.some((arg) => arg.endsWith('display-probe.js'));
const isSuite = (step) => step.args.some((arg) => arg.endsWith('run-e2e.js'));
const isBuild = (step) => step.args.includes('build') && !isProbe(step) && !isSuite(step);

function simulate({ platform = 'darwin', env = {}, hasXvfb = false, fail = {} } = {}) {
  const steps = [];
  const records = [];
  const warnings = [];
  const status = gate().releaseE2E({
    platform,
    env,
    hasXvfb: () => hasXvfb,
    record: (entry) => records.push(entry),
    warn: (message) => warnings.push(message),
    run: (step) => {
      steps.push(step);
      if (isBuild(step)) return fail.build ?? 0;
      if (isProbe(step)) return fail.probe ?? 0;
      if (isSuite(step)) return fail.suite ?? 0;
      return 0;
    },
  });
  return { status, steps, records, warnings };
}

test('Linux without a display runs the probe and the suite under xvfb-run', () => {
  const { status, steps } = simulate({ platform: 'linux', env: {}, hasXvfb: true });
  assert.equal(status, 0);
  for (const step of steps.filter((s) => isProbe(s) || isSuite(s))) {
    assert.equal(step.command, 'xvfb-run');
    assert.equal(step.args[0], '-a');
  }
  assert.ok(steps.some(isSuite), 'suite must run');
});

test('Linux without a display or xvfb-run skips loudly before building', () => {
  const { status, steps, records, warnings } = simulate({ platform: 'linux', hasXvfb: false });
  assert.equal(status, 0);
  assert.equal(steps.length, 0);
  assert.equal(records.at(-1).status, 'skipped');
  assert.match(records.at(-1).reason, /xvfb/);
  assert.match(warnings.join('\n'), /E2E SKIPPED/);
});

test('a machine with a display is not wrapped in xvfb-run', () => {
  for (const [platform, env] of [
    ['linux', { DISPLAY: ':0' }],
    ['linux', { WAYLAND_DISPLAY: 'wayland-0' }],
    ['darwin', {}],
    ['win32', {}],
  ]) {
    const { steps } = simulate({ platform, env, hasXvfb: true });
    assert.ok(steps.length > 0, platform);
    for (const step of steps) assert.notEqual(step.command, 'xvfb-run', platform);
  }
});

test('a failed display probe blocks the release where a display exists', () => {
  for (const [platform, env] of [
    ['darwin', {}],
    ['win32', {}],
    ['linux', { DISPLAY: ':0' }],
    ['linux', { WAYLAND_DISPLAY: 'wayland-0' }],
  ]) {
    const { status, steps, records } = simulate({ platform, env, fail: { probe: 1 } });
    assert.equal(status, 1, platform);
    assert.ok(!steps.some(isSuite), `${platform}: suite must not run`);
    assert.equal(records.at(-1).status, 'failed', platform);
    assert.match(records.at(-1).reason, /hidden window/, platform);
  }
});

test('a failed probe under the gate xvfb-run display skips loudly', () => {
  const { status, steps, records, warnings } = simulate({
    platform: 'linux',
    env: {},
    hasXvfb: true,
    fail: { probe: 1 },
  });
  assert.equal(status, 0);
  assert.ok(!steps.some(isSuite), 'suite must not run without a display');
  assert.equal(records.at(-1).status, 'skipped');
  assert.match(records.at(-1).reason, /hidden window/);
  assert.match(warnings.join('\n'), /E2E SKIPPED/);
});

test('a failing suite blocks the release', () => {
  const { status, records } = simulate({ fail: { suite: 3 } });
  assert.equal(status, 3);
  assert.equal(records.at(-1).status, 'failed');
});

test('a build failure blocks the release instead of skipping', () => {
  const { status, steps, records } = simulate({ fail: { build: 2 } });
  assert.equal(status, 2);
  assert.ok(!steps.some(isProbe));
  assert.notEqual(records.at(-1)?.status, 'skipped');
});

test('the suite requires real FFmpeg and a passing run is recorded', () => {
  const { status, steps, records } = simulate();
  assert.equal(status, 0);
  const suite = steps.find(isSuite);
  assert.equal(suite.env.CONV2_REQUIRE_FFMPEG_TESTS, '1');
  assert.ok(suite.args.includes('--skip-build'));
  assert.equal(records.at(-1).status, 'passed');
});

test('release:prepare runs the gate after test:all', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(
    scripts['release:prepare'],
    /npm run test:all && node build-scripts\/release-e2e\.js &&/
  );
});
