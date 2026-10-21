const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const flatpakManifest = yaml.load(read('com.burnttoasters.conv2.yml'));

test('Flatpak sandbox permissions match the electron-builder config', () => {
  // Two build paths produce Flatpaks: build-scripts/flatpak.js uses the root
  // manifest, `npm run build:flatpak` uses package.json. If these drift, which
  // artifact a user installs decides how much filesystem access the app gets.
  const manifestArgs = flatpakManifest['finish-args'];
  const builderArgs = packageJson.build.flatpak.finishArgs;
  assert.ok(Array.isArray(manifestArgs), 'root manifest must declare finish-args');
  assert.ok(Array.isArray(builderArgs), 'package.json must declare build.flatpak.finishArgs');
  assert.deepEqual(
    [...manifestArgs].sort(),
    [...builderArgs].sort(),
    'com.burnttoasters.conv2.yml finish-args and package.json build.flatpak.finishArgs must be identical'
  );
});

test('Flatpak does not share the host /tmp', () => {
  const manifestArgs = flatpakManifest['finish-args'];
  const builderArgs = packageJson.build.flatpak.finishArgs;
  for (const args of [manifestArgs, builderArgs]) {
    assert.equal(
      args.includes('--filesystem=/tmp'),
      false,
      'the app only needs its own sandboxed /tmp'
    );
  }
});

test('Flatpak Node SDK extension matches the engines requirement', () => {
  const enginesNode = packageJson.engines.node;
  const enginesMajor = enginesNode.match(/(\d+)/)?.[1];
  assert.ok(enginesMajor, `could not read a Node major from engines.node: ${enginesNode}`);

  const extensions = flatpakManifest['sdk-extensions'] || [];
  const nodeExtension = extensions.find((entry) => /Sdk\.Extension\.node\d+$/.test(entry));
  assert.ok(nodeExtension, 'Flatpak manifest must declare a Node SDK extension');
  assert.equal(
    nodeExtension,
    `org.freedesktop.Sdk.Extension.node${enginesMajor}`,
    'Flatpak would build with a different Node major than the project supports'
  );

  const buildOptions = flatpakManifest.modules?.[0]?.['build-options'] || {};
  assert.equal(
    buildOptions['append-path'],
    `/usr/lib/sdk/node${enginesMajor}/bin`,
    'append-path must point at the same Node SDK extension'
  );

  // build/setup-flatpak.js installs the extension for local builds; if it
  // installs a different major, flatpak:setup succeeds but the build fails.
  const setupFlatpak = read('build/setup-flatpak.js');
  const declaredExtensions = [...setupFlatpak.matchAll(/Sdk\.Extension\.node(\d+)/g)].map(
    (match) => match[1]
  );
  assert.ok(declaredExtensions.length > 0, 'setup-flatpak.js must declare a Node SDK extension');
  for (const major of declaredExtensions) {
    assert.equal(
      major,
      enginesMajor,
      'build/setup-flatpak.js installs a different Node SDK major than the manifest needs'
    );
  }
});

test('Flatpak runtime versions agree across build paths', () => {
  const setupFlatpak = read('build/setup-flatpak.js');
  const setupRuntime = setupFlatpak.match(/RUNTIME_VERSION = '([^']+)'/)?.[1];
  assert.equal(setupRuntime, flatpakManifest['runtime-version']);
  assert.equal(setupRuntime, flatpakManifest['base-version']);
  assert.equal(setupRuntime, packageJson.build.flatpak.runtimeVersion);
  assert.equal(setupRuntime, packageJson.build.flatpak.baseVersion);
});

test('macOS hardened runtime does not disable library validation', () => {
  // FFmpeg/ffprobe run as separate processes, so the app never needs to load
  // unsigned third-party libraries. Granting this would weaken code signing.
  const entitlements = read('build/entitlements.mac.plist');
  // Only a <key> element grants an entitlement; a comment explaining why it is
  // withheld must not trip this check.
  assert.doesNotMatch(
    entitlements,
    /<key>\s*com\.apple\.security\.cs\.disable-library-validation\s*<\/key>/
  );
  assert.match(entitlements, /<key>\s*com\.apple\.security\.cs\.allow-jit\s*<\/key>/);
});

test('MAS entitlements stay sandboxed and free of hardened-runtime exceptions', () => {
  const mas = read('build/entitlements.mas.plist');
  assert.match(mas, /com\.apple\.security\.app-sandbox/);
  assert.doesNotMatch(mas, /com\.apple\.security\.cs\./);
});

test('release metadata version is consistent across packaging files', () => {
  const metainfo = read('com.burnttoasters.conv2.metainfo.xml');
  const lockfile = JSON.parse(read('package-lock.json'));
  assert.equal(lockfile.version, packageJson.version);
  assert.ok(
    metainfo.includes(`<release version="${packageJson.version}"`),
    'AppStream metadata must describe the current version'
  );
});
