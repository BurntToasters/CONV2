import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyBundledNotices } from "./copy-bundled-licenses.js";
import { validateStableMetadataChange } from "./check-stable-metadata-pr.mjs";
import {
  macBundleVersionFromSemver,
  syncChangelogForVersion,
} from "./sync-version-helpers.js";
import { run as updateMetainfo } from "./update-metainfo.js";
import { validateChangelogForVersion } from "./validate-changelog-version.js";
import {
  assertGpgValidSignature,
  assertDraftReleaseShape,
  requiredDraftBetaManifestNames,
  requiredDraftAssetNames,
  requiredDraftChecksumNames,
  requiredDraftStableManifestNames,
  resolveExpectedGpgSigner,
  validateSha256Sums,
} from "./verify-release-draft.js";
import { RELEASE_LICENSE_SCRIPTS } from "./release-licenses.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const beta = "1.2.3-beta.4";
const stable = "1.2.3";
const primaryFingerprint = "1234567890ABCDEF1234567890ABCDEF12345678";

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function metadataFiles() {
  const base = {
    "package.json": json({
      name: "conv2",
      version: beta,
      dependencies: { tauri: "2" },
    }),
    "package-lock.json": json({
      name: "conv2",
      version: beta,
      packages: {
        "": { name: "conv2", version: beta },
        "node_modules/tauri": { version: "2" },
      },
    }),
    "src-tauri/Cargo.toml": `[package]\nname = "conv2"\nversion = "${beta}"\n\n[dependencies]\ntauri = "2"\n`,
    "src-tauri/Cargo.lock": `[[package]]\nname = "conv2"\nversion = "${beta}"\n\n[[package]]\nname = "tauri"\nversion = "2.0.0"\n`,
    "src-tauri/Info.plist": `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${beta}</string><key>CFBundleVersion</key><string>${beta}</string></dict></plist>\n`,
    "src-tauri/tauri.conf.json": json({
      productName: "CONV2",
      version: beta,
      bundle: {
        resources: {},
        macOS: { bundleVersion: macBundleVersionFromSemver(beta) },
      },
    }),
    "CHANGELOG.md": `# CONV2\n\n## Changes in \`v${beta}:\`\n\n- Beta notes.\n`,
    "run.rosie.conv2.metainfo.xml": `<component>\n  <launchable type="desktop-id">run.rosie.conv2.desktop</launchable>\n  <url type="homepage">https://example.invalid/conv2</url>\n  <releases>\n    <release version="${beta}" date="2026-01-01"/>\n    <release version="1.2.2-beta.1" date="2025-12-01"/>\n    <release version="1.2.2" date="2025-11-01"/>\n  </releases>\n</component>\n`,
  };
  const head = { ...base };
  head["package.json"] = json({
    ...JSON.parse(base["package.json"]),
    version: stable,
  });
  head["package-lock.json"] = json({
    ...JSON.parse(base["package-lock.json"]),
    version: stable,
    packages: {
      "": { name: "conv2", version: stable },
      "node_modules/tauri": { version: "2" },
    },
  });
  head["src-tauri/Cargo.toml"] = base["src-tauri/Cargo.toml"].replace(
    beta,
    stable,
  );
  head["src-tauri/Cargo.lock"] = base["src-tauri/Cargo.lock"].replace(
    beta,
    stable,
  );
  head["src-tauri/Info.plist"] = base["src-tauri/Info.plist"].replaceAll(
    beta,
    stable,
  );
  head["src-tauri/tauri.conf.json"] = json({
    ...JSON.parse(base["src-tauri/tauri.conf.json"]),
    version: stable,
    bundle: {
      resources: {},
      macOS: { bundleVersion: macBundleVersionFromSemver(stable) },
    },
  });
  head["CHANGELOG.md"] =
    `# CONV2\n\n## Changes in \`v${stable}:\`\n\n- Stable notes.\n\n${base["CHANGELOG.md"]}`;
  head["run.rosie.conv2.metainfo.xml"] =
    `<component>\n  <launchable type="desktop-id">run.rosie.conv2.desktop</launchable>\n  <url type="homepage">https://example.invalid/conv2</url>\n  <releases>\n    <release version="${stable}" date="2026-02-01"/>\n    <release version="1.2.2-beta.1" date="2025-12-01"/>\n    <release version="1.2.2" date="2025-11-01"/>\n  </releases>\n</component>\n`;
  return { base, head };
}

