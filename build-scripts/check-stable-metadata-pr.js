// Stable promotion gate: a beta -> stable change must remove only the beta
// suffix and touch exactly the synchronized release metadata set, with no
// content drift beyond the version itself. Works on any git range, so it runs
// locally and in CI for release/* -> main pull requests.
//
// Usage: node build-scripts/check-stable-metadata-pr.js <base-ref> <head-ref>
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const STABLE_METADATA_PATHS = new Set([
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'com.burnttoasters.conv2.metainfo.xml',
]);

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function assertExactJson(filePath, actual, expected) {
  let parsed;
  try {
    parsed = JSON.parse(actual);
  } catch {
    throw new Error(`${filePath} is not valid JSON.`);
  }
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error(`${filePath} contains non-version content changes.`);
  }
}

function syncNpmLockfileVersion(lockText, version) {
  let parsed;
  try {
    parsed = JSON.parse(lockText);
  } catch (error) {
    throw new Error(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('package-lock.json root must be an object');
  }
  if (!parsed.packages || typeof parsed.packages !== 'object') {
    throw new Error('package-lock.json is missing packages');
  }
  if (!parsed.packages[''] || typeof parsed.packages[''] !== 'object') {
    throw new Error('package-lock.json is missing packages[""]');
  }
  if (parsed.version === version && parsed.packages[''].version === version) {
    return lockText;
  }
  parsed.version = version;
  parsed.packages[''].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function expectedMetainfo(baseContent, headVersion, date) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(new Date(`${date}T00:00:00.000Z`).valueOf())
  ) {
    throw new Error('com.burnttoasters.conv2.metainfo.xml has an invalid release date.');
  }
  const releasesLineMatch = baseContent.match(/^(\s*)<releases>\s*$/m);
  if (!releasesLineMatch) {
    throw new Error('com.burnttoasters.conv2.metainfo.xml has no <releases> section.');
  }
  // Mirror build/update-metainfo.js: the releases section collapses to the
  // single current release entry.
  const baseIndent = releasesLineMatch[1] || '';
  const releaseIndent = `${baseIndent}  `;
  const replacement = `<releases>\n${releaseIndent}<release version="${headVersion}" date="${date}"/>\n${baseIndent}</releases>`;
  return baseContent.replace(/<releases>[\s\S]*?<\/releases>/, replacement);
}

