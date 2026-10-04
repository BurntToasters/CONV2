const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  collectRendererAssetRefs,
  verifyPackageEntries,
} = require('../build-scripts/verify-package-contents.js');

// Failure modes for what ends up inside app.asar. Written before the verifier.

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const goodEntries = () => [
  '/package.json',
  '/dist/main/main.js',
  '/dist/main/preload.js',
  '/dist/renderer/index.html',
  '/dist/renderer/main.css',
  '/assets/icon.png',
  '/assets/icon.ico',
  '/assets/twemoji/26a0.svg',
  '/licenses.json',
];

const baseOptions = () => ({
  mainEntry: 'dist/main/main.js',
  referencedAssets: ['assets/icon.png', 'assets/twemoji/26a0.svg'],
  requiredFiles: ['dist/main/preload.js', 'dist/renderer/index.html', 'licenses.json'],
});

test('a complete package passes', () => {
  assert.deepEqual(verifyPackageEntries(goodEntries(), baseOptions()), []);
});

test('empty entry list fails instead of passing vacuously', () => {
  assert.notDeepEqual(verifyPackageEntries([], baseOptions()), []);
});

test('missing main entry fails', () => {
  const entries = goodEntries().filter((e) => e !== '/dist/main/main.js');
  assert.match(verifyPackageEntries(entries, baseOptions()).join('\n'), /main\.js/);
});

test('missing required runtime file fails', () => {
  const entries = goodEntries().filter((e) => e !== '/dist/main/preload.js');
  assert.match(verifyPackageEntries(entries, baseOptions()).join('\n'), /preload\.js/);
});

test('renderer-referenced icon missing from the package fails', () => {
  const entries = goodEntries().filter((e) => e !== '/assets/twemoji/26a0.svg');
  assert.match(verifyPackageEntries(entries, baseOptions()).join('\n'), /26a0\.svg/);
});

test('unreferenced twemoji shipped in the package fails', () => {
  const entries = [...goodEntries(), '/assets/twemoji/1f600.svg'];
  assert.match(verifyPackageEntries(entries, baseOptions()).join('\n'), /1f600\.svg/);
});

test('source maps in app or dependency code fail', () => {
  for (const extra of ['/dist/main/main.js.map', '/node_modules/semver/index.js.map']) {
    const errors = verifyPackageEntries([...goodEntries(), extra], baseOptions());
    assert.match(errors.join('\n'), /\.map/, extra);
  }
});

test('build-only icon sources in the package fail', () => {
  for (const extra of ['/assets/conv2.icns', '/assets/conv2.iconset/icon_16x16@1x.png']) {
    const errors = verifyPackageEntries([...goodEntries(), extra], baseOptions());
    assert.notDeepEqual(errors, [], extra);
  }
});

test('renderer asset refs are collected from HTML, CSS, and TS', () => {
  const refs = collectRendererAssetRefs(path.join(ROOT, 'src', 'renderer'));
  assert.ok(refs.includes('assets/icon.png'));
  assert.ok(refs.includes('assets/twemoji/26a0.svg'), 'CSS url() refs are collected');
  assert.ok(
    refs.every((ref) => fs.existsSync(path.join(ROOT, ref))),
    'every ref exists on disk'
  );
});

test('Store config ships exactly the same app files as the main config', () => {
  const msstore = yaml.load(
    fs.readFileSync(path.join(ROOT, 'electron-builder.msstore.yml'), 'utf8')
  );
  assert.deepEqual(msstore.files, pkg.build.files);
});

test('every referenced asset passes the configured file patterns', () => {
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
  const matcher = new FileMatcher(ROOT, ROOT, (s) => s, pkg.build.files);
  const filter = matcher.createFilter();
  const refs = collectRendererAssetRefs(path.join(ROOT, 'src', 'renderer'));
  const fileStat = { isDirectory: () => false };
  for (const ref of [...refs, 'assets/icon.ico']) {
    assert.ok(filter(path.join(ROOT, ref), fileStat), `${ref} excluded by build.files`);
  }
  assert.equal(filter(path.join(ROOT, 'assets/twemoji/1f600.svg'), fileStat), false);
  assert.equal(filter(path.join(ROOT, 'dist/main/main.js.map'), fileStat), false);
});
