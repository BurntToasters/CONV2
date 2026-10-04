const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getReleaseUploadFiles } = require('./release-upload-policy');
const { assertGitHubCliAuthenticated, githubApi, uploadReleaseAsset } = require('./github-cli');
const { assertStableReleaseOverridesAllowed, isExplicitTruthy } = require('./release-policy');
const {
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  isExpectedRelease,
  listAllGithubPages,
} = require('./release-draft-metadata');

// Environment variables are loaded via the `dotenv -e .env --` prefix in npm scripts.

const RELEASE_DIR = path.join(__dirname, '..', 'release');
const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const REPO_OWNER = process.env.GH_REPO_OWNER || 'BurntToasters';
const REPO_NAME = process.env.GH_REPO_NAME || 'CONV2';
const GH_REQUEST_RETRIES = Number.parseInt(process.env.GH_REQUEST_RETRIES || '3', 10);
const GH_REQUEST_RETRY_DELAY_MS = Number.parseInt(
  process.env.GH_REQUEST_RETRY_DELAY_MS || '1500',
  10
);

const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG_NAME = 'v' + VERSION;
// Channel classification lives in build-scripts/release-version.js so every
// release path agrees on beta vs stable and rejects unsupported channels.
const { assertSupportedReleaseVersion, isBetaReleaseVersion } = require('./release-version');
assertSupportedReleaseVersion(VERSION);
const IS_PRERELEASE = isBetaReleaseVersion(VERSION);

function currentReleaseCommit() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error('Could not resolve an exact release commit from git HEAD.');
  }
  return commit;
}

function assertReleaseTargetsCommit(release, commit, env = process.env, log = console) {
  if (release && release.target_commitish === commit) return release;
  if (isExplicitTruthy(env.FORCE_UPLOAD)) {
    log.warn(
      'WARNING: Draft release ' +
        TAG_NAME +
        ' targets ' +
        ((release && release.target_commitish) || 'an unknown commit') +
        ', not checked-out commit ' +
        commit +
        '. FORCE_UPLOAD=1 bypassing commit check.'
    );
    return release;
  }
  throw new Error(
    'Draft release ' +
      TAG_NAME +
      ' targets ' +
      ((release && release.target_commitish) || 'an unknown commit') +
      ', not checked-out commit ' +
      commit +
      '. Delete or retarget stale draft before uploading assets. Or set FORCE_UPLOAD=1 to bypass.'
  );
}

const args = process.argv.slice(2);
const archArgIndex = args.findIndex((arg) => arg === '--arch');
const TARGET_ARCH = archArgIndex !== -1 && args[archArgIndex + 1] ? args[archArgIndex + 1] : null;

const SIGNABLE_EXTENSIONS = [
  '.dmg',
  '.zip',
  '.exe',
  '.msi',
  '.appimage',
  '.deb',
  '.rpm',
  '.appx',
  '.msix',
  '.flatpak',
];

const ARCH_PATTERNS = {
  x64: ['-x86_64', '-amd64', '-x64', '_x64', '_amd64'],
  arm64: ['-arm64', '-aarch64', '_arm64', '_aarch64'],
};

function getPlatformName(arch) {
  switch (process.platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return arch ? 'Linux-' + arch : 'Linux';
    default:
      return process.platform;
  }
}

function getFileArch(filename) {
  const lowerFile = filename.toLowerCase();
  for (const [arch, patterns] of Object.entries(ARCH_PATTERNS)) {
    if (patterns.some((pattern) => lowerFile.includes(pattern))) {
      return arch;
    }
  }
  return null;
}

function getFilesToSign() {
  if (!fs.existsSync(RELEASE_DIR)) {
    console.error('ERROR: Release directory not found:', RELEASE_DIR);
    console.error('   Run a build command first, e.g.: npm run release:win');
    process.exit(1);
  }

  const files = fs.readdirSync(RELEASE_DIR);
  return files.filter((file) => {
    const fullPath = path.join(RELEASE_DIR, file);

    if (!fs.statSync(fullPath).isFile()) return false;

    const lowerFile = file.toLowerCase();
    const hasSignableExt = SIGNABLE_EXTENSIONS.some((ext) => lowerFile.endsWith(ext));

    if (!hasSignableExt) return false;
    if (TARGET_ARCH) {
      const fileArch = getFileArch(file);
      return fileArch === TARGET_ARCH || fileArch === null;
    }

    return true;
  });
}

