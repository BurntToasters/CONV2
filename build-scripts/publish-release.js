// Publishes the fully-verified draft for the current package version.
// Order is the whole point: verify:draft (with artifact hashes) must pass
// before the flip is sent.
// Usage: npm run release:publish   (after every platform VM has signed)
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { assertGitHubCliAuthenticated, githubApi } = require('./github-cli');
const { assertStableReleaseOverridesAllowed } = require('./release-policy');
const {
  assertSupportedReleaseVersion,
  isBetaReleaseVersion,
  isStableReleaseVersion,
} = require('./release-version');
const {
  assertExistingTagTargetsCommit,
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  assertReleaseTagName,
  isExpectedRelease,
  listAllGithubPages,
} = require('./release-draft-metadata');

const REPO_OWNER = process.env.GH_REPO_OWNER || 'BurntToasters';
const REPO_NAME = process.env.GH_REPO_NAME || 'CONV2';
const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG_NAME = 'v' + VERSION;

function currentReleaseCommit() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error('Could not resolve an exact release commit from git HEAD.');
  }
  return commit;
}

function runVerifyDraft() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'verify-release-draft.js'), '--verify-artifacts'],
    { stdio: 'inherit', cwd: path.resolve(__dirname, '..') }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('release:verify:draft failed; fix the draft instead of publishing it.');
  }
}

async function main() {
  assertSupportedReleaseVersion(VERSION);
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();
  const commit = currentReleaseCommit();
  runVerifyDraft();

  const releases = await listAllGithubPages((page, perPage) =>
    githubApi('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${perPage}&page=${page}`)
  );
  assertNoMisnamedVersionDrafts(releases, TAG_NAME, VERSION);
  const drafts = releases.filter(
    (release) => release && release.draft && isExpectedRelease(release, TAG_NAME, VERSION)
  );
  if (drafts.length > 1) {
    throw new Error(
      `Multiple draft releases exist for ${TAG_NAME}. Resolve duplicates before publishing.`
    );
  }
  if (drafts.length === 0) {
    const published = releases.filter((release) => isExpectedRelease(release, TAG_NAME, VERSION));
    if (published.length > 0) {
      throw new Error(`Release ${TAG_NAME} is already published.`);
    }
    throw new Error(`No draft exists for ${TAG_NAME}.`);
  }
  const draft = assertExpectedRelease(drafts[0], TAG_NAME, VERSION, 'Publishing draft');
  const expectedPrerelease = isBetaReleaseVersion(VERSION);
  if (Boolean(draft.prerelease) !== expectedPrerelease) {
    throw new Error(
      `Draft ${TAG_NAME} prerelease=${draft.prerelease}, expected ${expectedPrerelease}; re-run npm run release:draft.`
    );
  }
  if (draft.target_commitish !== commit) {
    throw new Error(`Draft ${TAG_NAME} targets ${draft.target_commitish}, not HEAD ${commit}.`);
  }
  assertExistingTagTargetsCommit((endpoint) => githubApi('GET', endpoint), {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag: TAG_NAME,
    commit,
  });

  const published = await githubApi(
    'PATCH',
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${draft.id}`,
    {
      tag_name: TAG_NAME,
      target_commitish: commit,
      draft: false,
      prerelease: expectedPrerelease,
    }
  );
  const validated = assertReleaseTagName(published, TAG_NAME, 'Published release');
  console.log(`Published ${TAG_NAME}: ${validated.html_url}`);
  console.log('Next: npm run release:verify:published (live updater feed + draft state).');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      '✗ ERROR: Failed to publish release: ' +
        (error && error.message ? error.message : String(error))
    );
    process.exit(1);
  });
}

module.exports = { currentReleaseCommit, runVerifyDraft };