function metadataChanges({ base, head } = metadataFiles()) {
  return Object.keys(base).map((file) => ({
    path: file,
    status: "M",
    baseText: base[file],
    headText: head[file],
  }));
}

/**
 * Mirror the CHANGELOG.md shape a beta release leaves behind: Beta callout,
 * download table, intro anchor, real beta notes, and older release history.
 * It is built inline so the fixture never depends on the live release state.
 */
function betaChangelogFixture(betaVersion) {
  const download = (asset) =>
    `https://github.com/BurntToasters/CONV2/releases/download/v${betaVersion}/${asset}`;
  return [
    "> [!NOTE]",
    "> 🅱️ This is a Beta build.",
    "",
    "# ⬇️ Downloads",
    "",
    "| Windows | macOS | Linux |",
    "| :-- | :-- | :-- |",
    `| **Setup:** [x64](${download("CONV2-Win-x64-Setup.exe")}) | **[Universal DMG](${download("CONV2-macOS-universal.dmg")})** | **AppImage:** [x64](${download("CONV2-Linux-x86_64.AppImage")}) |`,
    "",
    "### ℹ️ Enjoying CONV2? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)",
    "",
    "---",
    "",
    `## Changes in \`v${betaVersion}:\``,
    "",
    "- **Fix:** Beta promotion fixture notes.",
    "",
    "## Changes in `v1.2.2:`",
    "",
    "- **NEW - Tauri V2:** CONV2 moved from Electron to Tauri V2 with a Rust backend.",
    "",
  ].join("\n");
}

/**
 * The live package.json version only chooses the version numbers. A stable
 * tree gets a synthetic `X.Y.Z-beta.4` starting point, so no assertion reads
 * the live CHANGELOG.md or metainfo and the test passes on beta and stable.
 */
function realStablePromotionFixture() {
  const liveVersion = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  const stableVersion = liveVersion.replace(/-beta\.\d+$/u, "");
  const betaVersion = /-beta\.\d+$/u.test(liveVersion)
    ? liveVersion
    : `${stableVersion}-beta.4`;
  assert.match(stableVersion, /^\d+\.\d+\.\d+$/u);
  assert.match(betaVersion, /^\d+\.\d+\.\d+-beta\.\d+$/u);

  const { base, head } = metadataFiles();
  for (const files of [base, head]) {
    for (const file of Object.keys(files)) {
      files[file] = files[file]
        .replaceAll(beta, betaVersion)
        .replaceAll(stable, stableVersion);
    }
  }
  for (const [files, version] of [
    [base, betaVersion],
    [head, stableVersion],
  ]) {
    const conf = JSON.parse(files["src-tauri/tauri.conf.json"]);
    conf.bundle.macOS.bundleVersion = macBundleVersionFromSemver(version);
    files["src-tauri/tauri.conf.json"] = json(conf);
  }

  const betaCallout =
    /^> \[!NOTE\]\r?\n> 🅱️ This is a Beta build\.\r?\n(?:\r?\n)?/mu;
  const betaChangelog = betaChangelogFixture(betaVersion);
  assert.match(betaChangelog, betaCallout);
  const calloutRemoved = betaChangelog.replace(betaCallout, "");
  const synced = syncChangelogForVersion(calloutRemoved, stableVersion);
  const placeholder = "- **Fix:** (add release notes)";
  assert.equal(synced.split(placeholder).length - 1, 1);
  const stableNotes =
    "- **Fix:** Stable promotion release notes.\n" +
    "- **Security:** Stable release metadata and updater signatures verified.";
  const stableChangelog = synced.replace(placeholder, stableNotes);
  assert.deepEqual(
    validateChangelogForVersion(stableChangelog, stableVersion),
    [],
  );
  base["CHANGELOG.md"] = betaChangelog;
  head["CHANGELOG.md"] = stableChangelog;
  return { base, head, betaVersion, stableVersion, stableChangelog };
}