function validateStableChangelog(baseContent, headContent, headVersion) {
  // Mirror build/sync-changelog.js, then the promotion renames the top beta
  // section to the stable one and drops the beta callout.
  const synced = baseContent.replace(
    /\/releases\/download\/v[^/]+\//g,
    `/releases/download/v${headVersion}/`
  );
  const betaHeadingMatch = synced.match(/^## Changes in `v[^`]+:`/m);
  if (!betaHeadingMatch) {
    throw new Error('CHANGELOG.md has no top release section to promote.');
  }
  const stableHeading = `## Changes in \`v${headVersion}:\``;
  const promoted = synced.replace(betaHeadingMatch[0], stableHeading);
  const sectionStart = promoted.indexOf(stableHeading);
  const bodyStart = sectionStart + stableHeading.length;
  const nextSection = promoted.indexOf('\n## Changes in `', bodyStart);
  if (sectionStart < 0 || nextSection < 0) {
    throw new Error('CHANGELOG.md has no bounded stable release section.');
  }
  const prefix = promoted.slice(0, bodyStart);
  const suffix = promoted.slice(nextSection);
  if (/This is a Beta build/.test(headContent)) {
    throw new Error('CHANGELOG.md stable content still has the Beta callout.');
  }
  if (/^## Changes in `v\d+\.\d+\.\d+-beta\.\d+:`/m.test(headContent)) {
    throw new Error('CHANGELOG.md still has beta release sections.');
  }
  const downloadVersions = new Set(
    [...headContent.matchAll(/\/releases\/download\/v([^/]+)\//g)].map((match) => match[1])
  );
  if (downloadVersions.size === 0 || [...downloadVersions].some((v) => v !== headVersion)) {
    throw new Error('CHANGELOG.md download URLs must all use the stable version.');
  }
  // The beta callout block ("> ..." lines at the very top) must go; everything
  // else before the notes and all older history must stay byte-identical.
  // Offsets are measured against the matched prefix because dropping the
  // callout shifts every later byte.
  const prefixWithoutCallout = prefix.replace(/^(> [^\n]*\n)+(\n|$)/, '');
  const matchedPrefix = headContent.startsWith(prefix)
    ? prefix
    : headContent.startsWith(prefixWithoutCallout)
      ? prefixWithoutCallout
      : null;
  if (!matchedPrefix || !headContent.endsWith(suffix)) {
    throw new Error('CHANGELOG.md changes outside the stable release section.');
  }
  const currentSection = headContent.slice(
    matchedPrefix.length,
    headContent.length - suffix.length
  );
  if (!currentSection.trim() || /^##\s/mu.test(currentSection)) {
    throw new Error('CHANGELOG.md stable release section is invalid.');
  }
  if (/\(add release notes\)/.test(currentSection)) {
    throw new Error('CHANGELOG.md stable section still has placeholder notes.');
  }
}

function validateStableMetadataFile({
  filePath,
  baseContent,
  headContent,
  baseVersion,
  headVersion,
}) {
  const normalizedPath = normalizePath(filePath);
  let expected;

  switch (normalizedPath) {
    case 'package.json': {
      const basePackage = JSON.parse(baseContent);
      if (basePackage.version !== baseVersion) {
        throw new Error('package.json base version does not match the PR base.');
      }
      basePackage.version = headVersion;
      assertExactJson(normalizedPath, headContent, basePackage);
      return;
    }
    case 'package-lock.json':
      expected = syncNpmLockfileVersion(baseContent, headVersion);
      assertExactJson(normalizedPath, headContent, JSON.parse(expected));
      return;
    case 'CHANGELOG.md':
      validateStableChangelog(baseContent, headContent, headVersion);
      return;
    case 'com.burnttoasters.conv2.metainfo.xml': {
      const headRelease = [
        ...headContent.matchAll(
          /<release\b(?=[^>]*\bversion=["']([^"']+)["'])(?=[^>]*\bdate=["'](\d{4}-\d{2}-\d{2})["'])[^>]*>/g
        ),
      ];
      if (headRelease.length !== 1 || headRelease[0][1] !== headVersion) {
        throw new Error(
          'com.burnttoasters.conv2.metainfo.xml must contain one dated stable release.'
        );
      }
      expected = expectedMetainfo(baseContent, headVersion, headRelease[0][2]);
      break;
    }
    default:
      throw new Error(`${normalizedPath} is not release metadata.`);
  }

  if (headContent !== expected) {
    throw new Error(`${normalizedPath} contains non-version content changes.`);
  }
}

function validateStableMetadataChange({ baseVersion, headVersion, changedEntries }) {
  const match = String(baseVersion).match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  if (!match || headVersion !== match[1]) {
    throw new Error(
      `Stable metadata must remove only the beta suffix (${baseVersion} -> ${headVersion}).`
    );
  }
  if (!Array.isArray(changedEntries) || changedEntries.length === 0) {
    throw new Error('Stable metadata pull request has no changed files.');
  }
  const notModified = changedEntries.filter(({ status }) => status !== 'M');
  if (notModified.length > 0) {
    throw new Error(
      `Stable metadata files must be modified in place; found:\n${notModified.map(({ status, path }) => `${status}\t${path}`).join('\n')}`
    );
  }
  const changedPaths = changedEntries.map(({ path }) => normalizePath(path));
  const unexpected = changedPaths.filter((filePath) => !STABLE_METADATA_PATHS.has(filePath));
  if (unexpected.length > 0) {
    throw new Error(
      `Stable metadata pull request changed files that are not release metadata:\n${unexpected.join('\n')}`
    );
  }
  const changedSet = new Set(changedPaths);
  const missing = [...STABLE_METADATA_PATHS].filter((filePath) => !changedSet.has(filePath));
  if (missing.length > 0 || changedSet.size !== STABLE_METADATA_PATHS.size) {
    throw new Error(
      `Stable metadata pull request must contain the exact synchronized metadata set; missing:\n${missing.join('\n')}`
    );
  }
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function fileAt(ref, filePath) {
  return git(['show', `${ref}:${filePath}`]);
}

function packageVersionAt(ref) {
  return JSON.parse(fileAt(ref, 'package.json')).version;
}

function main() {
  const [baseRef, headRef] = process.argv.slice(2);
  if (!baseRef || !headRef) {
    throw new Error('Usage: node build-scripts/check-stable-metadata-pr.js <base-ref> <head-ref>');
  }
  const changedEntries = git(['diff', '--name-status', '--no-renames', `${baseRef}..${headRef}`])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, filePath] = line.split('\t');
      return { status, path: filePath };
    });
  const baseVersion = packageVersionAt(baseRef);
  const headVersion = packageVersionAt(headRef);
  validateStableMetadataChange({ baseVersion, headVersion, changedEntries });
  for (const filePath of STABLE_METADATA_PATHS) {
    validateStableMetadataFile({
      filePath,
      baseContent: fileAt(baseRef, filePath),
      headContent: fileAt(headRef, filePath),
      baseVersion,
      headVersion,
    });
  }
  console.log('Stable metadata pull request scope and content are valid.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  STABLE_METADATA_PATHS,
  validateStableChangelog,
  validateStableMetadataChange,
  validateStableMetadataFile,
};
