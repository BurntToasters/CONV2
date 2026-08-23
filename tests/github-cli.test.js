'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { githubCliEnvironment } = require('../build-scripts/github-cli');

test('GitHub CLI children use credential-store authentication', () => {
  assert.deepEqual(
    githubCliEnvironment({ PATH: '/bin', GH_TOKEN: 'old', GITHUB_TOKEN: 'old-too' }),
    { PATH: '/bin' }
  );
});