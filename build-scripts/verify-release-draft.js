// Read-only whole-draft gate. Does not upload, publish, or mutate GitHub.
// Verifies the Electron release matrix for the current package version:
// installers, detached .asc signatures, differential-update .blockmap files,
// SHA256SUMS manifests, and the electron-updater latest*.yml feeds (version,
// referenced files, and --verify-artifacts: served bytes match feed hashes).
//
// Usage:
//   npm run release:verify:draft
//   REQUIRE_LINUX_ARM64=1 npm run release:verify:draft
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  assertGitHubCliAuthenticated,
  downloadReleaseAssetText,
  githubApi,
  githubCliEnvironment,
} = require('./github-cli');
const { isExplicitTruthy } = require('./release-policy');
const {
  assertSupportedReleaseVersion,
  isBetaReleaseVersion,
  isStableReleaseVersion,
} = require('./release-version');
const {
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  isExpectedRelease,
  listAllGithubPages,
} = require('./release-draft-metadata');

const root = path.resolve(__dirname, '..');

const WIN_INSTALLERS = [
  'CONV2-Win-Setup.exe',
  'CONV2-Win-x64-Setup.exe',
  'CONV2-Win-arm64-Setup.exe',
  'CONV2-Win-Portable.exe',
  'CONV2-Win-x64-Portable.exe',
  'CONV2-Win-arm64-Portable.exe',
];
const MAC_INSTALLERS = ['CONV2-macOS-universal.dmg', 'CONV2-macOS-universal.zip'];
const LINUX_X64_INSTALLERS = [
  'CONV2-Linux-x86_64.AppImage',
  'CONV2-Linux-amd64.deb',
  'CONV2-Linux-x86_64.rpm',
];
const LINUX_ARM64_INSTALLERS = [
  'CONV2-Linux-arm64.AppImage',
  'CONV2-Linux-arm64.deb',
  'CONV2-Linux-aarch64.rpm',
];
// windows-build.js refuses MSI for beta (non-numeric versioning); stable only.
const MSI_INSTALLERS = ['CONV2-Win-x64.msi', 'CONV2-Win-arm64.msi'];
// electron-builder emits differential-update blockmaps only for these targets.
const BLOCKMAP_NAMES = [
  'CONV2-Win-Setup.exe.blockmap',
  'CONV2-Win-x64-Setup.exe.blockmap',
  'CONV2-Win-arm64-Setup.exe.blockmap',
  'CONV2-macOS-universal.dmg.blockmap',
  'CONV2-macOS-universal.zip.blockmap',
];
const CHECKSUM_NAMES = ['SHA256SUMS-Windows.txt', 'SHA256SUMS-macOS.txt', 'SHA256SUMS-Linux.txt'];
const FEED_NAMES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];
const LINUX_ARM64_FEED = 'latest-linux-arm64.yml';

function readPackageVersion(repositoryRoot = root) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
}

function requiredDraftInstallerNames({ stable = false, arm64 = false } = {}) {
  const names = [...WIN_INSTALLERS, ...MAC_INSTALLERS, ...LINUX_X64_INSTALLERS];
  if (arm64) names.push(...LINUX_ARM64_INSTALLERS);
  if (stable) names.push(...MSI_INSTALLERS);
  return names;
}

function requiredDraftFeedNames({ arm64 = false } = {}) {
  return arm64 ? [...FEED_NAMES, LINUX_ARM64_FEED] : [...FEED_NAMES];
}

function requiredDraftAssetNames({ stable = false, arm64 = false } = {}) {
  const installers = requiredDraftInstallerNames({ stable, arm64 });
  return Array.from(
    new Set([
      ...installers,
      ...installers.map((name) => `${name}.asc`),
      ...BLOCKMAP_NAMES,
      ...CHECKSUM_NAMES,
      ...CHECKSUM_NAMES.map((name) => `${name}.asc`),
      ...requiredDraftFeedNames({ arm64 }),
    ])
  ).sort();
}

function assertDraftReleaseShape({ release, assetNames, version, headCommit }) {
  const tag = `v${version}`;
  const prerelease = isBetaReleaseVersion(version);
  if (!release || !release.draft) {
    throw new Error(`Release ${tag} must still be a draft for release:verify:draft.`);
  }
  if (Boolean(release.prerelease) !== prerelease) {
    throw new Error(
      `Release ${tag} prerelease=${release.prerelease} does not match version ${version}.`
    );
  }
  if (headCommit && release.target_commitish !== headCommit) {
    throw new Error(
      `Release ${tag} targets ${release.target_commitish || 'an unknown commit'}, not HEAD ${headCommit}.`
    );
  }
  const present = new Set(assetNames);
  const missing = requiredDraftAssetNames({
    stable: isStableReleaseVersion(version),
    arm64: isExplicitTruthy(process.env.REQUIRE_LINUX_ARM64),
  }).filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`Draft ${tag} is missing required assets: ${missing.join(', ')}.`);
  }
  return { tag, missing };
}

