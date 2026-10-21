const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const { isBetaReleaseVersion } = require('../build-scripts/release-version');

const REPOSITORY_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(REPOSITORY_ROOT, 'release');

const BUILD_ONLY_DIRECTORIES = [
  'mac-universal',
  'win-unpacked',
  'win-arm64-unpacked',
  'linux-unpacked',
  'linux-arm64-unpacked',
];

const BUILD_ONLY_FILES = ['builder-debug.yml', 'builder-effective-config.yaml'];
const HASH_BUFFER_BYTES = 1024 * 1024;

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function cleanReleaseArtifacts(releaseDir = RELEASE_DIR) {
  for (const dir of BUILD_ONLY_DIRECTORIES) {
    removePath(path.join(releaseDir, dir));
  }

  for (const file of BUILD_ONLY_FILES) {
    removePath(path.join(releaseDir, file));
  }
}

function getAfterPackLocation(env = process.env) {
  const value = env.AFTER_PACK_LOC;
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function readPackageVersion(repositoryRoot = REPOSITORY_ROOT) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  );
  return typeof packageJson.version === 'string' ? packageJson.version : '';
}

function shouldSkipBetaMirror(env = process.env, version) {
  if (!isBetaReleaseVersion(version)) return false;
  return String(env.OVERRIDE_BETA_MIRROR_SKIP ?? '').trim() !== '1';
}

function pathsEqual(left, right, platform = process.platform) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (platform === 'win32') {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

function pathIsSameOrInside(candidate, parent, platform = process.platform) {
  const normalize = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const resolvedCandidate = normalize(path.resolve(candidate));
  const resolvedParent = normalize(path.resolve(parent));
  return (
    resolvedCandidate === resolvedParent ||
    resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
  );
}

function isMirrorableReleaseEntry(name) {
  // Dotfiles are build/session markers (e.g. .build-session.json), never ship artifacts.
  return Boolean(name) && !name.startsWith('.');
}

function getReleaseEntries(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }

  const entries = fs.readdirSync(releaseDir).filter(isMirrorableReleaseEntry);
  if (entries.length === 0) {
    throw new Error(`release directory is empty: ${releaseDir}`);
  }
  return entries;
}

function verifyCopiedPath(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  let destination;
  try {
    destination = fs.statSync(destinationPath);
  } catch {
    throw new Error(`mirrored path is missing: ${destinationPath}`);
  }

  if (source.isDirectory() !== destination.isDirectory()) {
    throw new Error(`mirrored path type differs: ${destinationPath}`);
  }
  if (source.isFile()) {
    if (source.size !== destination.size) {
      throw new Error(
        `mirrored file size differs: ${destinationPath} (${destination.size} bytes; expected ${source.size})`
      );
    }
    if (sha256File(sourcePath) !== sha256File(destinationPath)) {
      throw new Error(`mirrored file hash differs: ${destinationPath}`);
    }
  }
  if (source.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath)) {
      verifyCopiedPath(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
  }
}

function progress(logger, message) {
  if (logger && typeof logger.error === 'function') {
    logger.error(`[release:mirror] ${message}`);
  }
}

// Avoid fs.cpSync's native recursive path: on Windows mapped drives (Z:) it can
// abort Node without a catchable error, leaving nothing mirrored.
function copyFileForMirror(sourcePath, destinationPath) {
  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (error) {
    // SMB/CIFS often rejects permission-bit preservation; plain bytes work.
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }
    fs.writeFileSync(destinationPath, fs.readFileSync(sourcePath));
  }
}

