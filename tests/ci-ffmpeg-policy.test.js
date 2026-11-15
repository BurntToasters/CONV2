const test = require('node:test');
const assert = require('node:assert/strict');

const { commandRequiresShell, requiresRealPayload, run } = require('../build-scripts/ci-ffmpeg.js');

test('Windows command shims run through a shell', () => {
  assert.equal(commandRequiresShell('npm.cmd', 'win32'), true);
  assert.equal(commandRequiresShell('NPM.CMD', 'win32'), true);
  assert.equal(commandRequiresShell('npm', 'win32'), false);
  assert.equal(commandRequiresShell('npm.cmd', 'linux'), false);
});

test('real FFmpeg payload is required on trusted branch pushes', () => {
  assert.equal(
    requiresRealPayload({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }),
    true
  );
  assert.equal(
    requiresRealPayload({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/beta' }),
    true
  );
});

test('pull requests may run structure-only package smoke', () => {
  assert.equal(
    requiresRealPayload({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge' }),
    false
  );
  assert.doesNotThrow(() =>
    run({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge' })
  );
});

test('explicit payload requirement overrides event context', () => {
  const { bundledPayloadPresent } = require('../build-scripts/ci-ffmpeg.js');
  assert.equal(requiresRealPayload({ REQUIRE_FFMPEG_PAYLOAD: '1' }), true);
  if (bundledPayloadPresent({})) {
    assert.doesNotThrow(() => run({ REQUIRE_FFMPEG_PAYLOAD: '1' }));
    return;
  }
  assert.throws(() => run({ REQUIRE_FFMPEG_PAYLOAD: '1' }), /FFMPEG_DL_SERVER is required/);
});

test('release-candidate branches require a real FFmpeg payload', () => {
  const { isTrustedReleaseRef } = require('../build-scripts/ci-ffmpeg.js');
  assert.equal(
    requiresRealPayload({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/next-1.6.0' }),
    true
  );
  assert.equal(isTrustedReleaseRef('refs/heads/next-1.7.0'), true);
  assert.equal(isTrustedReleaseRef('refs/heads/feature/next-thing'), false);
  assert.equal(isTrustedReleaseRef('refs/heads/nextish'), false);
  assert.equal(isTrustedReleaseRef(''), false);
  assert.equal(isTrustedReleaseRef(undefined), false);
});

// CI minutes policy: tests run only for pushes to main and beta.
// Failure modes: another branch (e.g. next-*) triggers runs; PR pushes run the
// full suite; a test job loses its push-only guard; the stable promotion check
// stops running on PRs into main.
test('CI tests run only on main and beta pushes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const yaml = require('js-yaml');
  const workflow = yaml.load(
    fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  );
  assert.deepEqual(workflow.on.push.branches, ['main', 'beta']);
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'stable-metadata') {
      assert.match(job.if, /github\.event_name == 'pull_request'/);
      continue;
    }
    assert.equal(job.if, "github.event_name == 'push'", `${name} must run on pushes only`);
  }
});

test('CI exercises the packaged runtime and config gates', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  assert.match(workflow, /npm run smoke:runtime/);
  assert.match(workflow, /xvfb-run -a npm run smoke:runtime/);
  assert.match(workflow, /npm run test:checks/);
  assert.match(workflow, /npm run test:coverage/);
});