test("stable metadata accepts the actual sync-version changelog promotion", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  assert.doesNotThrow(() =>
    validateStableMetadataChange({
      baseVersion: betaVersion,
      headVersion: stableVersion,
      changedFiles: metadataChanges({ base, head }),
    }),
  );
});

test("stable metadata rejects edits to existing changelog release history", () => {
  const { base, head, betaVersion, stableVersion, stableChangelog } =
    realStablePromotionFixture();
  const tampered = stableChangelog.replace(
    "CONV2 moved from Electron to Tauri V2",
    "CONV2 moved from another framework to Tauri V2",
  );
  assert.notEqual(tampered, stableChangelog);
  const changedHead = { ...head, "CHANGELOG.md": tampered };
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: metadataChanges({ base, head: changedHead }),
      }),
    /CHANGELOG.*only|only.*CHANGELOG|non-release/i,
  );
});

test("stable metainfo permits only insertion of the expected release element", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  const changedMetainfo = {
    ...head,
    "run.rosie.conv2.metainfo.xml": head[
      "run.rosie.conv2.metainfo.xml"
    ].replace(
      "</component>",
      '<launchable type="desktop-id">attacker.desktop</launchable></component>',
    ),
  };

  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: metadataChanges({ base, head: changedMetainfo }),
      }),
    /metainfo.*only|only.*metainfo|non-release/i,
  );
});

test("stable metadata accepts the exact AppStream updater promotion output", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "conv2-round2-metainfo-"));
  try {
    const packagePath = path.join(temp, "package.json");
    const metadataPath = path.join(temp, "run.rosie.conv2.metainfo.xml");
    fs.writeFileSync(
      packagePath,
      json({ name: "conv2", version: stableVersion }),
    );
    fs.writeFileSync(metadataPath, base["run.rosie.conv2.metainfo.xml"]);
    updateMetainfo({
      now: new Date("2026-02-01T00:00:00.000Z"),
      packagePath,
      metadataPath,
    });
    const generatedMetainfo = fs.readFileSync(metadataPath, "utf8");
    const generatedHead = {
      ...head,
      "run.rosie.conv2.metainfo.xml": generatedMetainfo,
    };
    validateStableMetadataChange({
      baseVersion: betaVersion,
      headVersion: stableVersion,
      changedFiles: metadataChanges({ base, head: generatedHead }),
    });
    assert.match(generatedMetainfo, /version="1\.2\.2-beta\.1"/u);
    assert.doesNotMatch(
      generatedMetainfo,
      new RegExp(betaVersion.replaceAll(".", "\\."), "u"),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("stable metadata rejects dependency/config changes and every deletion", () => {
  const { base, head, betaVersion, stableVersion } =
    realStablePromotionFixture();
  const dependencyHead = {
    ...head,
    "package.json": json({
      ...JSON.parse(head["package.json"]),
      dependencies: { tauri: "3" },
    }),
  };
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: metadataChanges({ base, head: dependencyHead }),
      }),
    /package\.json.*non-version|non-version.*package\.json/i,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: [
          ...metadataChanges({ base, head }),
          {
            path: "scripts/release.js",
            status: "M",
            baseText: "old",
            headText: "new",
          },
        ],
      }),
    /unexpected|not release metadata/i,
  );
  assert.throws(
    () =>
      validateStableMetadataChange({
        baseVersion: betaVersion,
        headVersion: stableVersion,
        changedFiles: [
          ...metadataChanges({ base, head }),
          {
            path: "src-tauri/tauri.conf.json",
            status: "D",
            baseText: "present",
          },
        ],
      }),
    /delet/i,
  );
});

