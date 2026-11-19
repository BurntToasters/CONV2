// Verifies the FFmpeg/ffprobe payload inside Tauri bundles under
// src-tauri/target: the macOS CONV2.app, Windows NSIS installers (extracted
// with 7zz) and Linux AppImages (extracted with --appimage-extract).
// Usage: node scripts/verify-packaged-ffmpeg.cjs [bundle-root=src-tauri/target] [--require]
// Writes coverage/e2e/packaged-ffmpeg-verify.json. Exit 0 when verified or skipped.
// Failure modes:
//  1. A shipped sidecar fails the bundled checksum or codesign check (swapped or re-signed).
//  2. A bundle is built without one of its conv2-ffmpeg/conv2-ffprobe sidecars
//     or without the bundled checksum manifest.
//  3. No bundle or no payload is found: skip (exit 0), or fail with --require
//     or REQUIRE_FFMPEG_PAYLOAD=1.
//  4. The host-matching sidecar fails `-version`; only verified binaries are ever executed.
//  5. A universal macOS app must match the manifest per arch slice, and every
//     sidecar must be signed by the app's Team ID.
//  6. Signing rewrites bytes, so the raw hash no longer matches: a signed NSIS
//     sidecar matches by its Authenticode-stripped hash (mirrors
//     ffmpeg_status.rs); a macOS sidecar signed by the app's Team ID is
//     verified by codesign instead of by hash.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SIDE_CARS = ["ffmpeg", "ffprobe"];
const args = process.argv.slice(2);
const requireMode =
  args.includes("--require") || process.env.REQUIRE_FFMPEG_PAYLOAD === "1";
const bundleRoot = path.resolve(
  ROOT,
  args.find((arg) => !arg.startsWith("--")) || path.join("src-tauri", "target"),
);
const outFile = path.join(
  ROOT,
  "coverage",
  "e2e",
  "packaged-ffmpeg-verify.json",
);

const relative = (target) => {
  const rel = path.relative(ROOT, target);
  return rel === "" ? "." : rel.startsWith("..") ? target : rel;
};

// ─── Checksum manifest (shipped inside every bundle) ───────────────────────

function readManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unreadable checksum manifest ${relative(manifestPath)}: ${error.message}`,
    );
  }
}

function expectedChecksum(manifest, targetKey, binaryName) {
  return manifest?.[targetKey]?.binaries?.[binaryName]?.sha256 ?? null;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// ─── Mach-O fat (universal) slices ──────────────────────────────────────────
// A universal sidecar's raw bytes match neither single-arch manifest entry, so
// hash the per-arch slice and compare it with that arch's manifest entry.

const MACH_FAT_MAGIC = 0xcafebabe;
const MACH_FAT64_MAGIC = 0xcafebabf;
const MACH_CPU_TYPE_BY_ARCH = { x64: 0x01000007, arm64: 0x0100000c };

async function findMacFatSlice(filePath, arch) {
  const cpuType = MACH_CPU_TYPE_BY_ARCH[arch];
  if (cpuType === undefined) return null;
  const handle = await fs.promises.open(filePath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const head = Buffer.alloc(8);
    if ((await handle.read(head, 0, head.length, 0)).bytesRead < head.length)
      return null;
    const magic = head.readUInt32BE(0);
    if (magic !== MACH_FAT_MAGIC && magic !== MACH_FAT64_MAGIC) return null;
    const is64 = magic === MACH_FAT64_MAGIC;
    const entryBytes = is64 ? 32 : 20;
    const count = head.readUInt32BE(4);
    if (count === 0 || count > 16) return null;
    const table = Buffer.alloc(count * entryBytes);
    if ((await handle.read(table, 0, table.length, 8)).bytesRead < table.length)
      return null;
    for (let at = 0; at < table.length; at += entryBytes) {
      if (table.readUInt32BE(at) !== cpuType) continue;
      const offset = is64
        ? Number(table.readBigUInt64BE(at + 8))
        : table.readUInt32BE(at + 8);
      const size = is64
        ? Number(table.readBigUInt64BE(at + 16))
        : table.readUInt32BE(at + 12);
      return size > 0 && offset + size <= fileSize ? { offset, size } : null;
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function sha256Range(filePath, start, length) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath, { start, end: start + length - 1 })
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// ─── Authenticode-stripped PE hash (signed Windows sidecars) ───────────────
// Port of authenticode_stripped_sha256_candidates in ffmpeg_status.rs: hash the
// PE with the certificate table removed, its Security directory entry zeroed
// and CheckSum recomputed (or zeroed), for each zero-padding length that
// signtool may have added before the table. Unsigned, malformed or
// appended-data files yield no candidates, so the raw hash alone decides.

const PE_HEADER_READ_BYTES = 4096;
const PE_SECURITY_DIRECTORY_INDEX = 4;
const PE_DIRECTORY_ENTRY_BYTES = 8;
const PE_PAD_MAX_BYTES = 7;

function peDataDirectoriesOffset(magic) {
  if (magic === 0x10b) return 96;
  if (magic === 0x20b) return 112;
  return null;
}

function readAuthenticodeLayout(head, fileSize) {
  if (head.length < 0x40 || head.readUInt16LE(0) !== 0x5a4d) return null;
  const peAt = head.readUInt32LE(0x3c);
  if (peAt + 24 > head.length || head.readUInt32LE(peAt) !== 0x00004550)
    return null;
  const optionalAt = peAt + 24;
  if (optionalAt + 2 > head.length) return null;
  const dirsOffset = peDataDirectoriesOffset(head.readUInt16LE(optionalAt));
  if (dirsOffset === null) return null;
  const dataDirsAt = optionalAt + dirsOffset;
  const securityEntryAt =
    dataDirsAt + PE_SECURITY_DIRECTORY_INDEX * PE_DIRECTORY_ENTRY_BYTES;
  const checksumAt = optionalAt + 64;
  if (
    securityEntryAt + PE_DIRECTORY_ENTRY_BYTES > head.length ||
    checksumAt + 4 > head.length
  )
    return null;
  if (head.readUInt32LE(dataDirsAt - 4) <= PE_SECURITY_DIRECTORY_INDEX)
    return null;
  const certOffset = head.readUInt32LE(securityEntryAt);
  const certSize = head.readUInt32LE(securityEntryAt + 4);
  const headerEnd = head.readUInt32LE(optionalAt + 60);
  const patchEnd = Math.max(
    checksumAt + 4,
    securityEntryAt + PE_DIRECTORY_ENTRY_BYTES,
  );
  if (certOffset === 0 || certSize === 0) return null;
  if (certOffset <= headerEnd || certOffset < patchEnd) return null;
  if (certOffset + certSize !== fileSize) return null;
  return { certOffset, checksumAt, securityEntryAt, patchEnd };
}

function patchedPeHeader(head, layout, checksum) {
  const patched = Buffer.from(head.subarray(0, layout.patchEnd));
  patched.fill(
    0,
    layout.securityEntryAt,
    layout.securityEntryAt + PE_DIRECTORY_ENTRY_BYTES,
  );
  patched.writeUInt32LE(checksum >>> 0, layout.checksumAt);
  return patched;
}

const foldPeSum = (value) => (value & 0xffff) + (value >>> 16);

/** PE checksum word sum; a trailing odd byte counts as its low byte. */
class PeWordSum {
  constructor() {
    this.sum = 0;
    this.pendingLow = null;
  }

  add(chunk) {
    let index = 0;
    if (this.pendingLow !== null && chunk.length > 0) {
      this.sum = foldPeSum(
        (this.sum + (this.pendingLow | (chunk[0] << 8))) >>> 0,
      );
      this.pendingLow = null;
      index = 1;
    }
    while (index + 1 < chunk.length) {
      this.sum = foldPeSum(
        (this.sum + (chunk[index] | (chunk[index + 1] << 8))) >>> 0,
      );
      index += 2;
    }
    if (index < chunk.length) this.pendingLow = chunk[index];
  }

  folded() {
    if (this.pendingLow === null) return foldPeSum(this.sum);
    return foldPeSum(foldPeSum((this.sum + this.pendingLow) >>> 0));
  }
}

async function readAt(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(
      buffer,
      done,
      length - done,
      offset + done,
    );
    if (bytesRead === 0) throw new Error("short read while hashing PE file");
    done += bytesRead;
  }
  return buffer;
}

async function streamRange(handle, start, end, onChunk) {
  const chunk = Buffer.alloc(1 << 20);
  for (let position = start; position < end;) {
    const want = Math.min(chunk.length, end - position);
    const { bytesRead } = await handle.read(chunk, 0, want, position);
    if (bytesRead === 0) throw new Error("short read while streaming PE body");
    onChunk(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function authenticodeStrippedSha256Candidates(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const head = await readAt(handle, 0, Math.min(size, PE_HEADER_READ_BYTES));
    const layout = readAuthenticodeLayout(head, size);
    if (!layout) return [];
    const tailStart = Math.max(
      layout.patchEnd,
      layout.certOffset - PE_PAD_MAX_BYTES,
    );
    const tail = await readAt(handle, tailStart, layout.certOffset - tailStart);

    // Pass 1: PE checksum over the stripped content, zero-padded to certOffset.
    const wordSum = new PeWordSum();
    wordSum.add(patchedPeHeader(head, layout, 0));
    await streamRange(handle, layout.patchEnd, tailStart, (chunk) =>
      wordSum.add(chunk),
    );
    wordSum.add(tail);
    const folded = wordSum.folded();

    // A padding length is a candidate only when its bytes are zero; zero bytes
    // add nothing to the word sum, so that length's checksum is folded + length.
    const contents = [];
    for (let pad = 0; pad <= tail.length; pad += 1) {
      if (tail.subarray(tail.length - pad).every((byte) => byte === 0)) {
        const length = layout.certOffset - pad;
        contents.push([length, 0]);
        contents.push([length, (folded + length) >>> 0]);
      }
    }

    // Pass 2: one header-plus-body hash per distinct CheckSum value.
    const bases = new Map();
    for (const [, checksum] of contents) {
      if (!bases.has(checksum)) {
        bases.set(
          checksum,
          crypto
            .createHash("sha256")
            .update(patchedPeHeader(head, layout, checksum)),
        );
      }
    }
    await streamRange(handle, layout.patchEnd, tailStart, (chunk) => {
      for (const hash of bases.values()) hash.update(chunk);
    });
    const seen = new Set();
    for (const [length, checksum] of contents) {
      const hash = bases.get(checksum).copy();
      hash.update(tail.subarray(0, length - tailStart));
      seen.add(hash.digest("hex"));
    }
    return [...seen].sort();
  } finally {
    await handle.close();
  }
}

// ─── macOS codesign ────────────────────────────────────────────────────────

function runCapture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function readTeamIdentifier(targetPath) {
  const details = runCapture("codesign", [
    "--display",
    "--verbose=4",
    targetPath,
  ]);
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!team || team === "not set") {
    throw new Error(`${relative(targetPath)} signature has no TeamIdentifier.`);
  }
  return team;
}

function verifyMacCodeSignature(appPath, sidecars) {
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    {
      stdio: "ignore",
    },
  );
  const hostTeam = readTeamIdentifier(appPath);
  for (const sidecar of sidecars) {
    const sidecarTeam = readTeamIdentifier(sidecar);
    if (sidecarTeam !== hostTeam) {
      throw new Error(
        `${path.basename(sidecar)} TeamIdentifier ${sidecarTeam} does not match the app's ${hostTeam}.`,
      );
    }
  }
  return hostTeam;
}

