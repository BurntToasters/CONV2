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
