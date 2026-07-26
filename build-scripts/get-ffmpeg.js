// @ts-check
'use strict';

/**
 * get-ffmpeg.js
 *
 * Downloads ffmpeg/ffprobe binaries from the internal server defined by
 * FFMPEG_DL_SERVER in .env, extracts them to a staging directory, verifies them
 * against resources/ffmpeg/checksums.json, and only then installs them into
 * resources/ffmpeg/. A failed verification leaves the existing binaries intact.
 *
 * Usage:
 *   node build-scripts/get-ffmpeg.js               # current OS (x64 and arm64)
 *   node build-scripts/get-ffmpeg.js --all          # all 6 platform/arch combos
 *   node build-scripts/get-ffmpeg.js --target mac:arm64 --target win:x64
 *   node build-scripts/get-ffmpeg.js --all --allow-unverified   # new FFmpeg version
 *
 * Requires: 7z or 7zz installed and on PATH
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { REQUIRED_BINARIES, computeSha256, getExpectedChecksums } = require('./check-ffmpeg.js');

/** Set by --allow-unverified: permits installing a payload with no recorded hashes. */
let allowUnverified = false;

// Load .env (FFMPEG_DL_SERVER lives here)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const projectRoot = path.resolve(__dirname, '..');

// ─── Platform / arch maps ────────────────────────────────────────────────────

/** Maps process.platform / user-facing aliases → internal dir name
 * @type {Record<string, string>}
 */
const PLATFORM_DIR = {
  win32: 'win',
  darwin: 'mac',
  linux: 'linux',
  win: 'win',
  mac: 'mac',
};

/** Maps internal dir name → server filename segment
 * @type {Record<string, string>}
 */
const PLATFORM_URL_SEGMENT = {
  win: 'win',
  mac: 'macOS',
  linux: 'linux',
};

/** @type {Record<string, string>} */
const ARCH_ALIASES = {
  x64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
};

