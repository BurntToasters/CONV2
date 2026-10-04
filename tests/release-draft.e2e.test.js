// E2E: runs build-scripts/ensure-draft-release.js against a temp git repo and a fake gh CLI.
// Proves the draft carries full CHANGELOG.md notes and targets the checked-out HEAD,
// which release-preflight guarantees is the beta/main branch tip.
// Failure modes covered: missing changelog section, stale draft target, untagged
// placeholder drafts, misnamed drafts, duplicate drafts, FORCE_UPLOAD, stable policy.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DRAFT_SCRIPT = path.join(ROOT, 'build-scripts', 'ensure-draft-release.js');
const GITHUB_CLI = path.join(ROOT, 'build-scripts', 'github-cli.js');
const METADATA = path.join(ROOT, 'build-scripts', 'release-draft-metadata.js');
const POLICY = path.join(ROOT, 'build-scripts', 'release-policy.js');
const SESSION = path.join(ROOT, 'build-scripts', 'release-session.js');
const RELEASE_VERSION = path.join(ROOT, 'build-scripts', 'release-version.js');
const ARTIFACT_PATH = path.join(ROOT, 'coverage', 'release-draft-e2e.json');

const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const callsPath = process.env.FAKE_GH_CALLS;
const statePath = process.env.FAKE_GH_STATE;
const readState = () =>
  fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { releases: [] };
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const respond = (value) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};

if (args[0] === 'auth') process.exit(0);

const methodIndex = args.indexOf('--method');
const method = methodIndex === -1 ? 'GET' : args[methodIndex + 1];
const endpoint = methodIndex === -1 ? args[1] : args[methodIndex + 2];
let body;
if (args.includes('--input')) {
  body = JSON.parse(fs.readFileSync(0, 'utf8'));
}
fs.appendFileSync(callsPath, JSON.stringify({ method, endpoint, body }) + '\\n');

const state = readState();
const pathOnly = endpoint.split('?')[0];
if (method === 'GET' && endpoint.includes('/releases?')) respond(state.releases);

if (method === 'POST' && pathOnly.endsWith('/releases')) {
  const release = {
    id: 100 + state.releases.length,
    tag_name: body.tag_name,
    name: body.name || body.tag_name,
    body: body.body,
    draft: true,
    prerelease: Boolean(body.prerelease),
    target_commitish: body.target_commitish,
    assets: [],
  };
  state.releases.push(release);
  writeState(state);
  respond(release);
}

const pathParts = pathOnly.split('/');
const lastPart = pathParts[pathParts.length - 1];
if (method === 'PATCH' && /^\\d+$/.test(lastPart)) {
  const id = Number(lastPart);
  const release = state.releases.find((entry) => entry.id === id);
  if (!release) {
    process.stderr.write('fake gh: unknown release id ' + id + '\\n');
    process.exit(1);
  }
  for (const key of ['tag_name', 'target_commitish', 'name', 'body']) {
    if (body && typeof body[key] === 'string') release[key] = body[key];
  }
  if (body && typeof body.prerelease === 'boolean') release.prerelease = body.prerelease;
  writeState(state);
  respond(release);
}

process.stderr.write('fake gh: unhandled call ' + args.join(' ') + '\\n');
process.exit(1);
`;

const SKIP_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'fake gh shim requires a POSIX executable; release VMs still run the real gh' }
    : {};

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function changelogFor(version) {
  return [
    '> [!NOTE]',
    '> This is a Beta build.',
    '',
    '# ⬇️ Downloads',
    '',
    `[Setup](https://github.com/BurntToasters/CONV2/releases/download/v${version}/CONV2-Win-x64-Setup.exe)`,
    '',
    '---',
    '',
    `## Changes in \`v${version}:\``,
    '',
    '- **Testing:** E2E release draft coverage.',
    '',
    '## Changes in `v0.0.1:`',
    '',
    '- **Testing:** Old notes.',
    '',
  ].join('\n');
}

function createReleaseRepo({ version, branch }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-release-draft-'));
  const origin = path.join(tmp, 'origin.git');
  runGit(tmp, ['init', '--bare', '--initial-branch=main', origin]);
  const work = path.join(tmp, 'work');
  runGit(tmp, ['clone', '--quiet', origin, work]);
  runGit(work, ['config', 'user.email', 'release-e2e@example.com']);
  runGit(work, ['config', 'user.name', 'Release E2E']);
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'conv2', version }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(work, 'package-lock.json'),
    JSON.stringify({ name: 'conv2', version, lockfileVersion: 3 }, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(work, 'CHANGELOG.md'), changelogFor(version));
  fs.mkdirSync(path.join(work, 'build-scripts'));
  for (const script of [DRAFT_SCRIPT, GITHUB_CLI, METADATA, POLICY, SESSION, RELEASE_VERSION]) {
    fs.copyFileSync(script, path.join(work, 'build-scripts', path.basename(script)));
  }
  if (branch !== 'main') runGit(work, ['checkout', '-b', branch]);
  runGit(work, ['add', '-A']);
  runGit(work, ['commit', '-m', 'release ' + version]);
  runGit(work, ['push', '--quiet', '-u', 'origin', branch]);
  const repo = { tmp, work, fakeBin: null, state: null, calls: null };
  writeSession({ ...repo, work });

  const fakeBin = path.join(tmp, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const fakeGh = path.join(fakeBin, 'gh');
  fs.writeFileSync(fakeGh, FAKE_GH_SOURCE, { mode: 0o755 });
  fs.chmodSync(fakeGh, 0o755);
  const state = path.join(tmp, 'gh-state.json');
  fs.writeFileSync(state, JSON.stringify({ releases: [] }));
  const calls = path.join(tmp, 'gh-calls.jsonl');
  fs.writeFileSync(calls, '');
  return { tmp, work, fakeBin, state, calls };
}

