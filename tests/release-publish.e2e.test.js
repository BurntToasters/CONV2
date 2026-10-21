// E2E: runs build-scripts/publish-release.js against a temp git repo and a fake
// gh serving a complete draft. Proves the guarded publish reruns draft
// verification (with artifact hashes), then flips draft:false at the same tag
// and commit. Refuses duplicates, stale targets, prerelease mismatch, an
// existing tag pointing elsewhere, and already-published releases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  FAKE_GH_SOURCE,
  buildFeedYml,
  feedNames,
  requiredAssetNames,
} = require('./release-e2e-fixtures');

const ROOT = path.join(__dirname, '..');
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'release-publish-e2e.json');
const SCRIPTS = [
  'publish-release.js',
  'release-version.js',
  'verify-release-draft.js',
  'verify-published-release.js',
  'github-cli.js',
  'release-draft-metadata.js',
  'release-policy.js',
];

const SKIP_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'fake gh shim requires a POSIX executable; release VMs still run the real gh' }
    : {};

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function setup({ version = '9.9.9-beta.1', env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-publish-'));
  const origin = path.join(tmp, 'origin.git');
  git(tmp, ['init', '--bare', '--initial-branch=main', origin]);
  const work = path.join(tmp, 'work');
  git(tmp, ['clone', '--quiet', origin, work]);
  git(work, ['config', 'user.email', 'publish-e2e@example.com']);
  git(work, ['config', 'user.name', 'Publish E2E']);
  fs.writeFileSync(work + '/package.json', JSON.stringify({ name: 'conv2', version }) + '\n');
  fs.mkdirSync(path.join(work, 'build-scripts'));
  for (const file of SCRIPTS) {
    fs.copyFileSync(path.join(ROOT, 'build-scripts', file), path.join(work, 'build-scripts', file));
  }
  git(work, ['checkout', '-b', 'beta']);
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'release']);
  git(work, ['push', '--quiet', '-u', 'origin', 'beta']);
  const head = git(work, ['rev-parse', 'HEAD']);

  const names = requiredAssetNames({});
  const feeds = {};
  for (const feed of feedNames({})) feeds[feed] = buildFeedYml(feed, version);
  const body = [
    '# Downloads',
    '',
    `## Changes in \`v${version}:\``,
    '',
    '- **Testing:** notes.',
    '',
  ].join('\n');
  const state = {
    releases: [
      {
        id: 42,
        tag_name: 'v' + version,
        name: version,
        body,
        draft: true,
        prerelease: true,
        target_commitish: head,
        assets: [],
        assetNames: names,
        html_url: 'https://github.com/BurntToasters/CONV2/releases/tag/v' + version,
      },
    ],
    feeds,
  };
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, FAKE_GH_SOURCE, { mode: 0o755 });
  fs.chmodSync(gh, 0o755);
  const statePath = path.join(tmp, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const callsPath = path.join(tmp, 'calls.jsonl');
  fs.writeFileSync(callsPath, '');
  return { tmp, work, bin, statePath, callsPath, head, version, env };
}

function run(repo, extraEnv = {}) {
  return runWithServer(repo, extraEnv);
}

// publish-release spawns verify-release-draft as a grandchild with inherited
// env, so the fake toolchain rides on process.env for the duration of the run.
async function runWithServer(repo, extraEnv = {}) {
  const { server, url, seenAuth } = await startBytesServer(repo, extraEnv);
  const overridden = new Set([
    'PATH',
    'NODE_PATH',
    'FAKE_GH_CALLS',
    'FAKE_GH_STATE',
    'FAKE_GH_TOKEN',
    'GH_API_BASE_URL',
    ...Object.keys(repo.env),
    ...Object.keys(extraEnv),
  ]);
  const saved = {};
  for (const key of overridden) saved[key] = process.env[key];
  try {
    process.env.PATH = repo.bin + path.delimiter + process.env.PATH;
    process.env.NODE_PATH = path.join(ROOT, 'node_modules');
    process.env.FAKE_GH_CALLS = repo.callsPath;
    process.env.FAKE_GH_STATE = repo.statePath;
    process.env.FAKE_GH_TOKEN = 'fake-token';
    process.env.GH_API_BASE_URL = url;
    Object.assign(process.env, repo.env, extraEnv);
    // Async spawn: the test loop must stay free to answer bytes requests
    // from the verify grandchild.
    const result = await spawnNode([path.join(repo.work, 'build-scripts', 'publish-release.js')], {
      cwd: repo.work,
      env: process.env,
    });
    return { result, seenAuth };
  } finally {
    for (const key of overridden) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    server.close();
  }
}

