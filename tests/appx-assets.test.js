const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const AppXTarget = require('app-builder-lib/out/targets/AppxTarget.js').default;

// Failure modes for Microsoft Store AppX assets. Written before the assets existed.

const root = path.join(__dirname, '..');
const assetDir = path.join(root, 'build', 'appx');
const msstore = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.msstore.yml'), 'utf8'));

const REQUIRED = {
  'StoreLogo.png': [50, 50],
  'Square44x44Logo.png': [44, 44],
  'Square44x44Logo.targetsize-44_altform-unplated.png': [44, 44],
  'Square150x150Logo.png': [150, 150],
  'Wide310x150Logo.png': [310, 150],
};

const readPngHeader = (file) => {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${path.basename(file)} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
};

test('every AppX logo exists with the size Windows expects', () => {
  for (const [name, [width, height]] of Object.entries(REQUIRED)) {
    const file = path.join(assetDir, name);
    assert.ok(fs.existsSync(file), `missing build/appx/${name}`);
    const header = readPngHeader(file);
    assert.deepEqual([header.width, header.height], [width, height], name);
  }
});

test('logos keep transparency so tiles and the taskbar are not boxed', () => {
  for (const name of Object.keys(REQUIRED)) {
    assert.equal(readPngHeader(path.join(assetDir, name)).colorType, 6, `${name} lacks alpha`);
  }
});

test('electron-builder does not fall back to its sample Electron logos', async () => {
  const vm = { toVmFile: (p) => p, pathSep: '/' };
  const { allAssets } = await AppXTarget.computeUserAssets(vm, '/VENDOR', assetDir);
  const samples = allAssets.filter((asset) => asset.startsWith('/VENDOR'));
  assert.deepEqual(samples, []);
});

test('only PNG logos are packaged from the AppX asset folder', () => {
  const packaged = fs.readdirSync(assetDir).filter((name) => !name.startsWith('.'));
  const stray = packaged.filter((name) => !name.endsWith('.png'));
  assert.deepEqual(stray, []);
});

test('custom AppX manifest resolves and references the packaged logos', () => {
  const manifestPath = path.join(root, msstore.appx.customManifestPath);
  assert.ok(fs.existsSync(manifestPath), `missing ${msstore.appx.customManifestPath}`);
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  for (const token of ['${logo}', '${square150x150Logo}', '${square44x44Logo}']) {
    assert.ok(manifest.includes(token), `manifest missing ${token}`);
  }
});

test('wide logo is referenced by the manifest, not shipped unused', () => {
  const manifest = fs.readFileSync(path.join(root, msstore.appx.customManifestPath), 'utf8');
  const visualElements = manifest.match(/<uap:VisualElements[\s\S]*?<\/uap:VisualElements>/);
  assert.ok(visualElements, 'manifest missing uap:VisualElements');
  assert.ok(visualElements[0].includes('${defaultTile}'), 'Wide310x150Logo is never used');
});
