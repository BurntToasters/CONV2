const test = require('node:test');
const assert = require('node:assert/strict');

const { requiresRealPayload, run } = require('../build-scripts/ci-ffmpeg.js');

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
  assert.equal(requiresRealPayload({ REQUIRE_FFMPEG_PAYLOAD: '1' }), true);
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

test('CI runs on release-candidate branches', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  // A release candidate that no workflow triggers on is an untested release.
  const triggerBlock = workflow.slice(0, workflow.indexOf('permissions:'));
  const branchLines = [...triggerBlock.matchAll(/branches: \[(.*)\]/g)].map((m) => m[1]);
  assert.ok(branchLines.length >= 2, 'expected push and pull_request branch filters');
  for (const line of branchLines) {
    assert.match(line, /next-\*/);
    assert.match(line, /main/);
    assert.match(line, /beta/);
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
