// Post-publish gate: proves GitHub serves v<version> as the expected release.
// API-only; mutates nothing locally. Run after npm run release:publish.
const { assertGitHubCliAuthenticated, githubApi } = require('./github-cli');
const { isBetaReleaseVersion } = require('./release-version');

const REPO_OWNER = process.env.GH_REPO_OWNER || 'BurntToasters';
const REPO_NAME = process.env.GH_REPO_NAME || 'CONV2';
const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG_NAME = 'v' + VERSION;

function main() {
  assertGitHubCliAuthenticated();
  // GitHub's /releases/latest only tracks non-prerelease releases, so beta
  // uses the tag endpoint while stable additionally proves latest status.
  const useLatest = !isBetaReleaseVersion(VERSION);
  const endpoint = useLatest
    ? `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
    : `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG_NAME}`;
  let release;
  try {
    release = githubApi('GET', endpoint);
  } catch (error) {
    throw new Error(
      `Published release ${TAG_NAME} not found: ${error && error.message ? error.message : String(error)}`
    );
  }
  if (!release || release.tag_name !== TAG_NAME) {
    throw new Error(
      `Expected release ${TAG_NAME}, GitHub returned ${release && release.tag_name}.`
    );
  }
  if (release.draft !== false) {
    throw new Error(`Release ${TAG_NAME} is still a draft; publish it before verifying.`);
  }
  if (Boolean(release.prerelease) !== isBetaReleaseVersion(VERSION)) {
    throw new Error(
      `Release ${TAG_NAME} prerelease=${release.prerelease} does not match version ${VERSION}.`
    );
  }
  if (!release.published_at || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error(`Release ${TAG_NAME} has no published timestamp.`);
  }
  console.log(
    `verify-published: ok (${TAG_NAME}, published ${release.published_at}, prerelease=${release.prerelease})`
  );
  console.log(`Next: install or update to ${VERSION} on each platform and smoke-test.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { main };