test("release checksum entries must match the released asset bytes", () => {
  const contents = Buffer.from("signed release artifact\n");
  const digest = crypto.createHash("sha256").update(contents).digest("hex");
  const assets = new Map([["CONV2-Windows-x64.exe", contents]]);
  assert.deepEqual(
    validateSha256Sums({
      checksumName: "SHA256SUMS-windows-x86_64.txt",
      text: `${digest}  CONV2-Windows-x64.exe\n`,
      assets,
    }),
    ["CONV2-Windows-x64.exe"],
  );
  for (const text of [
    `${"0".repeat(64)}  CONV2-Windows-x64.exe\n`,
    `${digest}  missing.exe\n`,
    `${digest}  ../CONV2-Windows-x64.exe\n`,
    `${digest}  CONV2-Windows-x64.exe\n${digest}  CONV2-Windows-x64.exe\n`,
    "not a checksum line\n",
  ]) {
    assert.throws(() =>
      validateSha256Sums({
        checksumName: "SHA256SUMS-windows-x86_64.txt",
        text,
        assets,
      }),
    );
  }
});

test("every required stable and beta manifest has a signed checksum bucket", () => {
  const checksums = new Set(requiredDraftChecksumNames());
  const manifests = [
    ...requiredDraftStableManifestNames(),
    ...requiredDraftBetaManifestNames(),
  ];

  for (const manifest of manifests) {
    const target = manifest.slice("latest-".length, -".json".length);
    const checksum = `SHA256SUMS-${target}.txt`;
    assert.ok(checksums.has(checksum), `${manifest} needs ${checksum}`);
    assert.ok(
      checksums.has(`${checksum}.asc`),
      `${checksum} needs a GPG signature`,
    );
  }
});

test("draft GPG trust resolves only one configured key and validates signer identity", () => {
  assert.throws(() => resolveExpectedGpgSigner({ keyId: "" }), /GPG_KEY_ID/i);
  const keyListing = [
    "pub:u:1:22:ABCDEF1234567890:0:0:::::sc:",
    `fpr:::::::::${primaryFingerprint}:`,
    "sub:u:1:22:9999AAAABBBBCCCC:0:0:::::s:",
    "fpr:::::::::9999AAAABBBBCCCC9999AAAABBBBCCCC9999AAAA:",
  ].join("\n");
  assert.equal(
    resolveExpectedGpgSigner({
      keyId: "ABCDEF1234567890",
      spawn: () => ({ status: 0, stdout: keyListing, stderr: "" }),
    }),
    primaryFingerprint,
  );
  assert.doesNotThrow(() =>
    assertGpgValidSignature({
      statusOutput: `[GNUPG:] VALIDSIG 9999AAAABBBBCCCC9999AAAABBBBCCCC9999AAAA 2026-01-01 1 0 4 0 1 10 00 ${primaryFingerprint}`,
      expectedFingerprint: primaryFingerprint,
    }),
  );
  assert.throws(
    () =>
      assertGpgValidSignature({
        statusOutput: `[GNUPG:] VALIDSIG ${"9".repeat(40)} 2026-01-01 1 0 4 0 1 10 00 ${"9".repeat(40)}`,
        expectedFingerprint: primaryFingerprint,
      }),
    /trusted|signer|fingerprint/i,
  );
  assert.throws(
    () =>
      assertGpgValidSignature({
        statusOutput: "[GNUPG:] BADSIG ABCDEF1234567890 Wrong Signer",
        expectedFingerprint: primaryFingerprint,
      }),
    /valid|signature|signer/i,
  );
});