function generateChecksum(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

function signFile(filePath) {
  const fileName = path.basename(filePath);
  const ascFile = filePath + '.asc';

  console.log('Signing: ' + fileName);

  try {
    if (fs.existsSync(ascFile)) {
      fs.unlinkSync(ascFile);
    }

    const gpgArgs = ['--batch', '--yes', '--armor', '--detach-sign'];

    if (GPG_KEY_ID) {
      gpgArgs.push('--local-user', GPG_KEY_ID);
    }

    if (GPG_PASSPHRASE) {
      gpgArgs.push('--pinentry-mode', 'loopback', '--passphrase-fd', '0');
    }

    gpgArgs.push('--output', ascFile, filePath);

    execFileSync('gpg', gpgArgs, {
      stdio: 'pipe',
      input: GPG_PASSPHRASE ? `${GPG_PASSPHRASE}\n` : undefined,
    });
    console.log('   ✓ Created ' + path.basename(ascFile));
    return ascFile;
  } catch (error) {
    console.error('   ✗ FAILED: ' + fileName + ':', error.message);
    return null;
  }
}

function generateChecksumFile(files, platform) {
  const checksumFile = path.join(RELEASE_DIR, 'SHA256SUMS-' + platform + '.txt');
  const checksums = [];

  console.log('\nGenerating SHA256 checksums for ' + platform + '...');

  for (const file of files) {
    const filePath = path.join(RELEASE_DIR, file);
    const checksum = generateChecksum(filePath);
    checksums.push(checksum + '  ' + file);
    console.log('   ' + file);
    console.log('   → ' + checksum);
  }

  fs.writeFileSync(checksumFile, checksums.join('\n') + '\n');
  console.log('\n✓ Checksums written to: SHA256SUMS-' + platform + '.txt');

  return checksumFile;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGithubError(error) {
  if (!error) return false;

  const retryableStatusCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  const retryableCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EPIPE',
  ]);

  if (typeof error.statusCode === 'number' && retryableStatusCodes.has(error.statusCode)) {
    return true;
  }

  if (typeof error.code === 'string' && retryableCodes.has(error.code)) {
    return true;
  }

  const msg = String(error.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('socket hang up') || msg.includes('aborted');
}

function githubRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

async function githubRequestWithRetry(method, endpoint, body) {
  const attempts = Math.max(1, GH_REQUEST_RETRIES);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await githubRequest(method, endpoint, body);
    } catch (error) {
      const canRetry = attempt < attempts && isRetryableGithubError(error);
      if (!canRetry) {
        throw error;
      }

      const backoffMs = GH_REQUEST_RETRY_DELAY_MS * attempt;
      console.log(
        '   Retry ' +
          attempt +
          '/' +
          (attempts - 1) +
          ' in ' +
          backoffMs +
          'ms (' +
          error.message +
          ')'
      );
      await sleep(backoffMs);
    }
  }
}

async function getOrCreateRelease() {
  console.log('\nLooking for release: ' + TAG_NAME);
  const commit = currentReleaseCommit();

  const findExisting = async () => {
    try {
      return await githubRequestWithRetry(
        'GET',
        '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/tags/' + TAG_NAME
      );
    } catch (error) {
      if (error && error.statusCode !== 404) throw error;
    }

    const releases = await listAllGithubPages((page, perPage) =>
      githubRequestWithRetry(
        'GET',
        '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases?per_page=' + perPage + '&page=' + page
      )
    );
    assertNoMisnamedVersionDrafts(releases, TAG_NAME, VERSION);
    // Duplicate drafts are a known GitHub failure; match ensure-draft-release.
    const drafts = releases.filter(
      (release) => release && release.draft && isExpectedRelease(release, TAG_NAME, VERSION)
    );
    if (drafts.length > 1) {
      throw new Error(
        'Multiple draft releases exist for ' + TAG_NAME + '. Resolve duplicates before signing.'
      );
    }
    return drafts[0] || null;
  };

  const existing = await findExisting();
  if (existing) {
    const validated = assertExpectedRelease(existing, TAG_NAME, VERSION, 'Signing release');
    if (validated.draft) {
      console.log(
        '   Found draft release: ' +
          (validated.name || TAG_NAME) +
          ' (' +
          (validated.assets ? validated.assets.length : 0) +
          ' assets)'
      );
      return assertReleaseTargetsCommit(validated, commit);
    }
    console.log('   Found published release: ' + (validated.name || TAG_NAME));
    return validated;
  }

  throw new Error(
    'No GitHub release exists for ' +
      TAG_NAME +
      '. Create the draft with npm run release:draft on Windows first; Mac/Linux wait for that draft.'
  );
}