// ─── Bundle discovery ──────────────────────────────────────────────────────

function targetKeyFor(triple) {
  if (triple === "universal-apple-darwin")
    return { platform: "darwin", arches: ["x64", "arm64"] };
  if (triple === "x86_64-apple-darwin")
    return { platform: "darwin", arches: ["x64"] };
  if (triple === "aarch64-apple-darwin")
    return { platform: "darwin", arches: ["arm64"] };
  if (triple === "x86_64-pc-windows-msvc")
    return { platform: "win32", arches: ["x64"] };
  if (triple === "aarch64-pc-windows-msvc")
    return { platform: "win32", arches: ["arm64"] };
  if (triple === "x86_64-unknown-linux-gnu")
    return { platform: "linux", arches: ["x64"] };
  if (triple === "aarch64-unknown-linux-gnu")
    return { platform: "linux", arches: ["arm64"] };
  return null;
}

/** Bundle candidates under src-tauri/target/<triple>/release/bundle. */
function findBundles(root) {
  const found = [];
  let triples = [];
  try {
    triples = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch {
    return found;
  }
  for (const tripleEntry of triples) {
    const triple = tripleEntry.name;
    const target = targetKeyFor(triple);
    if (!target) continue;
    const bundleDir = path.join(root, triple, "release", "bundle");
    if (!fs.existsSync(bundleDir)) continue;
    const macApp = path.join(bundleDir, "macos", "CONV2.app");
    if (fs.existsSync(macApp))
      found.push({ kind: "mac", triple, target, appPath: macApp });
    const nsisDir = path.join(bundleDir, "nsis");
    if (fs.existsSync(nsisDir)) {
      for (const entry of fs.readdirSync(nsisDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
          found.push({
            kind: "nsis",
            triple,
            target,
            appPath: path.join(nsisDir, entry.name),
          });
        }
      }
    }
    const appimageDir = path.join(bundleDir, "appimage");
    if (fs.existsSync(appimageDir)) {
      for (const entry of fs.readdirSync(appimageDir, {
        withFileTypes: true,
      })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".appimage")) {
          found.push({
            kind: "appimage",
            triple,
            target,
            appPath: path.join(appimageDir, entry.name),
          });
        }
      }
    }
  }
  return found;
}

