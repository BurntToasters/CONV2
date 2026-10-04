// E2E: runs build-scripts/check-stable-metadata-pr.js in temp git repos holding a
// beta base commit and a stable head commit. Proves only an exact
// beta-suffix-removal with the synchronized metadata set passes.
// Failure modes: extra files, renamed/deleted files, version jumps, partial
// metadata set, package.json content drift, lockfile drift, unsynced changelog
// URLs, leftover beta sections, empty stable notes, bad metainfo date.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHECK_SCRIPT = path.join(ROOT, 'build-scripts', 'check-stable-metadata-pr.js');

const BETA = '9.9.9-beta.1';
const STABLE = '9.9.9';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function betaChangelog() {
  return [
    '> [!NOTE]',
    '> This is a Beta build.',
    '',
    '# Downloads',
    '',
    `[Setup](https://github.com/BurntToasters/CONV2/releases/download/v${BETA}/CONV2-Win-x64-Setup.exe)`,
    '',
    `## Changes in \`v${BETA}:\``,
    '',
    '- **Testing:** beta notes.',
    '',
    '## Changes in `v9.9.8:`',
    '',
    '- **Testing:** older notes.',
    '',
  ].join('\n');
}

function stableChangelog() {
  return [
    '# Downloads',
    '',
    `[Setup](https://github.com/BurntToasters/CONV2/releases/download/v${STABLE}/CONV2-Win-x64-Setup.exe)`,
    '',
    `## Changes in \`v${STABLE}:\``,
    '',
    '- **Testing:** final notes.',
    '',
    '## Changes in `v9.9.8:`',
    '',
    '- **Testing:** older notes.',
    '',
  ].join('\n');
}

function betaLock() {
  return (
    JSON.stringify(
      {
        name: 'conv2',
        version: BETA,
        lockfileVersion: 3,
        packages: { '': { name: 'conv2', version: BETA } },
      },
      null,
      2
    ) + '\n'
  );
}

function stableLock() {
  return (
    JSON.stringify(
      {
        name: 'conv2',
        version: STABLE,
        lockfileVersion: 3,
        packages: { '': { name: 'conv2', version: STABLE } },
      },
      null,
      2
    ) + '\n'
  );
}

function metainfo(version, date) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<component type="desktop-application">',
    '  <id>com.burnttoasters.conv2</id>',
    '  <releases>',
    `    <release version="${version}" date="${date}"/>`,
    '  </releases>',
    '</component>',
    '',
  ].join('\n');
}

function setup(mutateHead) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-metadata-'));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  git(tmp, ['init', '-b', 'main', work]);
  git(work, ['config', 'user.email', 'metadata-e2e@example.com']);
  git(work, ['config', 'user.name', 'Metadata E2E']);
  fs.mkdirSync(path.join(work, 'build-scripts'));
  fs.copyFileSync(CHECK_SCRIPT, path.join(work, 'build-scripts', 'check-stable-metadata-pr.js'));
  fs.writeFileSync(
    work + '/package.json',
    JSON.stringify({ name: 'conv2', version: BETA }, null, 2) + '\n'
  );
  fs.writeFileSync(work + '/package-lock.json', betaLock());
  fs.writeFileSync(work + '/CHANGELOG.md', betaChangelog());
  fs.writeFileSync(work + '/com.burnttoasters.conv2.metainfo.xml', metainfo(BETA, '2026-10-01'));
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'beta']);
  const base = git(work, ['rev-parse', 'HEAD']);

  fs.writeFileSync(
    work + '/package.json',
    JSON.stringify({ name: 'conv2', version: STABLE }, null, 2) + '\n'
  );
  fs.writeFileSync(work + '/package-lock.json', stableLock());
  fs.writeFileSync(work + '/CHANGELOG.md', stableChangelog());
  fs.writeFileSync(work + '/com.burnttoasters.conv2.metainfo.xml', metainfo(STABLE, '2026-10-04'));
  if (mutateHead) mutateHead(work, base);
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'stable metadata']);
  const head = git(work, ['rev-parse', 'HEAD']);
  return { tmp, work, base, head };
}

function run(repo) {
  return spawnSync(
    process.execPath,
    [path.join(repo.work, 'build-scripts', 'check-stable-metadata-pr.js'), repo.base, repo.head],
    { cwd: repo.work, encoding: 'utf8' }
  );
}

function cleanup(repo) {
  fs.rmSync(repo.tmp, { recursive: true, force: true, maxRetries: 3 });
}

test('exact stable metadata promotion passes', (t) => {
  const repo = setup();
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scope and content are valid/);
});

test('non-metadata file change fails', (t) => {
  const repo = setup((work) =>
    fs.appendFileSync(work + '/build-scripts/check-stable-metadata-pr.js', '\n// stable head.\n')
  );
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not release metadata/);
});

test('version jump fails', (t) => {
  const repo = setup((work) =>
    fs.writeFileSync(
      work + '/package.json',
      JSON.stringify({ name: 'conv2', version: '9.9.10' }, null, 2) + '\n'
    )
  );
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /remove only the beta suffix/);
});

test('partial metadata set fails', (t) => {
  const repo = setup((work) => {
    const baseMetainfo = execFileSync(
      'git',
      ['show', 'HEAD:com.burnttoasters.conv2.metainfo.xml'],
      {
        cwd: work,
        encoding: 'utf8',
      }
    );
    fs.writeFileSync(work + '/com.burnttoasters.conv2.metainfo.xml', baseMetainfo);
  });
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact synchronized metadata set|no changed files/);
});

test('package.json content drift fails', (t) => {
  const repo = setup((work) =>
    fs.writeFileSync(
      work + '/package.json',
      JSON.stringify({ name: 'conv2-renamed', version: STABLE }, null, 2) + '\n'
    )
  );
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-version content changes/);
});

test('unsynced changelog download URLs fail', (t) => {
  const repo = setup((work) =>
    fs.writeFileSync(
      work + '/CHANGELOG.md',
      stableChangelog().replaceAll(`/v${STABLE}/`, `/v${BETA}/`)
    )
  );
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /download URL|synchronized/);
});

test('leftover beta section fails', (t) => {
  const repo = setup((work) =>
    fs.writeFileSync(
      work + '/CHANGELOG.md',
      stableChangelog() + `\n## Changes in \`v${BETA}:\`\n\n- old\n`
    )
  );
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /beta/i);
});

test('placeholder stable notes fail', (t) => {
  const repo = setup((work) =>
    fs.writeFileSync(
      work + '/CHANGELOG.md',
      stableChangelog().replace('- **Testing:** final notes.', '(add release notes)')
    )
  );
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /placeholder|invalid/);
});

test('metainfo with a bad date fails', (t) => {
  const repo = setup((work) =>
    fs.writeFileSync(work + '/com.burnttoasters.conv2.metainfo.xml', metainfo(STABLE, 'not-a-date'))
  );
  t.after(() => cleanup(repo));
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /date|release/);
});