// The draft gate requires a live build session for the current checkout.
// Re-record it after every repo mutation so failures come from the draft
// logic under test, not from session drift.
function writeSession(repo) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const s=require('./build-scripts/release-session.js');" +
        'const r=s.recordSuccessfulQualityGate(process.cwd());' +
        'if(!r.recorded){console.error("dirty:"+r.dirtyFiles);process.exit(1);}' +
        'const c=s.createReleaseSession(process.cwd());' +
        "require('fs').mkdirSync('release',{recursive:true});" +
        "require('fs').writeFileSync('release/.build-session.json',JSON.stringify(c)+'\\n');",
    ],
    { cwd: repo.work, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error('E2E session setup failed: ' + result.stderr);
  }
}

function commitAll(repo, message) {
  runGit(repo.work, ['add', '-A']);
  runGit(repo.work, ['commit', '-m', message]);
}

function writeState(repo, releases) {
  fs.writeFileSync(repo.state, JSON.stringify({ releases }));
}

function headSha(repo) {
  return runGit(repo.work, ['rev-parse', 'HEAD']);
}

function runDraftScript(repo, args = [], env = {}) {
  return spawnSync(
    process.execPath,
    [path.join(repo.work, 'build-scripts', 'ensure-draft-release.js')].concat(args),
    {
      cwd: repo.work,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: path.join(ROOT, 'node_modules'),
        PATH: repo.fakeBin + path.delimiter + process.env.PATH,
        FAKE_GH_CALLS: repo.calls,
        FAKE_GH_STATE: repo.state,
        ...env,
      },
    }
  );
}

function readCalls(repo) {
  return fs
    .readFileSync(repo.calls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function cleanup(repo) {
  fs.rmSync(repo.tmp, { recursive: true, force: true, maxRetries: 3 });
}

test('beta draft gets full CHANGELOG notes and targets HEAD', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.1', branch: 'beta' });
  t.after(() => cleanup(repo));

  const result = runDraftScript(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHANGELOG\.md/);

  const calls = readCalls(repo);
  const created = calls.find((call) => call.method === 'POST');
  assert.ok(created, 'expected a draft create call');
  assert.equal(created.body.tag_name, 'v9.9.9-beta.1');
  assert.equal(created.body.name, '9.9.9-beta.1');
  assert.equal(created.body.target_commitish, headSha(repo));
  assert.equal(created.body.draft, true);
  assert.equal(created.body.prerelease, true);
  assert.equal(created.body.body, fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8'));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scenario: 'beta draft create',
    version: '9.9.9-beta.1',
    branch: 'beta',
    targetCommitish: created.body.target_commitish,
    tagName: created.body.tag_name,
    prerelease: created.body.prerelease,
    notesSha256: crypto.createHash('sha256').update(created.body.body).digest('hex'),
    calls,
  };
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + '\n');
  console.log('release-draft E2E artifact: ' + ARTIFACT_PATH);
});

test('stable draft targets HEAD and is not a prerelease', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9', branch: 'main' });
  t.after(() => cleanup(repo));

  const result = runDraftScript(repo);
  assert.equal(result.status, 0, result.stderr);

  const created = readCalls(repo).find((call) => call.method === 'POST');
  assert.ok(created, 'expected a draft create call');
  assert.equal(created.body.tag_name, 'v9.9.9');
  assert.equal(created.body.target_commitish, headSha(repo));
  assert.equal(created.body.prerelease, false);
});

test('reusing a draft refreshes notes and never creates a second draft', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.2', branch: 'beta' });
  t.after(() => cleanup(repo));

  assert.equal(runDraftScript(repo).status, 0);
  const second = runDraftScript(repo);
  assert.equal(second.status, 0, second.stderr);

  const calls = readCalls(repo);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  const patched = calls.find((call) => call.method === 'PATCH');
  assert.ok(patched, 'expected a release notes PATCH');
  assert.equal(patched.body.body, fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8'));
  assert.equal(patched.body.name, '9.9.9-beta.2');
  assert.equal(patched.body.prerelease, true);
});

test('--wait reuses the Windows draft and syncs notes', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.3', branch: 'beta' });
  t.after(() => cleanup(repo));

  assert.equal(runDraftScript(repo).status, 0);
  const waited = runDraftScript(repo, ['--wait']);
  assert.equal(waited.status, 0, waited.stderr);
  assert.match(waited.stdout, /Synced release notes/);

  const calls = readCalls(repo);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(calls.some((call) => call.method === 'PATCH'));
});

