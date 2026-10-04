// Release build session and quality-gate proof. The proof records that the
// full test gate passed on this exact checkout and environment; the session
// binds the subsequent release steps (draft, sign, mirror) to that proof.
// Both expire after 24 hours. Proof files live in gitignored directories so
// they never enter the release diff, and any failed gate run clears the proof.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scriptDirectory = __dirname;
const defaultRoot = path.resolve(scriptDirectory, '..');
const RELEASE_SESSION_RELATIVE_PATH = path.join('release', '.build-session.json');
const QUALITY_GATE_RELATIVE_PATH = path.join('coverage', '.release-quality.json');
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Only the proof files themselves are ignorable: CONV2 regenerates licenses.json
// but it is gitignored, and metainfo/sync outputs land before the gate runs.
function command(commandName, args, root) {
  // trimEnd only: git porcelain uses " M path" / "M  path". trim() would turn
  // the first into "M path" and break XY/path parsing.
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

/** Paths from `git status --porcelain=v1` (keeps leading spaces in status text). */
function porcelainPaths(statusText) {
  return statusText
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .flatMap((line) => {
      // XY PATH  or  XY ORIG -> PATH  (XY is always two status columns)
      const pathPart = line.length >= 3 ? line.slice(3) : line;
      return pathPart.includes(' -> ') ? pathPart.split(' -> ') : [pathPart];
    });
}

function isIgnorableReleaseDirtyPath(filePath) {
  // Git porcelain uses forward slashes on every platform, while the paths
  // used to read the generated proofs follow the host platform separator.
  const normalizedPath = filePath.replaceAll('\\', '/');
  const releaseSessionPath = RELEASE_SESSION_RELATIVE_PATH.replaceAll('\\', '/');
  const qualityGatePath = QUALITY_GATE_RELATIVE_PATH.replaceAll('\\', '/');
  return normalizedPath === releaseSessionPath || normalizedPath === qualityGatePath;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function currentReleaseIdentity(root = defaultRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return {
    version: String(packageJson.version || ''),
    commit: command('git', ['rev-parse', 'HEAD'], root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: command('npm', ['--version'], root),
    packageLockSha256: sha256File(path.join(root, 'package-lock.json')),
  };
}

function validateIdentity(record, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      throw new Error(`${label} ${key} does not match this checkout/environment.`);
    }
  }
}

function validateReleaseSession(
  session,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}
) {
  if (!session || typeof session !== 'object') {
    throw new Error('Release build session is not an object.');
  }
  if (!Number.isFinite(session.startedAt)) {
    throw new Error('Release build session has no valid start time.');
  }
  const age = now - session.startedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error('Release build session is expired; run release:prepare again.');
  }

  validateIdentity(session, expected, 'Release build session');
  if (
    !Number.isFinite(session.qualityGateCompletedAt) ||
    session.qualityGateCompletedAt >= session.startedAt
  ) {
    throw new Error('Release build session has no valid quality-gate proof.');
  }
  return session;
}

function validateQualityGate(
  qualityGate,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}
) {
  if (!qualityGate || typeof qualityGate !== 'object') {
    throw new Error('Release quality-gate proof is not an object.');
  }
  if (!Number.isFinite(qualityGate.completedAt)) {
    throw new Error('Release quality-gate proof has no valid completion time.');
  }
  const age = now - qualityGate.completedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error('Release quality-gate proof is expired; run test:all again.');
  }
  validateIdentity(qualityGate, expected, 'Release quality-gate proof');
  return qualityGate;
}

function clearQualityGateProof(root = defaultRoot) {
  fs.rmSync(path.join(root, QUALITY_GATE_RELATIVE_PATH), { force: true });
}

function recordSuccessfulQualityGate(root = defaultRoot) {
  let status;
  try {
    status = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  } catch {
    return { recorded: false, dirtyFiles: null };
  }
  if (status) {
    const dirtyPaths = porcelainPaths(status).filter(
      (filePath) => !isIgnorableReleaseDirtyPath(filePath)
    );
    if (dirtyPaths.length > 0) {
      return { recorded: false, dirtyFiles: status };
    }
  }
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(
    proofPath,
    `${JSON.stringify({ ...currentReleaseIdentity(root), completedAt: Date.now() })}\n`,
    { mode: 0o600 }
  );
  return { recorded: true, dirtyFiles: null };
}

function assertReleaseTreeClean(root = defaultRoot) {
  let status;
  try {
    status = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  } catch (error) {
    throw new Error(
      `Could not inspect the release working tree: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!status) return;
  const dirtyPaths = porcelainPaths(status).filter(
    (filePath) => !isIgnorableReleaseDirtyPath(filePath)
  );
  if (dirtyPaths.length > 0) {
    throw new Error(
      `Release working tree changed after the quality gate; run test:all again before continuing:\n${status}`
    );
  }
}

function verifyQualityGate(root = defaultRoot, options) {
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Release quality-gate proof is missing or invalid. Run test:all first: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateQualityGate(proof, currentReleaseIdentity(root), options);
}

function createReleaseSession(root = defaultRoot) {
  const qualityGate = verifyQualityGate(root);
  return {
    ...currentReleaseIdentity(root),
    qualityGateCompletedAt: qualityGate.completedAt,
    startedAt: Date.now(),
  };
}

function verifyReleaseSession(root = defaultRoot, options) {
  const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Release build session is missing or invalid. Run release:prepare first: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const validated = validateReleaseSession(session, currentReleaseIdentity(root), options);
  assertReleaseTreeClean(root);
  return validated;
}

if (require.main === module) {
  try {
    const session = verifyReleaseSession();
    console.log(
      `release-session: ok (${session.version}, ${session.commit.slice(0, 12)}, ${session.platform}-${session.arch})`
    );
  } catch (error) {
    console.error(
      `release-session: FAILED: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  QUALITY_GATE_RELATIVE_PATH,
  RELEASE_SESSION_RELATIVE_PATH,
  assertReleaseTreeClean,
  clearQualityGateProof,
  createReleaseSession,
  currentReleaseIdentity,
  isIgnorableReleaseDirtyPath,
  porcelainPaths,
  recordSuccessfulQualityGate,
  validateQualityGate,
  validateReleaseSession,
  verifyQualityGate,
  verifyReleaseSession,
};
