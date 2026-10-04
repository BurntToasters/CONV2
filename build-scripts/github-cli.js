'use strict';

const { spawnSync } = require('node:child_process');

function githubCliEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.GH_TOKEN;
  delete childEnvironment.GITHUB_TOKEN;
  return childEnvironment;
}

function githubStatusCode(detail) {
  const match = String(detail || '').match(/\bHTTP\s+(\d{3})\b|\bstatus(?: code)?\s+(\d{3})\b/i);
  return match ? Number(match[1] || match[2]) : undefined;
}

function runGitHub(args, { input } = {}) {
  const result = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
    encoding: 'utf8',
    env: githubCliEnvironment(),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        'GitHub CLI is required. Install gh and run `gh auth login` on this release VM.'
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const error = new Error(
      `gh ${args.join(' ')} failed with status ${result.status}${detail ? `:\n${detail}` : ''}`
    );
    error.statusCode = githubStatusCode(detail);
    throw error;
  }
  return result;
}

function githubApi(method, endpoint, body) {
  const args = ['api', '--method', method, endpoint];
  if (body !== undefined) args.push('--input', '-');
  const result = runGitHub(args, {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  const output = String(result.stdout || '').trim();
  return output ? JSON.parse(output) : {};
}

// Raw (non-JSON) download of a release asset by its numeric asset id. Used by
// the read-only draft verifier to fetch updater feeds and artifact bytes.
function downloadReleaseAssetText(repository, assetId) {
  const result = runGitHub([
    'api',
    '--method',
    'GET',
    `/repos/${repository}/releases/assets/${assetId}`,
    '--header',
    'Accept: application/octet-stream',
  ]);
  return String(result.stdout || '');
}

function assertGitHubCliAuthenticated() {
  runGitHub(['auth', 'status', '--hostname', 'github.com']);
}

function uploadReleaseAsset(uploadUrl, filePath) {
  runGitHub(releaseAssetUploadArgs(uploadUrl, filePath));
}

// Upload against the release upload URL (not the tag) so untagged placeholder
// drafts accept assets the same as tagged ones. Refuses non-GitHub hosts.
function releaseAssetUploadArgs(uploadUrl, filePath) {
  const path = require('node:path');
  const url = new URL(String(uploadUrl).replace('{?name,label}', ''));
  if (url.protocol !== 'https:' || url.hostname !== 'uploads.github.com') {
    throw new Error(`Refusing unexpected GitHub upload URL: ${uploadUrl}`);
  }
  url.searchParams.set('name', path.basename(filePath));
  const contentType = /\.(asc|txt|json)$/i.test(filePath)
    ? 'text/plain'
    : 'application/octet-stream';
  return [
    'api',
    '--method',
    'POST',
    url.toString(),
    '--header',
    'Accept: application/vnd.github+json',
    '--header',
    `Content-Type: ${contentType}`,
    '--input',
    filePath,
  ];
}

module.exports = {
  assertGitHubCliAuthenticated,
  downloadReleaseAssetText,
  githubApi,
  githubCliEnvironment,
  githubStatusCode,
  releaseAssetUploadArgs,
  runGitHub,
  uploadReleaseAsset,
};
