const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  checkMasPrerequisites,
  PROFILE_RELATIVE_PATH,
} = require('../build-scripts/mas-preflight.js');

// Failure modes for the MAS build preflight. Written before mas-preflight.js.

const withProject = (setup) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-mas-'));
  try {
    fs.mkdirSync(path.join(root, 'build'), { recursive: true });
    setup?.(root);
    return checkMasPrerequisites(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('profile path matches package.json build.mas.provisioningProfile', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.build.mas.provisioningProfile, PROFILE_RELATIVE_PATH);
});

test('missing provisioning profile fails and names the path', () => {
  const result = withProject();
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /build\/embedded\.provisionprofile/);
});

test('empty provisioning profile fails', () => {
  const result = withProject((root) =>
    fs.writeFileSync(path.join(root, PROFILE_RELATIVE_PATH), '')
  );
  assert.equal(result.ok, false);
});

test('directory in place of the profile fails', () => {
  const result = withProject((root) => fs.mkdirSync(path.join(root, PROFILE_RELATIVE_PATH)));
  assert.equal(result.ok, false);
});

test('missing MAS entitlements fail', () => {
  const result = withProject((root) =>
    fs.writeFileSync(path.join(root, PROFILE_RELATIVE_PATH), 'profile')
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /entitlements\.mas\.plist/);
});

test('complete prerequisites pass', () => {
  const result = withProject((root) => {
    fs.writeFileSync(path.join(root, PROFILE_RELATIVE_PATH), 'profile');
    fs.writeFileSync(path.join(root, 'build', 'entitlements.mas.plist'), '<plist/>');
    fs.writeFileSync(path.join(root, 'build', 'entitlements.mas.inherit.plist'), '<plist/>');
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('CLI exits non-zero before any packaging work when prerequisites are missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-mas-cli-'));
  try {
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'build-scripts', 'mas-preflight.js')],
      { cwd: root, encoding: 'utf8' }
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /embedded\.provisionprofile/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('build:mac:mas runs the preflight before compiling', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const script = pkg.scripts['build:mac:mas'];
  assert.ok(script.indexOf('mas-preflight.js') !== -1);
  assert.ok(script.indexOf('mas-preflight.js') < script.indexOf('npm run compile'));
});
