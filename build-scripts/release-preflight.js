// Release preflight: beta versions release from beta, stable from main. The
// checkout must be clean and exactly match the pushed branch tip so the draft
// target and final tag bind to the commit every release VM builds and signs.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { expectedReleaseBranch } = require('./release-version');

function git(args) {
  // trimEnd only: git porcelain uses " M path" / "M  path".
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function runPreflight() {
  const version = String(packageJson.version || '');
  const expectedBranch = expectedReleaseBranch(version);
  const branch = git(['branch', '--show-current']);
  if (branch !== expectedBranch) {
    throw new Error(
      `${version} must be released from ${expectedBranch}, not ${branch || 'detached HEAD'}.`
    );
  }

  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) {
    throw new Error(
      `Working tree is not clean. Commit and push the exact release source first:\n${dirty}`
    );
  }

  git(['fetch', '--quiet', 'origin']);
  const upstream = git(['rev-parse', '--abbrev-ref', '@{upstream}']);
  const expectedUpstream = `origin/${expectedBranch}`;
  if (upstream !== expectedUpstream) {
    throw new Error(
      `${expectedBranch} must track ${expectedUpstream}; current upstream is ${upstream}.`
    );
  }

  const head = git(['rev-parse', 'HEAD']);
  const upstreamHead = git(['rev-parse', '@{upstream}']);
  if (head !== upstreamHead) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not match pushed ${expectedUpstream} ${upstreamHead.slice(0, 12)}.`
    );
  }

  console.log(`release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)})`);
}

if (require.main === module) {
  try {
    runPreflight();
  } catch (error) {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

module.exports = { expectedReleaseBranch };