test("bundled notices copy the FFmpeg texts to frontend assets", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "conv2-round2-licenses-"));
  try {
    fs.mkdirSync(path.join(temp, "resources", "ffmpeg"), { recursive: true });
    for (const file of [
      "NOTICE.txt",
      "ffmpeg_license.txt",
      "SOURCE_OFFER.txt",
    ]) {
      fs.writeFileSync(
        path.join(temp, "resources", "ffmpeg", file),
        `${file}\n`,
      );
    }
    const entries = copyBundledNotices(temp);
    assert.deepEqual(entries.map((entry) => entry.file).sort(), [
      "ffmpeg-license.txt",
      "ffmpeg-notice.txt",
      "ffmpeg-source-offer.txt",
    ]);
    assert.equal(
      fs.readFileSync(path.join(temp, "public", "ffmpeg-license.txt"), "utf8"),
      "ffmpeg_license.txt\n",
    );
    assert.equal(
      entries.some((entry) => /yt-dlp/i.test(entry.file)),
      false,
      "CONV2 ships no yt-dlp notice",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a missing FFmpeg notice fails the copy instead of shipping without it", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "conv2-round2-missing-"));
  try {
    fs.mkdirSync(path.join(temp, "resources", "ffmpeg"), { recursive: true });
    assert.throws(
      () => copyBundledNotices(temp),
      /Missing bundled license notice/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("release license gate keeps strict Cargo 3.9 source coverage mandatory", () => {
  assert.ok(RELEASE_LICENSE_SCRIPTS.includes("licenses:cargo:strict"));
  assert.match(
    fs.readFileSync(path.join(root, "scripts", "release-licenses.js"), "utf8"),
    /licenses:cargo:strict/,
  );
});

test("draft release rejects a tag peeled to a different commit than HEAD", () => {
  const head = "a".repeat(40);
  assert.throws(
    () =>
      assertDraftReleaseShape({
        release: {
          draft: true,
          prerelease: true,
          target_commitish: head,
        },
        assetNames: requiredDraftAssetNames(),
        version: "5.0.0-beta.2",
        headCommit: head,
        tagCommit: "b".repeat(40),
      }),
    /tag.*commit|commit.*tag/i,
  );
});

test("release tag resolution peels annotated tags and fails closed on mismatch", () => {
  const {
    resolveReleaseTagCommit,
    assertReleaseTagMatchesHead,
  } = require("./release-git-tag.cjs");
  const head = "a".repeat(40);
  const tagObject = "b".repeat(40);
  const nestedTagObject = "c".repeat(40);
  const calls = [];
  const api = (method, endpoint) => {
    calls.push(endpoint);
    if (endpoint.endsWith("/git/ref/tags/v5.0.0-beta.2")) {
      return { object: { type: "tag", sha: tagObject } };
    }
    if (endpoint.endsWith(`/git/tags/${tagObject}`)) {
      return { object: { type: "tag", sha: nestedTagObject } };
    }
    if (endpoint.endsWith(`/git/tags/${nestedTagObject}`)) {
      return { object: { type: "commit", sha: head } };
    }
    throw new Error(`unexpected GitHub request ${method} ${endpoint}`);
  };
  assert.equal(
    resolveReleaseTagCommit({
      owner: "BurntToasters",
      repo: "CONV2",
      tag: "v5.0.0-beta.2",
      api,
    }),
    head,
  );
  assert.equal(calls.length, 3, "all annotated tag objects must be peeled");
  assert.throws(
    () =>
      assertReleaseTagMatchesHead({
        owner: "BurntToasters",
        repo: "CONV2",
        tag: "v5.0.0-beta.2",
        headCommit: "d".repeat(40),
        api,
      }),
    /tag.*commit|commit.*tag/i,
  );
  assert.equal(
    resolveReleaseTagCommit({
      owner: "BurntToasters",
      repo: "CONV2",
      tag: "v5.0.0-beta.2",
      api: () => {
        const missing = new Error("HTTP 404");
        missing.statusCode = 404;
        throw missing;
      },
    }),
    null,
    "a not-yet-created draft tag can be distinguished from API failure",
  );
});

test("direct release publication runs shared preflight after draft verification and before PATCH", () => {
  const source = fs.readFileSync(
    path.join(root, "scripts", "publish-release.cjs"),
    "utf8",
  );
  const publishStart = source.indexOf("async function publishFromProof(");
  assert.notEqual(publishStart, -1, "publisher flow must be inspectable");
  const mainStart = source.indexOf("async function main()", publishStart);
  assert.notEqual(mainStart, -1, "publisher entry point must be inspectable");
  const publishBody = source.slice(publishStart, mainStart);
  const verify = publishBody.indexOf("runVerifyDraft(proofPath);");
  const preflight = publishBody.indexOf("runReleasePreflight();");
  const patch = publishBody.indexOf('"PATCH"');
  assert.match(source, /release-preflight\.js/u);
  assert.ok(verify >= 0, "publisher must verify the draft with its proof path");
  assert.ok(
    preflight > verify,
    "shared preflight must follow draft verification",
  );
  assert.ok(patch > preflight, "PATCH must follow shared preflight");
});