async function uploadSignatures(release, filesToUpload) {
  if (!release || !release.upload_url) {
    throw new Error('No release found for tag ' + TAG_NAME + ', cannot upload signatures');
  }
  if (!release.draft && !isExplicitTruthy(process.env.ALLOW_ASSET_REPLACE)) {
    throw new Error(
      'Refusing to upload assets to published release ' +
        TAG_NAME +
        '. Set ALLOW_ASSET_REPLACE=true to override.'
    );
  }

  console.log('\nUploading to GitHub release...');
  const uploadFailures = [];

  for (const filePath of filesToUpload) {
    if (!filePath) continue;

    const fileName = path.basename(filePath);
    process.stdout.write('   Uploading: ' + fileName + '... ');

    try {
      // Upload against the release upload URL so untagged placeholder drafts
      // work the same as tagged ones; the tag alone cannot address them.
      uploadReleaseAsset(release.upload_url, filePath);
      console.log('✓');
    } catch (error) {
      console.log('✗ ' + error.message);
      uploadFailures.push(fileName + ': ' + error.message);
    }
  }

  if (uploadFailures.length > 0) {
    throw new Error(
      'One or more uploads failed:\n' + uploadFailures.map((item) => '  - ' + item).join('\n')
    );
  }
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  const platform = getPlatformName(TARGET_ARCH);
  let uploadFailed = false;

  console.log('═'.repeat(60));
  assertGitHubCliAuthenticated();
  console.log('GPG Sign & Upload - CONV2 ' + VERSION);
  console.log('Platform: ' + platform);
  if (TARGET_ARCH) {
    console.log('Target Arch: ' + TARGET_ARCH + ' (filtering files)');
  }
  console.log('═'.repeat(60));

  try {
    execSync('gpg --version', { stdio: 'pipe' });
  } catch (e) {
    console.error('\n✗ ERROR: GPG not found!');
    console.error('   Install with:');
    console.error('   - macOS:   brew install gnupg');
    console.error('   - Windows: https://gpg4win.org/');
    console.error('   - Linux:   sudo apt install gnupg');
    process.exit(1);
  }

  if (!GPG_KEY_ID) {
    console.warn('\n⚠ WARN: GPG_KEY_ID not set - will use default key');
  } else {
    console.log('\nGPG Key: ' + GPG_KEY_ID);
  }

  const files = getFilesToSign();

  if (files.length === 0) {
    console.log('\n✗ ERROR: No release artifacts found to sign.');
    console.log('   Run a build command first, e.g.: npm run release:win');
    process.exit(1);
  }

  console.log('\nFound ' + files.length + ' artifacts to sign:');
  files.forEach((f) => console.log('   • ' + f));

  const checksumFile = generateChecksumFile(files, platform);
  console.log('\nSigning artifacts...\n');

  const signatureFiles = [];

  for (const file of files) {
    const filePath = path.join(RELEASE_DIR, file);
    const sigFile = signFile(filePath);
    if (sigFile) signatureFiles.push(sigFile);
  }

  const checksumSig = signFile(checksumFile);
  if (checksumSig) signatureFiles.push(checksumSig);

  const expectedSignatureCount = files.length + 1;
  if (signatureFiles.length !== expectedSignatureCount) {
    throw new Error(
      `Signing failed for one or more artifacts. Expected ${expectedSignatureCount} signatures, generated ${signatureFiles.length}.`
    );
  }

  const releaseEntries = fs
    .readdirSync(RELEASE_DIR)
    .filter((name) => fs.statSync(path.join(RELEASE_DIR, name)).isFile());
  const filesToUpload = getReleaseUploadFiles(releaseEntries, RELEASE_DIR);

  console.log('\nFiles queued for upload:');
  filesToUpload.forEach((f) => console.log('   • ' + path.basename(f)));

  try {
    const release = await getOrCreateRelease();
    await uploadSignatures(release, filesToUpload);
  } catch (error) {
    console.error('\n✗ ERROR: GitHub upload failed:', error.message);
    uploadFailed = true;
  }

  console.log('\n' + '═'.repeat(60));
  console.log('✓ COMPLETE');
  console.log('═'.repeat(60));
  console.log('\nGenerated files in release/:');

  const generatedFiles = fs
    .readdirSync(RELEASE_DIR)
    .filter((f) => f.endsWith('.asc') || f.startsWith('SHA256SUMS'));
  generatedFiles.forEach((f) => console.log('   • ' + f));

  if (uploadFailed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = {
  assertReleaseTargetsCommit,
  currentReleaseCommit,
  getOrCreateRelease,
  listAllGithubPages,
};
