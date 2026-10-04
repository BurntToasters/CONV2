// E2E: runs build-scripts/verify-release-draft.js against a temp git repo and
// a fake gh serving the full Electron draft matrix (installers, .asc,
// .blockmap, SHA256SUMS, latest*.yml feeds with sha512).
// Failure modes: missing asset, wrong feed version, feed referencing an absent
// file, stale target, published release, duplicates, missing draft, notes
// without the version section, tampered artifact bytes (--verify-artifacts).
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
  fixtureBytes,
  requiredAssetNames,
} = require('./release-e2e-fixtures');

const ROOT = path.join(__dirname, '..');
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'release-verify-e2e.json');
const SCRIPTS = [
  'verify-release-draft.js',
  'release-version.js',
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

function setup({ version = '9.9.9-beta.1', stable = false, arm64 = false, tamper = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-verify-'));
  const origin = path.join(tmp, 'origin.git');
  git(tmp, ['init', '--bare', '--initial-branch=main', origin]);
  const work = path.join(tmp, 'work');
  git(tmp, ['clone', '--quiet', origin, work]);
  git(work, ['config', 'user.email', 'verify-e2e@example.com']);
  git(work, ['config', 'user.name', 'Verify E2E']);
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

  const names = requiredAssetNames({ stable, arm64 });
  const feeds = {};
  for (const feed of feedNames({ arm64 })) feeds[feed] = buildFeedYml(feed, version);
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
        prerelease: !stable,
        target_commitish: head,
        assets: [],
        assetNames: names,
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
  return { tmp, work, bin, statePath, callsPath, head, version };
}

function run(repo, args = [], env = {}) {
  return spawnSync(
    process.execPath,
    [path.join(repo.work, 'build-scripts', 'verify-release-draft.js'), ...args],
    {
      cwd: repo.work,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: path.join(ROOT, 'node_modules'),
        PATH: repo.bin + path.delimiter + process.env.PATH,
        FAKE_GH_CALLS: repo.callsPath,
        FAKE_GH_STATE: repo.statePath,
        ...env,
      },
    }
  );
}

function writeState(repo, state) {
  fs.writeFileSync(repo.statePath, JSON.stringify(state));
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(repo.statePath, 'utf8'));
}

function cleanup(repo) {
  fs.rmSync(repo.tmp, { recursive: true, force: true, maxRetries: 3 });
}

// Localhost bytes server for --verify-artifacts: the API endpoint 302s to
// /bytes/<name> (exercising redirect following) and asserts the gh token.
function startBytesServer(repo, tamper = {}) {
  const http = require('node:http');
  const seenAuth = [];
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
        body = fixtureBytes(name);
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
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seenAuth,
        close: () => server.close(),
      });
    });
  });
}

async function runWithArtifacts(repo, extraEnv = {}) {
  const tamper = extraEnv.FAKE_GH_TAMPER ? JSON.parse(extraEnv.FAKE_GH_TAMPER) : {};
  const server = await startBytesServer(repo, tamper);
  try {
    // Async spawn: the test loop must stay free to answer bytes requests.
    const result = await spawnNode(
      [path.join(repo.work, 'build-scripts', 'verify-release-draft.js'), '--verify-artifacts'],
      {
        cwd: repo.work,
        env: {
          ...process.env,
          NODE_PATH: path.join(ROOT, 'node_modules'),
          PATH: repo.bin + path.delimiter + process.env.PATH,
          FAKE_GH_CALLS: repo.callsPath,
          FAKE_GH_STATE: repo.statePath,
          FAKE_GH_TOKEN: 'fake-token',
          GH_API_BASE_URL: server.url,
          ...extraEnv,
        },
      }
    );
    return { result, seenAuth: server.seenAuth };
  } finally {
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

function dropAsset(repo, name) {
  const state = readState(repo);
  state.releases[0].assetNames = state.releases[0].assetNames.filter((entry) => entry !== name);
  writeState(repo, state);
}

test('complete beta draft verifies, including artifact hashes', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const shape = run(repo);
  assert.equal(shape.status, 0, shape.stderr);
  assert.match(shape.stdout, /verify-draft: ok \(v9\.9\.9-beta\.1, draft, HEAD/);
  const { result: full, seenAuth } = await runWithArtifacts(repo);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /36 assets/);
  assert.ok(
    seenAuth.some((value) => value === 'Bearer fake-token'),
    'bytes download must send the gh token'
  );
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(
    ARTIFACT_PATH,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      version: repo.version,
      assets: requiredAssetNames({}).length,
    }) + '\n'
  );
  console.log('release-verify E2E artifact: ' + ARTIFACT_PATH);
});

test('stable draft requires the MSI pair', SKIP_ON_WINDOWS, (t) => {
  const repo = setup({ version: '9.9.9', stable: true });
  t.after(() => cleanup(repo));
  assert.equal(run(repo).status, 0, run(repo).stderr);
  dropAsset(repo, 'CONV2-Win-x64.msi');
  const missing = run(repo);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing required assets:.*CONV2-Win-x64\.msi/);
});

test('linux arm64 matrix is opt-in', SKIP_ON_WINDOWS, (t) => {
  const repo = setup({ arm64: true });
  t.after(() => cleanup(repo));
  assert.equal(run(repo).status, 0);
  const required = run(repo, [], { REQUIRE_LINUX_ARM64: '1' });
  assert.equal(required.status, 0);
  dropAsset(repo, 'CONV2-Linux-arm64.AppImage');
  assert.equal(run(repo).status, 0, 'base matrix must tolerate absent arm64');
  const enforced = run(repo, [], { REQUIRE_LINUX_ARM64: '1' });
  assert.notEqual(enforced.status, 0);
  assert.match(enforced.stderr, /CONV2-Linux-arm64\.AppImage/);
});

test('missing installer fails the gate', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  dropAsset(repo, 'CONV2-macOS-universal.dmg');
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required assets:.*CONV2-macOS-universal\.dmg/);
});

test('feed with the wrong version fails', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.feeds['latest.yml'] = buildFeedYml('latest.yml', '0.0.0');
  writeState(repo, state);
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /latest\.yml reports version/);
});

test('feed referencing an absent file fails', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.feeds['latest.yml'] = state.feeds['latest.yml'].replace(
    '\npath: ',
    '\n  - url: CONV2-Nope.exe\n    sha512: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n    size: 0\npath: '
  );
  writeState(repo, state);
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a draft asset/);
});

test('draft targeting another commit is refused', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0].target_commitish = '0'.repeat(40);
  writeState(repo, state);
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not HEAD/);
});

test('published release is refused', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0].draft = false;
  writeState(repo, state);
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already published|must still be a draft/);
});

test('duplicate drafts are refused', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases.push({ ...state.releases[0], id: 43 });
  writeState(repo, state);
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Multiple draft releases/);
});

test('missing draft fails with the Windows-first hint', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  writeState(repo, { releases: [], feeds: {} });
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No GitHub draft exists/);
});

test('notes without the version section fail', SKIP_ON_WINDOWS, (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const state = readState(repo);
  state.releases[0].body = '# Downloads\n\nNo notes here.\n';
  writeState(repo, state);
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release notes have no .* section/);
});

test('tampered artifact bytes fail --verify-artifacts', SKIP_ON_WINDOWS, async (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const { result } = await runWithArtifacts(repo, {
    FAKE_GH_TAMPER: JSON.stringify({ 'CONV2-Win-Setup.exe': 'tampered-bytes\n' }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha512 mismatch|size mismatch/);
});