function selectDraftRelease(releases, tag, version) {
  assertNoMisnamedVersionDrafts(releases, tag, version);
  const matches = (releases || []).filter((release) => isExpectedRelease(release, tag, version));
  const drafts = matches.filter((release) => release.draft);
  if (drafts.length > 1) {
    throw new Error(
      `Multiple draft releases exist for ${tag}. Resolve duplicates before verifying.`
    );
  }
  if (drafts.length === 1) {
    return assertExpectedRelease(drafts[0], tag, version, 'Draft verification release');
  }
  if (matches.length > 0) {
    throw new Error(`Release ${tag} is already published.`);
  }
  return null;
}

function assertReleaseNotes({ release, version }) {
  const heading = `## Changes in \`v${version}:\``;
  const body = typeof release.body === 'string' ? release.body : '';
  if (!body.includes(heading)) {
    throw new Error(
      `Draft release notes have no ${heading} section; re-run npm run release:draft to sync CHANGELOG.md.`
    );
  }
  return heading;
}

async function loadDraftRelease(repoOwner, repoName, tag, version) {
  let tagged;
  try {
    tagged = await githubApi('GET', `/repos/${repoOwner}/${repoName}/releases/tags/${tag}`);
  } catch (error) {
    if (!error || error.statusCode !== 404) {
      throw new Error(
        `Could not load draft ${tag}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (tagged) {
    if (tagged.draft) {
      return assertExpectedRelease(tagged, tag, version, 'Draft verification release');
    }
    throw new Error(`Release ${tag} is already published.`);
  }

  const releases = await listAllGithubPages((page, perPage) =>
    githubApi('GET', `/repos/${repoOwner}/${repoName}/releases?per_page=${perPage}&page=${page}`)
  );
  const match = selectDraftRelease(releases, tag, version);
  if (!match) {
    throw new Error(
      `No GitHub draft exists for ${tag}. Create it with npm run release:draft on Windows first.`
    );
  }
  return match;
}

async function listDraftReleaseAssets(repoOwner, repoName, releaseId) {
  return listAllGithubPages((page, perPage) =>
    githubApi(
      'GET',
      `/repos/${repoOwner}/${repoName}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`
    )
  );
}

function currentHeadCommit() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error('Could not resolve an exact release commit from git HEAD.');
  }
  return commit;
}

function githubAuthToken() {
  // Same executable mapping as github-cli.js runGitHub: plain 'gh' does not
  // resolve on Windows without shell lookup.
  const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
  return execFileSync(executable, ['auth', 'token', '--hostname', 'github.com'], {
    cwd: root,
    encoding: 'utf8',
    env: githubCliEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseFeed(feedText, feedName, version) {
  let feed;
  try {
    feed = yaml.load(feedText);
  } catch (error) {
    throw new Error(
      `${feedName} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!feed || typeof feed !== 'object' || feed.version !== version) {
    throw new Error(
      `${feedName} reports version ${JSON.stringify(feed && feed.version)}, expected ${version}.`
    );
  }
  const files = Array.isArray(feed.files) ? feed.files : [];
  if (feed.path !== undefined) {
    files.push({ url: feed.path, sha512: feed.sha512, size: feed.size });
  }
  if (files.length === 0) {
    throw new Error(`${feedName} references no installer files.`);
  }
  return files.map((entry) => ({
    url: String(entry.url || ''),
    sha512: typeof entry.sha512 === 'string' ? entry.sha512 : null,
    size: Number(entry.size),
  }));
}

function assertFeedReferences({ feedName, entries, assetNames }) {
  const present = new Set(assetNames);
  for (const entry of entries) {
    if (!entry.url) {
      throw new Error(`${feedName} has a file entry with no url.`);
    }
    if (!present.has(entry.url)) {
      throw new Error(`${feedName} references ${entry.url}, which is not a draft asset.`);
    }
  }
  return entries;
}

// Download raw asset bytes over HTTPS (works for untagged placeholder drafts
// too, where tag-addressed downloads cannot resolve). Honors GH_API_BASE_URL
// so E2E can serve fixtures from localhost; production uses api.github.com.
function followRedirects(url, headers, depth) {
  if (depth > 5) {
    return Promise.reject(new Error(`Download redirected too many times: ${url}`));
  }
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, { headers }, (response) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        resolve(followRedirects(new URL(location, url), headers, depth + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download ${url.pathname} failed with HTTP ${response.statusCode}.`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ chunks }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function verifyDraftArtifactBytes({
  repoOwner,
  repoName,
  assetsByName,
  entries,
  token,
  apiBaseUrl,
}) {
  // One entry per installer file; every served byte must match the feed hash.
  const seen = new Map();
  for (const entry of entries) {
    const previous = seen.get(entry.url);
    if (previous && previous !== entry.sha512) {
      throw new Error(`Feeds disagree on the sha512 for ${entry.url}.`);
    }
    seen.set(entry.url, entry.sha512);
  }
  if (seen.size === 0) {
    throw new Error('Draft feeds reference no updater artifacts.');
  }
  for (const [fileName, sha512] of seen) {
    const asset = assetsByName.get(fileName);
    if (!asset || typeof asset.id !== 'number') {
      throw new Error(`Draft feed references missing asset ${fileName}.`);
    }
    const apiUrl = new URL(
      `${String(apiBaseUrl || 'https://api.github.com').replace(/\/+$/, '')}/repos/${repoOwner}/${repoName}/releases/assets/${asset.id}`
    );
    const bytes = await followRedirects(
      apiUrl,
      {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'CONV2-Release',
      },
      0
    ).then(({ chunks }) => Buffer.concat(chunks));
    if (!sha512 || !entryShaMatches(bytes, sha512)) {
      throw new Error(
        `Draft asset ${fileName} sha512 mismatch: served bytes do not match its feed entry.`
      );
    }
    const expected = feedSizeFor(entries, fileName);
    if (Number.isFinite(expected) && bytes.length !== expected) {
      throw new Error(
        `Draft asset ${fileName} size mismatch: got ${bytes.length} bytes, feed says ${expected}.`
      );
    }
  }
}

function entryShaMatches(bytes, sha512) {
  const actual = crypto.createHash('sha512').update(bytes).digest('base64');
  const expected = String(sha512).trim();
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function feedSizeFor(entries, fileName) {
  const match = entries.find((entry) => entry.url === fileName && Number.isFinite(entry.size));
  return match ? match.size : NaN;
}

async function main() {
  const version = readPackageVersion();
  assertSupportedReleaseVersion(version);
  const tag = `v${version}`;
  const repoOwner = process.env.GH_REPO_OWNER || 'BurntToasters';
  const repoName = process.env.GH_REPO_NAME || 'CONV2';
  assertGitHubCliAuthenticated();
  const headCommit = currentHeadCommit();
  const release = await loadDraftRelease(repoOwner, repoName, tag, version);
  const listedAssets = await listDraftReleaseAssets(repoOwner, repoName, release.id);
  const assets = listedAssets.map((asset) => asset && asset.name).filter(Boolean);
  assertDraftReleaseShape({ release, assetNames: assets, version, headCommit });
  assertReleaseNotes({ release, version });

  const assetsByName = new Map(
    listedAssets
      .filter((asset) => asset && typeof asset.name === 'string')
      .map((asset) => [asset.name, asset])
  );
  const feedEntries = [];
  for (const feedName of requiredDraftFeedNames({
    arm64: isExplicitTruthy(process.env.REQUIRE_LINUX_ARM64),
  })) {
    const asset = assetsByName.get(feedName);
    if (!asset || typeof asset.id !== 'number') {
      throw new Error(`Draft asset ${feedName} is missing a GitHub id.`);
    }
    // Feeds are YAML text; the CLI returns them without binary mangling.
    const feedText = await downloadReleaseAssetText(`${repoOwner}/${repoName}`, asset.id);
    const entries = parseFeed(feedText, feedName, version);
    assertFeedReferences({ feedName, entries, assetNames: assets });
    feedEntries.push(...entries.map((entry) => ({ ...entry, feedName })));
  }

  if (process.argv.includes('--verify-artifacts')) {
    const token = githubAuthToken();
    if (!token) throw new Error('gh returned an empty GitHub authentication token.');
    await verifyDraftArtifactBytes({
      repoOwner,
      repoName,
      assetsByName,
      entries: feedEntries,
      token,
      apiBaseUrl: process.env.GH_API_BASE_URL,
    });
  }
  console.log(
    `verify-draft: ok (${tag}, draft, HEAD ${headCommit.slice(0, 12)}, ${assets.length} assets, prerelease=${isBetaReleaseVersion(version)})`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  assertDraftReleaseShape,
  assertFeedReferences,
  assertReleaseNotes,
  parseFeed,
  requiredDraftAssetNames,
  requiredDraftFeedNames,
  requiredDraftInstallerNames,
  selectDraftRelease,
};
