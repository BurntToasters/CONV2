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

const FLATPAK_NPM_PREFIX = '/run/build/conv2/npm-global';

test('Flatpak Node SDK extension matches the engines requirement', () => {
  const enginesNode = packageJson.engines.node;
  const supportedMajors = [
    ...new Set([...enginesNode.matchAll(/(\d+)\.\d+\.\d+/g)].map((m) => m[1])),
  ];
  assert.ok(
    supportedMajors.length > 0,
    `could not read any Node major from engines.node: ${enginesNode}`
  );

  const extensions = flatpakManifest['sdk-extensions'] || [];
  const nodeExtension = extensions.find((entry) => /Sdk\.Extension\.node\d+$/.test(entry));
  assert.ok(nodeExtension, 'Flatpak manifest must declare a Node SDK extension');
  const manifestMajor = nodeExtension.match(/Sdk\.Extension\.node(\d+)$/)?.[1];
  assert.ok(
    supportedMajors.includes(manifestMajor),
    `Flatpak Node SDK major (${manifestMajor}) must be in engines.node majors (${supportedMajors.join(', ')})`
  );

  const buildOptions = flatpakManifest.modules?.[0]?.['build-options'] || {};
  assert.equal(
    buildOptions['prepend-path'],
    `${FLATPAK_NPM_PREFIX}/bin:/usr/lib/sdk/node${manifestMajor}/bin`,
    'prepend-path must put the pinned npm first, then the same Node SDK extension'
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
      manifestMajor,
      'build/setup-flatpak.js installs a different Node SDK major than the manifest needs'
    );
  }
});

// The Node SDK extension ships an npm below engines.npm. Failure modes: npm ci runs
// on the SDK npm (EBADENGINE); the pin drifts from CI's NPM_VERSION; the install is
// not verified, so a failed install silently falls back to the SDK npm.
test('Flatpak build installs the CI npm version before npm ci', () => {
  const ciNpm = yaml.load(read('.github/workflows/ci.yml')).env.NPM_VERSION;
  const commands = flatpakManifest.modules[0]['build-commands'];
  const install = commands.findIndex(
    (cmd) =>
      cmd.startsWith(`npm install --global npm@${ciNpm} `) &&
      cmd.includes(`--prefix ${FLATPAK_NPM_PREFIX}`)
  );
  const verify = commands.indexOf(`test "$(npm --version)" = "${ciNpm}"`);
  const firstCi = commands.findIndex((cmd) => cmd.startsWith('npm ci'));
  assert.ok(install !== -1, `Flatpak must install npm@${ciNpm} into ${FLATPAK_NPM_PREFIX}`);
  assert.ok(verify > install, 'Flatpak must verify the installed npm version');
  assert.ok(firstCi > verify, 'npm ci must run after the pinned npm is verified');
  const [major, minor, patch] = ciNpm.split('.').map(Number);
  const floor = packageJson.engines.npm
    .match(/>=(\d+)\.(\d+)\.(\d+)/)
    .slice(1)
    .map(Number);
  assert.ok(
    major * 1e6 + minor * 1e3 + patch >= floor[0] * 1e6 + floor[1] * 1e3 + floor[2],
    `CI npm ${ciNpm} must satisfy engines.npm ${packageJson.engines.npm}`
  );
});

test('Flatpak runtime and base versions agree across build paths', () => {
  const setupFlatpak = read('build/setup-flatpak.js');
  const setupRuntime = setupFlatpak.match(/RUNTIME_VERSION = '([^']+)'/)?.[1];
  const setupBase = setupFlatpak.match(/BASE_VERSION = '([^']+)'/)?.[1];
  assert.equal(setupRuntime, flatpakManifest['runtime-version']);
  assert.equal(setupRuntime, packageJson.build.flatpak.runtimeVersion);
  assert.equal(setupBase, flatpakManifest['base-version']);
  assert.equal(setupBase, packageJson.build.flatpak.baseVersion);
  // SDK extensions follow the freedesktop branch, not the GNOME version.
  assert.match(setupFlatpak, /\$\{ext\}\/\/\$\{BASE_VERSION\}/);
});

test('Flatpak setup verification sees BaseApp, which is an app, not a runtime', () => {
  // `flatpak list --runtime` omits apps, so BaseApp was always reported missing.
  const setupFlatpak = read('build/setup-flatpak.js');
  assert.doesNotMatch(setupFlatpak, /runSilent\('flatpak list --runtime/);
  assert.match(setupFlatpak, /runSilent\('flatpak list --columns=application,arch,branch'\)/);
});

test('Flatpak sideload bundles name Flathub as the runtime source', () => {
  // Without it, installing the bundle fails on systems that lack the Flathub remote.
  const flatpakScript = read('build-scripts/flatpak.js');
  assert.match(flatpakScript, /build-bundle[^`]*--runtime-repo=\$\{FLATHUB_REPO\}/);
  assert.match(
    flatpakScript,
    /FLATHUB_REPO = 'https:\/\/flathub\.org\/repo\/flathub\.flatpakrepo'/
  );
});

test('Flatpak uses the GNOME runtime on every build path', () => {
  const setupFlatpak = read('build/setup-flatpak.js');
  assert.equal(flatpakManifest.runtime, 'org.gnome.Platform');
  assert.equal(flatpakManifest.sdk, 'org.gnome.Sdk');
  assert.equal(packageJson.build.flatpak.runtime, flatpakManifest.runtime);
  assert.equal(packageJson.build.flatpak.sdk, flatpakManifest.sdk);
  assert.match(setupFlatpak, /'org\.gnome\.Platform'/);
  assert.match(setupFlatpak, /'org\.gnome\.Sdk'/);
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