/** All supported targets */
const ALL_TARGETS = [
  { platform: 'win', arch: 'x64' },
  { platform: 'win', arch: 'arm64' },
  { platform: 'mac', arch: 'x64' },
  { platform: 'mac', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {string} value
 */
function normalizePlatform(value) {
  return PLATFORM_DIR[value] || null;
}

/**
 * @param {string} value
 */
function normalizeArch(value) {
  return ARCH_ALIASES[value] || null;
}

function usage() {
  console.error(
    'Usage: node build-scripts/get-ffmpeg.js [--all] [--target <platform:arch>]... [--allow-unverified]\n' +
      '  Platforms: win, mac, linux\n' +
      '  Architectures: x64, arm64\n' +
      '  Default: current OS (x64 and arm64)\n' +
      '\n' +
      '  Downloads are extracted to a staging dir and verified against\n' +
      '  resources/ffmpeg/checksums.json before being installed.\n' +
      '  --allow-unverified permits a payload with no recorded hashes (new versions).\n' +
      '\n' +
      '  Requires FFMPEG_DL_SERVER to be set in .env'
  );
  process.exit(1);
}

/**
 * @param {string[]} args
 */
function parseArgs(args) {
  let explicitAll = false;
  const targets = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      explicitAll = true;
      continue;
    }
    if (arg === '--allow-unverified') {
      allowUnverified = true;
      continue;
    }
    if (arg === '--target') {
      const value = args[i + 1];
      if (!value) usage();
      const parts = value.split(':');
      if (parts.length !== 2) {
        console.error(`Invalid target format "${value}". Expected <platform:arch>, e.g. mac:arm64`);
        process.exit(1);
      }
      const platform = normalizePlatform(parts[0]);
      const arch = normalizeArch(parts[1]);
      if (!platform || !arch) {
        console.error(
          `Invalid target "${value}". Valid platforms: win, mac, linux. Valid arches: x64, arm64.`
        );
        process.exit(1);
      }
      targets.push({ platform, arch });
      i++;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if (explicitAll) {
    return ALL_TARGETS;
  }

  if (targets.length > 0) {
    // Deduplicate
    const seen = new Set();
    return targets.filter(({ platform, arch }) => {
      const key = `${platform}:${arch}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Default: current OS, both x64 and arm64 architectures
  const platform = normalizePlatform(process.platform);
  if (!platform) {
    console.error(`Unsupported current platform: ${process.platform}`);
    process.exit(1);
  }
  return [
    { platform, arch: 'x64' },
    { platform, arch: 'arm64' },
  ];
}

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Download an HTTPS URL to a local file path, following safe redirects.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      fs.rm(destPath, { force: true }, () => reject(error));
    };

    /** @param {string} requestUrl @param {number} redirectCount */
    function doRequest(requestUrl, redirectCount) {
      let parsed;
      try {
        parsed = new URL(requestUrl);
      } catch {
        fail(new Error(`Invalid download URL: ${requestUrl}`));
        return;
      }

      if (parsed.protocol !== 'https:') {
        fail(new Error(`Refusing non-HTTPS FFmpeg download URL: ${parsed.href}`));
        return;
      }
      if (redirectCount > MAX_REDIRECTS) {
        fail(new Error(`Too many redirects while downloading ${url}`));
        return;
      }

      const request = https.get(parsed, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          res.resume();
          if (!location) {
            fail(new Error(`Redirect with no Location header from ${parsed.href}`));
            return;
          }
          doRequest(new URL(location, parsed).href, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`HTTP ${res.statusCode} for ${parsed.href}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        let receivedBytes = 0;
        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let lastLoggedPercent = -1;

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.floor((receivedBytes / totalBytes) * 100);
            if (pct !== lastLoggedPercent && pct % 10 === 0) {
              process.stdout.write(`  ${pct}%\r`);
              lastLoggedPercent = pct;
            }
          }
        });
        res.on('error', fail);
        file.on('error', fail);
        file.on('finish', () => {
          file.close(() => {
            if (settled) return;
            if (receivedBytes === 0) {
              fail(new Error(`Empty download response from ${parsed.href}`));
              return;
            }
            settled = true;
            resolve();
          });
        });
        res.pipe(file);
      });

      request.on('timeout', () =>
        request.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`))
      );
      request.on('error', fail);
    }

    doRequest(url, 0);
  });
}

/** Find the 7z executable: prefer 7zz (standalone), fall back to 7z. */
function find7z() {
  for (const bin of ['7zz', '7z']) {
    try {
      execFileSync(bin, ['i'], { stdio: 'ignore' });
      return bin;
    } catch {
      // not found or errored — try next
    }
  }
  return null;
}

/** Extract a .7z archive into a destination directory.
 * @param {string} sevenZipBin
 * @param {string} archivePath
 * @param {string} destDir
 */
function extract7z(sevenZipBin, archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(sevenZipBin, ['x', archivePath, `-o${destDir}`, '-y'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ─── Verification / installation ─────────────────────────────────────────────

/** Tracked files that live in the destination dirs and must survive a refresh. */
const PRESERVED_DEST_FILES = new Set(['PLACE_BINARIES_HERE.txt']);

/** Locate an extracted binary by name, tolerating a nested archive root.
 * @param {string} rootDir
 * @param {string} fileName
 * @param {number} [maxDepth]
 * @returns {string | null}
 */
function findExtractedFile(rootDir, fileName, maxDepth = 3) {
  /** @type {Array<{dir: string, depth: number}>} */
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { dir, depth } = next;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** Verify staged binaries against the tracked checksum manifest.
 *
 * Runs before anything is written to the directory the build consumes, so an
 * unverified or tampered payload never becomes the bundled FFmpeg.
 *
 * @param {string} stagingDir
 * @param {string} platform
 * @param {string} arch
 * @param {{ allowUnverified?: boolean }} options
 * @returns {Record<string, string>} staged binary paths keyed by binary name
 */
function verifyStagedBinaries(stagingDir, platform, arch, options = {}) {
  const allowUnverified = options.allowUnverified === true;
  const required = REQUIRED_BINARIES[platform]?.[arch];
  if (!required) {
    throw new Error(`No known binary layout for ${platform}:${arch}`);
  }

  /** @type {Record<string, string>} */
  const staged = {};
  for (const [binaryName, relativePath] of Object.entries(required)) {
    const fileName = path.basename(relativePath);
    const stagedPath = findExtractedFile(stagingDir, fileName);
    if (!stagedPath) {
      throw new Error(`Archive did not contain the expected binary: ${fileName}`);
    }
    staged[binaryName] = stagedPath;
  }

  const expected = getExpectedChecksums(platform, arch);
  if (!expected) {
    if (!allowUnverified) {
      throw new Error(
        `No checksum manifest entry for ${platform}:${arch}.\n` +
          `  Re-run with --allow-unverified only after independently verifying the download,\n` +
          `  then record the new hashes with: npm run ffmpeg:checksums:generate`
      );
    }
    console.warn(`  ! No recorded checksums for ${platform}:${arch} — payload NOT verified.`);
    return staged;
  }

  for (const [binaryName, stagedPath] of Object.entries(staged)) {
    const expectedHash = expected[binaryName];
    if (!expectedHash) {
      if (!allowUnverified) {
        throw new Error(
          `No recorded SHA-256 for ${binaryName} on ${platform}:${arch}. ` +
            `Re-run with --allow-unverified only after independent verification.`
        );
      }
      console.warn(`  ! No recorded checksum for ${binaryName} — NOT verified.`);
      continue;
    }
    const actual = computeSha256(stagedPath);
    if (actual !== expectedHash) {
      throw new Error(
        `SHA-256 mismatch for ${binaryName} (${platform}:${arch})\n` +
          `  expected: ${expectedHash}\n` +
          `  actual:   ${actual}`
      );
    }
  }
  console.log(`  ✓ Checksums verified against resources/ffmpeg/checksums.json`);
  return staged;
}

/** Replace the destination contents with the verified payload, preserving tracked files.
 *
 * The whole payload directory is installed, not just ffmpeg/ffprobe, so a future
 * archive that ships sidecar files (shared libraries, presets) is not silently
 * truncated. Only the two binaries are checksum-verified, which is what the
 * manifest records.
 *
 * @param {Record<string, string>} stagedBinaries
 * @param {string} destDir
 * @param {string} platform
 */
function installVerifiedBinaries(stagedBinaries, destDir, platform) {
  const binaryPaths = Object.values(stagedBinaries);
  if (binaryPaths.length === 0) {
    throw new Error('No verified binaries to install');
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(destDir)) {
    if (PRESERVED_DEST_FILES.has(entry)) continue;
    fs.rmSync(path.join(destDir, entry), { recursive: true, force: true });
  }

  const payloadRoots = new Set(binaryPaths.map((binaryPath) => path.dirname(binaryPath)));
  if (payloadRoots.size === 1) {
    const [payloadRoot] = [...payloadRoots];
    fs.cpSync(payloadRoot, destDir, { recursive: true, force: true });
  } else {
    // Binaries came from different subdirectories; install them individually.
    for (const binaryPath of binaryPaths) {
      fs.copyFileSync(binaryPath, path.join(destDir, path.basename(binaryPath)));
    }
  }

  if (platform !== 'win') {
    for (const binaryPath of binaryPaths) {
      const target = path.join(destDir, path.basename(binaryPath));
      if (fs.existsSync(target)) {
        fs.chmodSync(target, 0o755);
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Validate FFMPEG_DL_SERVER
  const serverBase = process.env.FFMPEG_DL_SERVER;
  if (!serverBase) {
    console.error('\nError: FFMPEG_DL_SERVER is not set.');
    console.error('Add it to your .env file:');
    console.error('  FFMPEG_DL_SERVER=https://your-server.example/ffmpeg/latest/');
    process.exit(1);
  }
  let parsedServerBase;
  try {
    parsedServerBase = new URL(serverBase);
  } catch {
    console.error(`\nError: FFMPEG_DL_SERVER is not a valid URL: ${serverBase}`);
    process.exit(1);
  }
  if (parsedServerBase.protocol !== 'https:') {
    console.error('\nError: FFMPEG_DL_SERVER must use HTTPS.');
    process.exit(1);
  }
  const base = serverBase.replace(/\/$/, ''); // strip trailing slash

  // Validate 7z
  const sevenZipBin = find7z();
  if (!sevenZipBin) {
    console.error('\nError: 7z (or 7zz) not found on PATH.');
    console.error('Install it first:');
    console.error('  macOS:  brew install sevenzip');
    console.error('  Linux:  sudo apt install p7zip-full');
    console.error('  Win:    winget install 7zip.7zip');
    process.exit(1);
  }

  const targets = parseArgs(process.argv.slice(2));

  console.log(
    `\nDownloading ffmpeg binaries for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(', ')}`
  );
  console.log(`Server: ${base}\n`);

  for (const { platform, arch } of targets) {
    const urlSegment = PLATFORM_URL_SEGMENT[platform];
    const filename = `ffmpeg_${urlSegment}_${arch}.7z`;
    const url = `${base}/${filename}`;
    const tmpFile = path.join(projectRoot, filename);
    const destDir = path.join(projectRoot, 'resources', 'ffmpeg', platform, arch);
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `conv2-ffmpeg-${platform}-${arch}-`));

    const cleanup = () => {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        /* best-effort */
      }
    };

    console.log(`[${platform}:${arch}] Downloading ${filename} ...`);
    try {
      await download(url, tmpFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[${platform}:${arch}] Download failed: ${msg}`);
      cleanup();
      process.exit(1);
    }
    console.log(`[${platform}:${arch}] Download complete.`);

    // Extract into a staging dir first: nothing reaches resources/ffmpeg until
    // the payload has been checked against the tracked checksum manifest.
    console.log(`[${platform}:${arch}] Extracting to staging ...`);
    try {
      extract7z(sevenZipBin, tmpFile, stagingDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[${platform}:${arch}] Extraction failed: ${msg}`);
      cleanup();
      process.exit(1);
    }

    console.log(`[${platform}:${arch}] Verifying payload ...`);
    let stagedBinaries;
    try {
      stagedBinaries = verifyStagedBinaries(stagingDir, platform, arch, { allowUnverified });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[${platform}:${arch}] Verification failed: ${msg}`);
      console.error(`[${platform}:${arch}] resources/ffmpeg/${platform}/${arch}/ left untouched.`);
      cleanup();
      process.exit(1);
    }

    console.log(`[${platform}:${arch}] Installing to resources/ffmpeg/${platform}/${arch}/ ...`);
    try {
      installVerifiedBinaries(stagedBinaries, destDir, platform);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[${platform}:${arch}] Install failed: ${msg}`);
      cleanup();
      process.exit(1);
    }

    cleanup();
    console.log(`[${platform}:${arch}] Done.\n`);
  }

  console.log(
    `✓ ffmpeg binaries ready for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(', ')}`
  );
  console.log(`  Run 'npm run ffmpeg:check' to verify.\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nUnexpected error:', err);
    process.exit(1);
  });
}

module.exports = {
  PRESERVED_DEST_FILES,
  findExtractedFile,
  installVerifiedBinaries,
  verifyStagedBinaries,
};