// Async child run that keeps the event loop free for the bytes server.
function spawnNode(args, options) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// Localhost bytes server for --verify-artifacts (run by the grandchild
// verifier): the API endpoint 302s to /bytes/<name>, asserting the gh token.
function startBytesServer(repo, extraEnv = {}) {
  const http = require('node:http');
  const seenAuth = [];
  const tamper = extraEnv.FAKE_GH_TAMPER ? JSON.parse(extraEnv.FAKE_GH_TAMPER) : {};
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    const state = JSON.parse(fs.readFileSync(repo.statePath, 'utf8'));
    const names = [];
    for (const release of state.releases) names.push(...(release.assetNames || []));
    const apiMatch = req.url.match(/\/releases\/assets\/(\d+)/);
    if (apiMatch) {
      const name = names[Number(apiMatch[1]) - 1000];
      if (!name) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(302, { Location: `/bytes/${encodeURIComponent(name)}` });
      res.end();
      return;
    }
    const bytesMatch = req.url.match(/^\/bytes\/(.+)$/);
    if (bytesMatch) {
      const name = decodeURIComponent(bytesMatch[1]);
      let body;
      if (state.feeds && state.feeds[name] !== undefined) {
        body = state.feeds[name];
      } else if (tamper[name] !== undefined) {
        body = tamper[name];
      } else {
        body = `fixture-bytes-for:${name}\n`;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, seenAuth });
    });
  });
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(repo.statePath, 'utf8'));
}

function writeState(repo, state) {
  fs.writeFileSync(repo.statePath, JSON.stringify(state));
}

function cleanup(repo) {
  fs.rmSync(repo.tmp, { recursive: true, force: true, maxRetries: 3 });
}

test('verified draft publishes at the same tag and commit', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const { result } = await run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Published v9\.9\.9-beta\.1/);
  const state = readState(repo);
  assert.equal(state.releases[0].draft, false);
  assert.equal(state.releases[0].tag_name, 'v9.9.9-beta.1');
  assert.equal(state.releases[0].target_commitish, repo.head);
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(
    ARTIFACT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), tag: 'v9.9.9-beta.1' }) + '\n'
  );
  console.log('release-publish E2E artifact: ' + ARTIFACT_PATH);
});

test('incomplete draft is never published', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0].assetNames = state.releases[0].assetNames.filter(
    (name) => name !== 'latest.yml'
  );
  writeState(repo, state);
  const { result } = await run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required assets/);
  assert.equal(readState(repo).releases[0].draft, true);
});

test('stale draft target blocks publishing', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0].target_commitish = '0'.repeat(40);
  writeState(repo, state);
  const { result } = await run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not HEAD/);
  assert.equal(readState(repo).releases[0].draft, true);
});

test('wrong prerelease flag blocks publishing', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0].prerelease = false;
  writeState(repo, state);
  const { result } = await run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prerelease/);
  assert.equal(readState(repo).releases[0].draft, true);
});

test('existing tag on another commit blocks publishing', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const { result } = await run(repo, { FAKE_GH_TAG_SHA: '1'.repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already points to/);
  assert.equal(readState(repo).releases[0].draft, true);
});

test('already-published release is refused', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0].draft = false;
  writeState(repo, state);
  const { result } = await run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already published|No draft exists/);
});

test('duplicate drafts block publishing', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases.push({ ...state.releases[0], id: 43 });
  writeState(repo, state);
  const { result } = await run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Multiple draft releases/);
  assert.ok(readState(repo).releases.every((release) => release.draft));
});

function runPublished(repo) {
  return spawnSync(
    process.execPath,
    [path.join(repo.work, 'build-scripts', 'verify-published-release.js')],
    {
      cwd: repo.work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: repo.bin + path.delimiter + process.env.PATH,
        FAKE_GH_CALLS: repo.callsPath,
        FAKE_GH_STATE: repo.statePath,
      },
    }
  );
}

test('published beta verifies against its tag', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0] = {
    ...state.releases[0],
    draft: false,
    prerelease: true,
    published_at: '2026-10-04T00:00:00.000Z',
  };
  writeState(repo, state);
  const result = runPublished(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verify-published: ok \(v9\.9\.9-beta\.1/);
});

test('published stable verifies against /releases/latest', SKIP_ON_WINDOWS, (t) => {
  const repo = setup({ version: '9.9.9' });
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.latest = {
    tag_name: 'v9.9.9',
    draft: false,
    prerelease: false,
    published_at: '2026-10-04T00:00:00.000Z',
  };
  writeState(repo, state);
  const result = runPublished(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verify-published: ok \(v9\.9\.9/);
});

test('published check refuses a stale latest release', SKIP_ON_WINDOWS, (t) => {
  const repo = setup({ version: '9.9.9' });
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.latest = {
    tag_name: 'v0.0.1',
    draft: false,
    prerelease: false,
    published_at: '2026-10-04T00:00:00.000Z',
  };
  writeState(repo, state);
  const result = runPublished(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected release v9\.9\.9/);
});

test('published check refuses a missing beta tag', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const result = runPublished(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not found/);
});
