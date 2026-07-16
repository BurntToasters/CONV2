const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('conversion IPC returns the redacted result', () => {
  const source = read('src/main/main.ts');
  assert.match(
    source,
    /webContents\.send\('conversion-complete', resultForRenderer\);\s*return resultForRenderer;/
  );
});

test('font license notice is copied with renderer fonts', () => {
  const notice = read('src/renderer/fonts/OFL.txt');
  assert.match(notice, /Inter/);
  assert.match(notice, /Outfit/);
  assert.match(notice, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(notice, /IN NO EVENT SHALL THE\s+COPYRIGHT HOLDER BE LIABLE/);
  assert.match(notice, /These can be\s+included either as stand-alone text files/);
});

test('Flatpak bundles are uploaded with their signatures and checksums', () => {
  const { getReleaseUploadFiles } = require('../build-scripts/release-upload-policy');
  const releaseDir = path.join(ROOT, 'release');
  const uploads = getReleaseUploadFiles(
    ['CONV2-Win-x64-Setup.exe', 'CONV2-Linux-x86_64.flatpak', 'CONV2-Linux-aarch64.flatpak'],
    [
      path.join(releaseDir, 'CONV2-Win-x64-Setup.exe.asc'),
      path.join(releaseDir, 'CONV2-Linux-x86_64.flatpak.asc'),
      path.join(releaseDir, 'CONV2-Linux-aarch64.flatpak.asc'),
    ],
    path.join(releaseDir, 'SHA256SUMS-Linux.txt'),
    releaseDir
  );

  assert.deepEqual(uploads, [
    path.join(releaseDir, 'CONV2-Linux-x86_64.flatpak'),
    path.join(releaseDir, 'CONV2-Linux-aarch64.flatpak'),
    path.join(releaseDir, 'CONV2-Win-x64-Setup.exe.asc'),
    path.join(releaseDir, 'CONV2-Linux-x86_64.flatpak.asc'),
    path.join(releaseDir, 'CONV2-Linux-aarch64.flatpak.asc'),
    path.join(releaseDir, 'SHA256SUMS-Linux.txt'),
  ]);
});

test('Twemoji is not copied twice by electron-builder', () => {
  const packageJson = JSON.parse(read('package.json'));
  const extraResources = packageJson.build.extraResources || [];
  assert.equal(
    extraResources.some((entry) => entry.from === 'assets/twemoji'),
    false
  );
});

test('stable release metadata is internally aligned', () => {
  const packageJson = JSON.parse(read('package.json'));
  const lockfile = JSON.parse(read('package-lock.json'));
  const metainfo = read('com.burnttoasters.conv2.metainfo.xml');
  const changelog = read('CHANGELOG.md');

  assert.equal(packageJson.version, '1.5.0');
  assert.equal(lockfile.version, '1.5.0');
  assert.match(metainfo, /<release version="1\.5\.0"/);
  assert.match(changelog, /## Changes in `v1\.5\.0:`/);
  assert.doesNotMatch(changelog, /This is a Beta build/);
  assert.match(changelog, /CONV2-Win-x64-Setup\.exe/);
});
