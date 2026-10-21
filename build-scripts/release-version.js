'use strict';

// Single source of truth for release channel classification. Every release
// path (preflight, draft, sign, verify, publish, mirror) must agree on what
// counts as beta or stable and reject everything else, so the pattern lives
// here instead of being re-typed per script.

const NUMERIC_VERSION = '(?:0|[1-9]\\d*)';
const BETA_VERSION = new RegExp(
  `^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}-beta\\.${NUMERIC_VERSION}$`
);
const STABLE_VERSION = new RegExp(`^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}$`);

function isBetaReleaseVersion(version) {
  return BETA_VERSION.test(String(version || ''));
}

function isStableReleaseVersion(version) {
  return STABLE_VERSION.test(String(version || ''));
}

function assertSupportedReleaseVersion(version) {
  if (!isBetaReleaseVersion(version) && !isStableReleaseVersion(version)) {
    throw new Error(`Unsupported release version '${version}'; CONV2 releases use beta or stable.`);
  }
  return version;
}

// Beta releases come from the beta branch, stable releases from main. The
// draft target and final tag bind to that branch tip through preflight.
function expectedReleaseBranch(version) {
  if (isStableReleaseVersion(version)) return 'main';
  if (isBetaReleaseVersion(version)) return 'beta';
  throw new Error(`Unsupported release version '${version}'; CONV2 releases use beta or stable.`);
}

module.exports = {
  BETA_VERSION,
  STABLE_VERSION,
  assertSupportedReleaseVersion,
  expectedReleaseBranch,
  isBetaReleaseVersion,
  isStableReleaseVersion,
};
