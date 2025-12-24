#!/usr/bin/env node
require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELEASE_DIR = path.join(__dirname, '..', 'release');
const SIGNABLE_EXTENSIONS = ['.dmg', '.zip', '.exe', '.msi', '.appimage', '.deb', '.rpm', '.flatpak'];

const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const GH_TOKEN = process.env.GH_TOKEN;

function detectPlatform() {
  const files = fs.readdirSync(RELEASE_DIR);
  if (files.some(f => f.endsWith('.dmg') || f.endsWith('.pkg'))) return 'macOS';
  if (files.some(f => f.endsWith('.exe') || f.endsWith('.msi'))) return 'Windows';
  if (files.some(f => f.endsWith('.AppImage') || f.endsWith('.deb') || f.endsWith('.rpm'))) return 'Linux';
  return 'Unknown';
}

function checkGpg() {
  try {
    execSync('gpg --version', { stdio: 'pipe' });
    return true;
  } catch {
    console.error('ERROR: GPG is not installed or not in PATH');
    return false;
  }
}

function getFilesToSign() {
  if (!fs.existsSync(RELEASE_DIR)) {
    console.error(`ERROR: Release directory not found: ${RELEASE_DIR}`);
    return [];
  }

  return fs.readdirSync(RELEASE_DIR)
    .filter(file => {
      const ext = path.extname(file).toLowerCase();
      return SIGNABLE_EXTENSIONS.includes(ext);
    })
    .map(file => path.join(RELEASE_DIR, file));
}

function calculateSha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

function signFile(filePath) {
  const signaturePath = `${filePath}.asc`;
  const fileName = path.basename(filePath);

  console.log(`Signing: ${fileName}`);

  try {
    let gpgCommand = 'gpg --batch --yes --armor --detach-sign';

    if (GPG_KEY_ID) {
      gpgCommand += ` --local-user "${GPG_KEY_ID}"`;
    }

    if (GPG_PASSPHRASE) {
      gpgCommand += ` --pinentry-mode loopback --passphrase "${GPG_PASSPHRASE}"`;
    }

    gpgCommand += ` --output "${signaturePath}" "${filePath}"`;

    execSync(gpgCommand, { stdio: 'pipe' });
    console.log(`  Created: ${path.basename(signaturePath)}`);
    return signaturePath;
  } catch (error) {
    console.error(`  ERROR signing ${fileName}: ${error.message}`);
    return null;
  }
}

function generateChecksums(files, platform) {
  const checksumFile = path.join(RELEASE_DIR, `SHA256SUMS-${platform}.txt`);
  const lines = [];

  for (const file of files) {
    const hash = calculateSha256(file);
    const fileName = path.basename(file);
    lines.push(`${hash}  ${fileName}`);
    console.log(`Checksum: ${fileName}`);
  }

  fs.writeFileSync(checksumFile, lines.join('\n') + '\n');
  console.log(`Created: SHA256SUMS-${platform}.txt`);

  return checksumFile;
}

function getVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return packageJson.version;
}

async function uploadToGitHub(filePath) {
  if (!GH_TOKEN) {
    console.log('  Skipping GitHub upload (GH_TOKEN not set)');
    return false;
  }

  const fileName = path.basename(filePath);
  const version = getVersion();
  const tag = `v${version}`;
  const isPrerelease = version.includes('beta') || version.includes('alpha');

  try {
    let releaseId;

    try {
      const releaseResult = execSync(
        `gh release view ${tag} --json id -q .id`,
        { stdio: 'pipe', encoding: 'utf8' }
      ).trim();
      releaseId = releaseResult;
    } catch {
      console.log(`  Creating release ${tag}...`);
      const prereleaseFlag = isPrerelease ? '--prerelease' : '';
      execSync(
        `gh release create ${tag} --title "CONV2 ${tag}" --draft ${prereleaseFlag}`,
        { stdio: 'pipe' }
      );
    }

    console.log(`  Uploading: ${fileName}`);
    execSync(
      `gh release upload ${tag} "${filePath}" --clobber`,
      { stdio: 'pipe' }
    );

    return true;
  } catch (error) {
    console.error(`  ERROR uploading ${fileName}: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('\n=== CONV2 GPG Signing ===\n');

  if (!checkGpg()) {
    process.exit(1);
  }

  if (!GPG_PASSPHRASE) {
    console.warn('WARNING: GPG_PASSPHRASE not set. Interactive signing may be required.\n');
  }

  const files = getFilesToSign();

  if (files.length === 0) {
    console.log('No files to sign in release directory.');
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s) to sign:\n`);

  const platform = detectPlatform();
  console.log(`Platform: ${platform}\n`);

  console.log('--- Generating Checksums ---\n');
  const checksumFile = generateChecksums(files, platform);

  console.log('\n--- Signing Files ---\n');
  const signatures = [];

  for (const file of files) {
    const sig = signFile(file);
    if (sig) signatures.push(sig);
  }

  const checksumSig = signFile(checksumFile);
  if (checksumSig) signatures.push(checksumSig);

  if (GH_TOKEN) {
    console.log('\n--- Uploading to GitHub ---\n');

    await uploadToGitHub(checksumFile);

    for (const sig of signatures) {
      await uploadToGitHub(sig);
    }
  } else {
    console.log('\nSkipping GitHub upload (GH_TOKEN not configured)');
  }

  console.log('\n=== Signing Complete ===\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