function copyPathRecursive(sourcePath, destinationPath) {
  if (fs.statSync(sourcePath).isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyPathRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileForMirror(sourcePath, destinationPath);
}

function uniqueMirrorSibling(destinationPath, label) {
  return path.join(
    path.dirname(destinationPath),
    `.conv2-mirror-${label}-${process.pid}-${crypto.randomBytes(6).toString('hex')}-${path.basename(destinationPath)}`
  );
}

// Stage, verify, then swap so a failed copy never replaces a good mirrored entry.
function copyReleaseEntryToMirror(sourcePath, destinationPath) {
  const stagingPath = uniqueMirrorSibling(destinationPath, 'new');
  const rollbackPath = uniqueMirrorSibling(destinationPath, 'old');
  try {
    copyPathRecursive(sourcePath, stagingPath);
    verifyCopiedPath(sourcePath, stagingPath);
  } catch (error) {
    removePath(stagingPath);
    throw error;
  }

  const hadPrevious = fs.existsSync(destinationPath);
  if (hadPrevious) {
    fs.renameSync(destinationPath, rollbackPath);
  }
  try {
    fs.renameSync(stagingPath, destinationPath);
  } catch (error) {
    if (hadPrevious && fs.existsSync(rollbackPath)) {
      try {
        fs.renameSync(rollbackPath, destinationPath);
      } catch {
        // Leave rollback beside dest for manual recovery.
      }
    }
    removePath(stagingPath);
    throw error;
  }
  verifyCopiedPath(sourcePath, destinationPath);
  if (hadPrevious) {
    removePath(rollbackPath);
  }
}

function resolveMirrorPaths(releaseDir = RELEASE_DIR, destination) {
  if (!destination) {
    throw new Error('AFTER_PACK_LOC is empty');
  }
  if (!path.isAbsolute(destination)) {
    throw new Error(`AFTER_PACK_LOC must be an absolute path on this platform: ${destination}`);
  }

  const requestedReleaseDir = path.resolve(releaseDir);
  if (!fs.existsSync(requestedReleaseDir) || !fs.statSync(requestedReleaseDir).isDirectory()) {
    throw new Error(`release directory does not exist: ${requestedReleaseDir}`);
  }
  const resolvedReleaseDir = fs.realpathSync.native(requestedReleaseDir);
  const requestedDestination = path.resolve(destination);
  if (fs.existsSync(requestedDestination) && fs.lstatSync(requestedDestination).isSymbolicLink()) {
    throw new Error(`AFTER_PACK_LOC must not be a symbolic link: ${requestedDestination}`);
  }
  // Resolve the nearest existing ancestor; the destination may not exist yet.
  const missingSegments = [];
  let existingAncestor = requestedDestination;
  while (!fs.existsSync(existingAncestor)) {
    missingSegments.unshift(path.basename(existingAncestor));
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const resolvedDestination = path.join(
    fs.realpathSync.native(existingAncestor),
    ...missingSegments
  );

  if (pathsEqual(resolvedDestination, resolvedReleaseDir)) {
    throw new Error('AFTER_PACK_LOC cannot be the release directory');
  }
  if (pathIsSameOrInside(resolvedDestination, resolvedReleaseDir)) {
    throw new Error('AFTER_PACK_LOC cannot be inside the release directory');
  }
  const resolvedRepositoryRoot = fs.realpathSync.native(REPOSITORY_ROOT);
  if (pathIsSameOrInside(resolvedDestination, resolvedRepositoryRoot)) {
    throw new Error(`AFTER_PACK_LOC must be outside the repository: ${resolvedRepositoryRoot}`);
  }

  return { resolvedReleaseDir, resolvedDestination };
}

function copyReleaseAssets(releaseDir = RELEASE_DIR, destination, { logger = console } = {}) {
  const { resolvedReleaseDir, resolvedDestination } = resolveMirrorPaths(releaseDir, destination);
  progress(logger, `copy resolve: src=${resolvedReleaseDir} dest=${resolvedDestination}`);

  const entries = getReleaseEntries(resolvedReleaseDir);
  fs.mkdirSync(resolvedDestination, { recursive: true });
  progress(
    logger,
    `copying ${entries.length} entries to shared mirror (overwrite same names only)`
  );

  for (const entry of entries) {
    progress(logger, `copy ${entry}`);
    copyReleaseEntryToMirror(
      path.join(resolvedReleaseDir, entry),
      path.join(resolvedDestination, entry)
    );
    progress(logger, `verified ${entry}`);
  }

  return entries.length;
}

function run({
  releaseDir = RELEASE_DIR,
  env = process.env,
  logger = console,
  version = readPackageVersion(),
} = {}) {
  let destination = getAfterPackLocation(env);
  let skippedBetaMirror = false;
  if (destination && shouldSkipBetaMirror(env, version)) {
    skippedBetaMirror = true;
    progress(
      logger,
      `beta version ${version}; skipping AFTER_PACK_LOC mirror (set OVERRIDE_BETA_MIRROR_SKIP=1 to force).`
    );
    destination = '';
  } else if (destination) {
    // Validate before cleaning so a bad destination leaves release/ intact.
    resolveMirrorPaths(releaseDir, destination);
  }

  cleanReleaseArtifacts(releaseDir);
  if (!destination) {
    return { mirrored: false, destination: null, skippedBetaMirror };
  }

  const copiedEntries = copyReleaseAssets(releaseDir, destination, { logger });
  return {
    mirrored: true,
    destination: path.resolve(destination),
    copiedEntries,
    skippedBetaMirror: false,
  };
}

function finalizeReleaseAssets({
  releaseDir = RELEASE_DIR,
  env = process.env,
  logger = console,
  version = readPackageVersion(),
} = {}) {
  const result = run({ releaseDir, env, logger, version });
  if (result.mirrored) {
    logger.log(
      `Mirrored and verified ${result.copiedEntries} cleaned release entries to: ${result.destination}`
    );
  } else if (result.skippedBetaMirror) {
    logger.warn(
      `WARNING: Cleaned release assets without mirroring (beta version ${version}; set OVERRIDE_BETA_MIRROR_SKIP=1 to force).`
    );
  } else {
    logger.warn(
      'WARNING: Cleaned release assets, but AFTER_PACK_LOC is not set; mirror intentionally skipped.'
    );
  }
  return result;
}

if (require.main === module) {
  try {
    finalizeReleaseAssets();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`Failed to finalize release assets: ${message}`);
    console.error(`Source release directory: ${RELEASE_DIR}`);
    console.error(`Configured AFTER_PACK_LOC: ${JSON.stringify(getAfterPackLocation())}`);
    console.error(`Platform: ${process.platform}; Node: ${process.version}; cwd: ${process.cwd()}`);
    process.exit(1);
  }
}

module.exports = {
  REPOSITORY_ROOT,
  RELEASE_DIR,
  BUILD_ONLY_DIRECTORIES,
  BUILD_ONLY_FILES,
  cleanReleaseArtifacts,
  getAfterPackLocation,
  isBetaReleaseVersion,
  readPackageVersion,
  shouldSkipBetaMirror,
  pathsEqual,
  pathIsSameOrInside,
  isMirrorableReleaseEntry,
  getReleaseEntries,
  verifyCopiedPath,
  resolveMirrorPaths,
  copyReleaseEntryToMirror,
  copyReleaseAssets,
  run,
  finalizeReleaseAssets,
};
