// E2E: runs build/sync-version.js as a CLI in a temp project and checks the
// beta callout in CHANGELOG.md's downloads block follows the version.
// Failure modes: stable leaves the note live; beta leaves it commented; repeat
// runs nest or stack comment markers; a matching note outside the downloads
// block gets toggled; a changelog without the note throws or gains one; the
// stable-metadata PR check rejects the commented form or accepts a live note.
// AppStream metainfo: a version bump leaves the old release; the date is
// restamped on every run; a second run rewrites the file; a file without
// <releases> is silently skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SYNC_SCRIPT = path.join(ROOT, 'build', 'sync-version.js');
const ARTIFACT_DIR = path.join(ROOT, 'coverage', 'e2e', 'sync-version');

const LIVE_NOTE = '> [!NOTE] \n> 🅱️ This is a Beta\n';
const COMMENTED_NOTE = `<!--\n${LIVE_NOTE}-->\n`;

function changelog(note, tag, { historyNote = '' } = {}) {
  return [
    '# ⬇️ Downloads',
    '',
    `${note}`,
    `[Setup](https://github.com/BurntToasters/CONV2/releases/download/${tag}/CONV2-Win-x64-Setup.exe)`,
    '',
    `## Changes in \`${tag}:\``,
    '',
    '- **Testing:** notes.',
    '',
    `${historyNote}## Changes in \`v9.9.8:\``,
    '',
    '- **Testing:** older notes.',
    '',
  ].join('\n');
}

const METAINFO_NAME = 'com.burnttoasters.conv2.metainfo.xml';

function metainfo(version, date) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<component type="desktop-application">',
    '  <id>com.burnttoasters.conv2</id>',
    '  <releases>',
    '',
    `    <release version="${version}" date="${date}"/>`,
    '',
    '  </releases>',
    '</component>',
    '',
  ].join('\n');
}

function runSync(version, changelogText, label, { metainfoText } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-sync-version-'));
  fs.mkdirSync(path.join(work, 'build'));
  fs.copyFileSync(SYNC_SCRIPT, path.join(work, 'build', 'sync-version.js'));
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'conv2', version }) + '\n'
  );
  fs.writeFileSync(
    path.join(work, 'package-lock.json'),
    JSON.stringify({ name: 'conv2', version, lockfileVersion: 3, packages: { '': { version } } }) +
      '\n'
  );
  fs.writeFileSync(path.join(work, 'CHANGELOG.md'), changelogText);
  fs.writeFileSync(path.join(work, METAINFO_NAME), metainfoText ?? metainfo(version, '2020-01-01'));

  const run = () =>
    spawnSync(process.execPath, [path.join(work, 'build', 'sync-version.js')], {
      cwd: work,
      encoding: 'utf8',
    });
  const readMetainfo = () => fs.readFileSync(path.join(work, METAINFO_NAME), 'utf8');
  const first = run();
  if (first.status !== 0) {
    fs.rmSync(work, { recursive: true, force: true });
    return { failed: first };
  }
  const once = fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8');
  const metainfoOnce = readMetainfo();
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const twice = fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8');
  const metainfoTwice = readMetainfo();

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${label}.CHANGELOG.md`), once);
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${label}.metainfo.xml`), metainfoOnce);
  fs.rmSync(work, { recursive: true, force: true });
  return { once, twice, metainfoOnce, metainfoTwice };
}

const downloadsOf = (text) => text.slice(0, text.search(/^## Changes in /m));

test('stable version comments out a live beta note, idempotently', () => {
  const { once, twice } = runSync('9.9.9', changelog(LIVE_NOTE, 'v9.9.9-beta.1'), 'stable');
  assert.ok(downloadsOf(once).includes(COMMENTED_NOTE));
  assert.equal(once.match(/<!--/g).length, 1);
  assert.equal(twice, once);
});

test('beta version uncomments a commented beta note, idempotently', () => {
  const { once, twice } = runSync('9.9.9-beta.1', changelog(COMMENTED_NOTE, 'v9.9.8'), 'beta');
  assert.ok(downloadsOf(once).startsWith(`# ⬇️ Downloads\n\n${LIVE_NOTE}`));
  assert.ok(!once.includes('<!--'));
  assert.equal(twice, once);
});

test('beta version keeps a live note unchanged', () => {
  const { once } = runSync('9.9.9-beta.2', changelog(LIVE_NOTE, 'v9.9.9-beta.1'), 'beta-live');
  assert.ok(downloadsOf(once).includes(LIVE_NOTE));
  assert.ok(!once.includes('<!--'));
});

test('a matching note outside the downloads block is left alone', () => {
  const input = changelog(LIVE_NOTE, 'v9.9.9-beta.1', { historyNote: LIVE_NOTE + '\n' });
  const { once } = runSync('9.9.9', input, 'history-note');
  const history = once.slice(once.search(/^## Changes in /m));
  assert.ok(history.includes(LIVE_NOTE));
  assert.ok(!history.includes('<!--'));
});

test('a changelog without the note syncs without gaining one', () => {
  const { once } = runSync('9.9.9', changelog('', 'v9.9.9-beta.1'), 'no-note');
  assert.ok(!once.includes('This is a Beta'));
  assert.ok(once.includes('/releases/download/v9.9.9/'));
});

const releasesOf = (xml) => [...xml.matchAll(/<release version="([^"]+)" date="([^"]+)"\/>/g)];

test('a version bump moves the metainfo release to the new version, idempotently', () => {
  const { metainfoOnce, metainfoTwice } = runSync(
    '9.9.9-beta.1',
    changelog('', 'v9.9.8'),
    'metainfo-bump',
    { metainfoText: metainfo('9.9.8', '2020-01-01') }
  );
  const releases = releasesOf(metainfoOnce);
  assert.equal(releases.length, 1);
  assert.equal(releases[0][1], '9.9.9-beta.1');
  assert.match(releases[0][2], /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(releases[0][2], '2020-01-01');
  assert.match(metainfoOnce, /\n  <releases>\n    <release [^\n]+\/>\n  <\/releases>\n/);
  assert.equal(metainfoTwice, metainfoOnce);
});

test('a matching metainfo version keeps its date and bytes', () => {
  const input = metainfo('9.9.9', '2020-01-01');
  const { metainfoOnce } = runSync('9.9.9', changelog('', 'v9.9.9'), 'metainfo-current', {
    metainfoText: input,
  });
  assert.equal(metainfoOnce, input);
});

test('metainfo without a releases section fails the sync', () => {
  const { failed } = runSync('9.9.9', changelog('', 'v9.9.9'), 'metainfo-broken', {
    metainfoText: '<component>\n</component>\n',
  });
  assert.ok(failed, 'sync must fail');
  assert.match(failed.stderr, /<releases>/);
});