// ─── Payload extraction (NSIS via 7zz, AppImage via --appimage-extract) ────

function find7z() {
  for (const bin of ["7zz", "7z"]) {
    try {
      execFileSync(bin, ["i"], { stdio: "ignore" });
      return bin;
    } catch {
      // not found; try next
    }
  }
  return null;
}

/** Find a file by name under dir, breadth-first, bounded depth. */
function findFileByName(rootDir, fileName, maxDepth = 4) {
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.toLowerCase() === fileName.toLowerCase()
      ) {
        return path.join(dir, entry.name);
      }
      if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

function extractNsis(installerPath, scratch) {
  const sevenZipBin = find7z();
  if (!sevenZipBin) {
    throw new Error(
      "7z (or 7zz) not found on PATH; cannot extract the NSIS installer.",
    );
  }
  const extractDir = path.join(scratch, "nsis");
  execFileSync(sevenZipBin, ["x", installerPath, `-o${extractDir}`, "-y"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return extractDir;
}

function extractAppImage(appImagePath, scratch) {
  const extractDir = path.join(scratch, "appimage");
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync(appImagePath, ["--appimage-extract"], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: extractDir,
  });
  const root = path.join(extractDir, "squashfs-root");
  if (!fs.existsSync(root))
    throw new Error("--appimage-extract did not create squashfs-root.");
  return root;
}

/** Describe one bundle: where its sidecars and checksum manifest live. */
function describeBundle(bundle) {
  const ext = bundle.target.platform === "win32" ? ".exe" : "";
  const sidecarNames = SIDE_CARS.map((binary) => ({
    binary,
    fileName: `conv2-${binary}${ext}`,
  }));
  if (bundle.kind === "mac") {
    const appDir = bundle.appPath;
    return {
      ...bundle,
      scratch: null,
      manifestPath: path.join(
        appDir,
        "Contents",
        "Resources",
        "ffmpeg",
        "checksums.json",
      ),
      sidecars: sidecarNames.map(({ binary, fileName }) => ({
        binary,
        path: path.join(appDir, "Contents", "MacOS", fileName),
      })),
    };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conv2-payload-"));
  let root;
  if (bundle.kind === "nsis") {
    root = extractNsis(bundle.appPath, scratch);
  } else {
    root = extractAppImage(bundle.appPath, scratch);
  }
  return {
    ...bundle,
    scratch,
    manifestPath: findFileByName(root, "checksums.json") || "",
    sidecars: sidecarNames.map(({ binary, fileName }) => ({
      binary,
      path: findFileByName(root, fileName) || path.join(root, fileName),
    })),
  };
}

// ─── Verification ──────────────────────────────────────────────────────────

/**
 * `hostTeam` is the signing Team ID of the macOS app being verified (null for
 * other bundles or unsigned apps). Notarization rewrites sidecar bytes, so a
 * sidecar signed by that same team is verified by its code signature instead
 * of by hash; a broken signature throws.
 */
async function verifySidecar(sidecar, manifest, target, onMac, hostTeam) {
  if (onMac && hostTeam) {
    let sidecarTeam = null;
    try {
      sidecarTeam = readTeamIdentifier(sidecar.path);
    } catch {
      // Unsigned or ad-hoc sidecar: fall back to the hash check below.
    }
    if (sidecarTeam === hostTeam) {
      runCapture("codesign", ["--verify", "--strict", sidecar.path]);
      return true;
    }
  }
  const targetKey = `${target.platform === "darwin" ? "mac" : target.platform === "win32" ? "win" : "linux"}:${target.arches[0]}`;
  const bytes = await sha256File(sidecar.path);
  const expectedSingle = expectedChecksum(manifest, targetKey, sidecar.binary);
  if (expectedSingle && bytes === expectedSingle) return true;
  if (onMac && target.arches.length > 1) {
    // Universal: each fat slice must match that arch's manifest entry.
    let matched = 0;
    for (const arch of target.arches) {
      const expected = expectedChecksum(
        manifest,
        `mac:${arch}`,
        sidecar.binary,
      );
      if (!expected) return false;
      const slice = await findMacFatSlice(sidecar.path, arch);
      if (!slice) return false;
      if (
        (await sha256Range(sidecar.path, slice.offset, slice.size)) !== expected
      )
        return false;
      matched += 1;
    }
    return matched === target.arches.length;
  }
  if (target.platform === "win32" && expectedSingle) {
    const candidates = await authenticodeStrippedSha256Candidates(sidecar.path);
    return candidates.includes(expectedSingle);
  }
  return false;
}

async function main() {
  const report = {
    at: new Date().toISOString(),
    bundleRoot: relative(bundleRoot),
    requireMode,
    apps: [],
    binaries: [],
    verified: 0,
    ran: 0,
    errors: [],
    skipped: null,
    ok: false,
  };
  const finish = (code) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`Report: ${relative(outFile)}`);
    return code;
  };
  const noPayload = (reason) => {
    if (requireMode) {
      report.errors.push(reason);
      console.error(reason);
      return finish(1);
    }
    report.skipped = reason;
    console.log(`SKIP ${reason}`);
    return finish(0);
  };

  const bundles = findBundles(bundleRoot);
  report.apps = bundles.map((bundle) => ({
    kind: bundle.kind,
    path: relative(bundle.appPath),
    platform: bundle.target.platform,
    arch: bundle.target.arches.join("+"),
  }));
  if (bundles.length === 0) {
    return noPayload(`no CONV2 bundle under ${relative(bundleRoot)}`);
  }

  const onMac = process.platform === "darwin";
  let described = [];
  try {
    described = bundles.map(describeBundle);
  } catch (error) {
    report.errors.push(String(error.message || error));
    return finish(1);
  }

  const present = described.flatMap((app) =>
    app.sidecars.filter((s) => fs.existsSync(s.path)),
  );
  if (present.length === 0) {
    for (const app of described) {
      if (app.scratch) fs.rmSync(app.scratch, { recursive: true, force: true });
    }
    return noPayload(
      `no bundled conv2-ffmpeg or conv2-ffprobe in ${described.length} bundle(s)`,
    );
  }

  for (const app of described) {
    const appLabel = relative(app.appPath);
    try {
      if (!fs.existsSync(app.manifestPath)) {
        throw new Error(
          `checksum manifest missing from ${appLabel} (expected ${relative(app.manifestPath) || "ffmpeg/checksums.json"})`,
        );
      }
      const manifest = readManifest(app.manifestPath);
      let hostTeam = null;
      if (app.kind === "mac" && onMac) {
        try {
          hostTeam = readTeamIdentifier(app.appPath);
        } catch {
          // Unsigned app: sidecars are verified by hash only.
        }
      }
      for (const sidecar of app.sidecars) {
        const rel = relative(sidecar.path);
        const entry = { app: appLabel, name: sidecar.binary, path: rel };
        report.binaries.push(entry);
        if (!fs.existsSync(sidecar.path)) {
          report.errors.push(`missing conv2-${sidecar.binary} in ${appLabel}`);
          continue;
        }
        try {
          entry.verified = await verifySidecar(
            sidecar,
            manifest,
            app.target,
            onMac,
            hostTeam,
          );
        } catch (error) {
          entry.verified = false;
          entry.error = String(error.message || error);
        }
        if (!entry.verified) {
          report.errors.push(
            `conv2-${sidecar.binary} failed bundled verification: ${rel}`,
          );
          continue;
        }
        report.verified += 1;
        const hostArch = process.arch === "arm64" ? "arm64" : "x64";
        const runsHere =
          app.target.platform === process.platform &&
          app.target.arches.includes(hostArch);
        if (runsHere) {
          try {
            execFileSync(sidecar.path, ["-version"], {
              stdio: "ignore",
              timeout: 30_000,
            });
            entry.ran = true;
            report.ran += 1;
          } catch (error) {
            report.errors.push(`${rel} -version failed: ${error.message}`);
          }
        }
      }
      if (app.kind === "mac" && onMac) {
        try {
          const team = verifyMacCodeSignature(
            app.appPath,
            app.sidecars.map((s) => s.path),
          );
          report.binaries.push({
            app: appLabel,
            name: "codesign",
            path: appLabel,
            team,
          });
        } catch (error) {
          report.errors.push(String(error.message || error));
        }
      }
    } finally {
      if (app.scratch) fs.rmSync(app.scratch, { recursive: true, force: true });
    }
  }

  report.ok = report.errors.length === 0 && report.verified > 0;
  for (const error of report.errors) console.error(error);
  for (const binary of report.binaries) {
    if (binary.name === "codesign") continue;
    console.log(
      `${binary.verified ? "OK" : "FAIL"} ${binary.path}${binary.ran ? " (ran)" : ""}`,
    );
  }
  return finish(report.ok ? 0 : 1);
}

if (require.main === module) {
  // Not process.exit: on Node 26 it can deadlock against a V8 background compile thread.
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  authenticodeStrippedSha256Candidates,
  findBundles,
  findFileByName,
  targetKeyFor,
};