test('draft targeting an older commit is refused', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.5', branch: 'beta' });
  t.after(() => cleanup(repo));

  assert.equal(runDraftScript(repo).status, 0);
  fs.writeFileSync(path.join(repo.work, 'advance.txt'), 'new tip\n');
  commitAll(repo, 'advance beta');
  runGit(repo.work, ['push', '--quiet', 'origin', 'beta']);
  writeSession(repo);

  const result = runDraftScript(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /targets .* not checked-out commit/);
  assert.equal(readCalls(repo).filter((call) => call.method === 'PATCH').length, 0);
});

test('FORCE_UPLOAD=1 bypasses a stale draft target on beta', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.9', branch: 'beta' });
  t.after(() => cleanup(repo));

  assert.equal(runDraftScript(repo).status, 0);
  fs.writeFileSync(path.join(repo.work, 'advance.txt'), 'new tip\n');
  commitAll(repo, 'advance beta');
  runGit(repo.work, ['push', '--quiet', 'origin', 'beta']);
  writeSession(repo);

  const result = runDraftScript(repo, [], { FORCE_UPLOAD: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /FORCE_UPLOAD=1 bypassing commit check/);
  assert.ok(readCalls(repo).some((call) => call.method === 'PATCH'));
});

test('stable release refuses FORCE_UPLOAD', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9', branch: 'main' });
  t.after(() => cleanup(repo));

  const result = runDraftScript(repo, [], { FORCE_UPLOAD: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refuses FORCE_UPLOAD/);
  assert.equal(readCalls(repo).length, 0);
});

test('untagged placeholder draft is reused and notes are synced', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.7', branch: 'beta' });
  t.after(() => cleanup(repo));
  writeState(repo, [
    {
      id: 7,
      tag_name: 'untagged-0123456789abcdef0123',
      name: '9.9.9-beta.7',
      body: 'old notes',
      draft: true,
      prerelease: true,
      target_commitish: headSha(repo),
      assets: [],
    },
  ]);

  const result = runDraftScript(repo);
  assert.equal(result.status, 0, result.stderr);
  const calls = readCalls(repo);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  const patched = calls.find((call) => call.method === 'PATCH');
  assert.ok(patched, 'expected a release notes PATCH');
  assert.equal(patched.body.body, fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8'));
});

test('draft named like the version with a wrong tag is refused', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.8', branch: 'beta' });
  t.after(() => cleanup(repo));
  writeState(repo, [
    {
      id: 8,
      tag_name: 'v9.9.9-beta.7',
      name: '9.9.9-beta.8',
      draft: true,
      prerelease: true,
      target_commitish: headSha(repo),
      assets: [],
    },
  ]);

  const result = runDraftScript(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wrong tag_name/);
  assert.equal(readCalls(repo).filter((call) => call.method === 'PATCH').length, 0);
});

test('multiple drafts for the tag are refused', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.10', branch: 'beta' });
  t.after(() => cleanup(repo));
  const base = {
    name: '9.9.9-beta.10',
    draft: true,
    prerelease: true,
    target_commitish: headSha(repo),
    assets: [],
  };
  writeState(repo, [
    { ...base, id: 10, tag_name: 'v9.9.9-beta.10' },
    { ...base, id: 11, tag_name: 'v9.9.9-beta.10' },
  ]);

  const result = runDraftScript(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Multiple draft releases/);
});

test('syncing corrects a wrong prerelease flag', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.11', branch: 'beta' });
  t.after(() => cleanup(repo));
  writeState(repo, [
    {
      id: 12,
      tag_name: 'v9.9.9-beta.11',
      name: '9.9.9-beta.11',
      draft: true,
      prerelease: false,
      target_commitish: headSha(repo),
      assets: [],
    },
  ]);

  const result = runDraftScript(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Correcting draft prerelease flag/);
  const patched = readCalls(repo).find((call) => call.method === 'PATCH');
  assert.ok(patched, 'expected a release notes PATCH');
  assert.equal(patched.body.prerelease, true);
});

test('missing changelog section fails closed', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.6', branch: 'beta' });
  t.after(() => cleanup(repo));

  fs.writeFileSync(
    path.join(repo.work, 'CHANGELOG.md'),
    '# Downloads\n\nNo version section here.\n'
  );
  commitAll(repo, 'bad changelog');
  writeSession(repo);

  const result = runDraftScript(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has no ## Changes in/);
  assert.equal(readCalls(repo).length, 0);
});

test('missing build session fails before any draft call', SKIP_ON_WINDOWS, (t) => {
  const repo = createReleaseRepo({ version: '9.9.9-beta.12', branch: 'beta' });
  t.after(() => cleanup(repo));

  fs.rmSync(path.join(repo.work, 'release', '.build-session.json'));

  const result = runDraftScript(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /build session is missing/);
  assert.equal(readCalls(repo).length, 0);
});
