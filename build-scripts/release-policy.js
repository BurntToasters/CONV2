'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Stable releases must not use beta recovery overrides. FORCE_UPLOAD also
// bypasses the draft-target check in ensure-draft-release, so it stays banned.
const STABLE_FORBIDDEN_ENV = [
  'FORCE_UPLOAD',
  'ALLOW_ASSET_REPLACE',
  'SKIP_RELEASE_MIRROR',
  'OVERRIDE_BETA_MIRROR_SKIP',
];

// Stable uploads must target the canonical repository only; env retargeting is
// a beta-fork recovery path and must not ship a stable feed elsewhere.
const STABLE_CANONICAL_ENV = {
  GH_REPO_OWNER: 'BurntToasters',
  GH_REPO_NAME: 'CONV2',
};

function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isStableReleaseVersion(version) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(String(version || ''));
}

function readPackageVersion(root = path.join(__dirname, '..')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return String(pkg.version || '').trim();
}

function assertStableReleaseOverridesAllowed(env = process.env, version = readPackageVersion()) {
  if (!isStableReleaseVersion(version)) return;
  const blocked = STABLE_FORBIDDEN_ENV.filter((name) => isExplicitTruthy(env[name]));
  if (blocked.length > 0) {
    throw new Error(
      `Stable release ${version} refuses ${blocked.join(', ')}. Those overrides are beta recovery paths only.`
    );
  }
  const mismatches = [];
  for (const [name, canonical] of Object.entries(STABLE_CANONICAL_ENV)) {
    const value = String(env[name] || '').trim();
    if (value && value !== canonical) {
      mismatches.push(`${name}="${value}"`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Stable release ${version} refuses non-canonical GitHub targets: ${mismatches.join(', ')}.`
    );
  }
}

if (require.main === module) {
  try {
    assertStableReleaseOverridesAllowed();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  STABLE_CANONICAL_ENV,
  STABLE_FORBIDDEN_ENV,
  assertStableReleaseOverridesAllowed,
  isExplicitTruthy,
  isStableReleaseVersion,
  readPackageVersion,
};
