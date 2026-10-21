'use strict';

// GitHub exposes an unpublished draft under an untagged-* placeholder until the
// final publish assigns the real tag. Accept it only when name and commit match.
const GITHUB_UNTAGGED_DRAFT = /^untagged-[0-9a-f]{20}$/i;

function expectedReleaseName(expectedTag) {
  return String(expectedTag || '').replace(/^v/, '');
}

function isExpectedRelease(release, expectedTag, expectedName = expectedReleaseName(expectedTag)) {
  if (release && release.tag_name === expectedTag) return true;
  return Boolean(
    release &&
    release.draft &&
    release.name === expectedName &&
    GITHUB_UNTAGGED_DRAFT.test(String(release.tag_name || ''))
  );
}

function assertExpectedRelease(
  release,
  expectedTag,
  expectedName = expectedReleaseName(expectedTag),
  context = 'Draft release'
) {
  if (isExpectedRelease(release, expectedTag, expectedName)) return release;
  throw new Error(
    `${context} ${release && release.id !== undefined ? release.id : 'with unknown id'} has tag_name ` +
      `${JSON.stringify(release && release.tag_name !== undefined ? release.tag_name : null)}, ` +
      `expected ${JSON.stringify(expectedTag)} or a GitHub untagged draft placeholder named ` +
      `${JSON.stringify(expectedName)}.`
  );
}

function assertReleaseTagName(release, expectedTag, context = 'Draft release') {
  if (release && release.tag_name === expectedTag) return release;
  throw new Error(
    `${context} ${release && release.id !== undefined ? release.id : 'with unknown id'} has tag_name ` +
      `${JSON.stringify(release && release.tag_name !== undefined ? release.tag_name : null)}, ` +
      `expected ${JSON.stringify(expectedTag)}. ` +
      'Retag the existing draft before continuing; do not create another draft.'
  );
}

function assertNoMisnamedVersionDrafts(
  releases,
  expectedTag,
  expectedName = String(expectedTag || '').replace(/^v/, '')
) {
  const misnamed = (Array.isArray(releases) ? releases : []).filter(
    (release) =>
      release &&
      release.draft &&
      release.name === expectedName &&
      !isExpectedRelease(release, expectedTag, expectedName)
  );
  if (misnamed.length === 0) return releases;

  const details = misnamed
    .map(
      (release) =>
        `id ${release.id !== undefined ? release.id : 'unknown'}: ${JSON.stringify(release.tag_name || null)}`
    )
    .join(', ');
  throw new Error(
    `Found draft named ${JSON.stringify(expectedName)} with wrong tag_name (${details}); ` +
      `expected ${JSON.stringify(expectedTag)}. Retag the existing draft before continuing; ` +
      'do not create another draft.'
  );
}

// GitHub ignores target_commitish when the tag already exists. Publishing a
// draft would then bind the release to that tag, not to the verified HEAD.
function assertExistingTagTargetsCommit(apiGet, { owner, repo, tag, commit }) {
  let ref;
  try {
    ref = apiGet(`/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error && error.statusCode === 404) return;
    throw error;
  }
  let object = ref && ref.object;
  // Annotated tags point to a tag object; follow a short chain to the commit.
  for (let depth = 0; object && object.type === 'tag' && depth < 5; depth += 1) {
    const tagObject = apiGet(`/repos/${owner}/${repo}/git/tags/${object.sha}`);
    object = tagObject && tagObject.object;
  }
  if (!object || object.type !== 'commit' || typeof object.sha !== 'string') {
    throw new Error(`Tag ${tag} does not resolve to a commit; refusing to publish.`);
  }
  if (object.sha.toLowerCase() !== String(commit).toLowerCase()) {
    throw new Error(
      `Tag ${tag} already points to ${object.sha}, not HEAD ${commit}. Delete or move the tag before publishing.`
    );
  }
}

// Walk GitHub list endpoints page-by-page until an empty page or a short page.
async function listAllGithubPages(fetchPage, { perPage = 100 } = {}) {
  const pageSize = Math.max(1, Number(perPage) || 100);
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

module.exports = {
  assertExistingTagTargetsCommit,
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  assertReleaseTagName,
  isExpectedRelease,
  listAllGithubPages,
};
