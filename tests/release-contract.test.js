const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('conversion IPC returns the redacted result', () => {
  const source = read('src/main/main.ts');
  assert.match(
    source,
    /webContents\.send\('conversion-complete', resultForRenderer\);\s*return resultForRenderer;/
  );
});

test('conversion cancellation aborts preflight as well as FFmpeg', () => {
  const source = read('src/main/main.ts');
  assert.match(source, /activeConversionAbortController\?\.abort\(\)/);
  assert.match(source, /signal: conversionAbortController\.signal/);
  assert.match(source, /cancelActiveConversion\(!!force\)/);
});

test('renderer locks conversion startup before asynchronous preparation', () => {
  const source = read('src/renderer/renderer.ts');
  assert.match(source, /if \(isConverting \|\| conversionStarting\) return;/);
  assert.match(
    source,
    /conversionStarting = true;\s*elements\.convertBtn\.disabled = true;\s*void runConversionWorkflow\(\)/
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
  const versionPattern = escapeRegex(packageJson.version);

  assert.equal(lockfile.version, packageJson.version);
  assert.match(metainfo, new RegExp(`<release version="${versionPattern}"`));
  assert.match(changelog, new RegExp(String.raw`## Changes in \`v${versionPattern}:\``));
  assert.doesNotMatch(changelog, /This is a Beta build/);
  assert.match(changelog, /CONV2-Win-x64-Setup\.exe/);
  const downloadsSection = changelog.split(/^## Changes in /m, 1)[0];
  const downloadVersions = [...downloadsSection.matchAll(/releases\/download\/v([^/]+)\//g)].map(
    (match) => match[1]
  );
  assert.ok(downloadVersions.length > 0, 'changelog must contain release download URLs');
  assert.deepEqual(
    [...new Set(downloadVersions)],
    [packageJson.version],
    'every changelog download URL must use the package version'
  );
});
