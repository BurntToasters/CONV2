// Publishes the fully-verified draft for the current package version.
// Order is the whole point: verify:draft must pass before the flip is sent.
// Usage: npm run release:publish   (after every platform VM has signed)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");
const { assertStableReleaseOverridesAllowed } = require("./release-policy.cjs");
const { assertReleaseTagMatchesHead } = require("./release-git-tag.cjs");
const {
  assertExpectedRelease,
  assertReleaseTagName,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");

const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "CONV2";
const packageJson = require("../package.json");
const VERSION = packageJson.version;
const TAG_NAME = "v" + VERSION;

function currentReleaseCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

const VERIFY_PROOF_ENV = "CONV2_VERIFY_PROOF_FILE";

function runVerifyDraft(proofPath) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "verify-release-draft.js"), "--verify-artifacts"],
    {
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, [VERIFY_PROOF_ENV]: proofPath },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:verify:draft failed; fix the draft instead of publishing it.",
    );
  }
}

function isSafeAssetName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name === path.posix.basename(name) &&
    name === path.win32.basename(name) &&
    !/[\\/:\0]/u.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

function normalizeAssetIdentities(assets, label, { exactKeys = false } = {}) {
  if (!Array.isArray(assets)) {
    throw new Error(`${label} asset identities are not a list.`);
  }
  const names = new Set();
  const ids = new Set();
  const identities = assets.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new Error(`${label} has a malformed asset identity.`);
    }
    if (exactKeys && Object.keys(asset).sort().join(",") !== "id,name,size") {
      throw new Error(
        `${label} asset identities must contain only name, id, and size.`,
      );
    }
    const { name, id, size } = asset;
    if (!isSafeAssetName(name)) {
      throw new Error(`${label} has an unsafe or missing asset name.`);
    }
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`${label} asset ${name} has no valid id.`);
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`${label} asset ${name} has no valid size.`);
    }
    if (names.has(name) || ids.has(id)) {
      throw new Error(`${label} repeats asset ${name}.`);
    }
    names.add(name);
    ids.add(id);
    return { name, id, size };
  });
  return identities.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function readVerificationProof(proofPath, { tag, headCommit }) {
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  } catch {
    throw new Error(
      "Draft verification proof is missing or invalid; refusing to publish.",
    );
  }
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new Error("Draft verification proof is not an object.");
  }
  if (
    Object.keys(proof).sort().join(",") !== "assets,headCommit,releaseId,tag"
  ) {
    throw new Error(
      "Draft verification proof contains fields outside the release id, tag, HEAD, and asset identities.",
    );
  }
  if (proof.tag !== tag) {
    throw new Error(
      `Draft verification proof is for ${JSON.stringify(proof.tag)}, not ${tag}.`,
    );
  }
  if (
    typeof proof.headCommit !== "string" ||
    proof.headCommit.toLowerCase() !== headCommit.toLowerCase()
  ) {
    throw new Error(
      `Draft verification proof is for commit ${JSON.stringify(proof.headCommit)}, not HEAD ${headCommit}.`,
    );
  }
  if (!Number.isSafeInteger(proof.releaseId) || proof.releaseId <= 0) {
    throw new Error("Draft verification proof has no valid release id.");
  }
  return {
    releaseId: proof.releaseId,
    identities: normalizeAssetIdentities(
      proof.assets,
      "Draft verification proof",
      { exactKeys: true },
    ),
  };
}

async function listDraftAssets(releaseId) {
  const assets = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}

function runReleasePreflight() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "release-preflight.js")],
    { stdio: "inherit", cwd: path.resolve(__dirname, "..") },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:preflight failed; publication requires a clean, pushed release source.",
    );
  }
}

async function publishFromProof(proofDirectory) {
  const proofPath = path.join(proofDirectory, "draft-verification-proof.json");
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();
  const commit = currentReleaseCommit();
  runVerifyDraft(proofPath);
  const proof = readVerificationProof(proofPath, {
    tag: TAG_NAME,
    headCommit: commit,
  });

  const initialTagCommit = assertReleaseTagMatchesHead({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag: TAG_NAME,
    headCommit: commit,
    api: githubApi,
    // Draft releases can receive their tag only when GitHub publishes them.
    allowMissing: true,
  });

  const releases = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const drafts = releases.filter(
    (release) =>
      release?.draft && isExpectedRelease(release, TAG_NAME, VERSION),
  );
  if (drafts.length > 1) {
    throw new Error(
      `Multiple draft releases exist for ${TAG_NAME}. Resolve duplicates before publishing.`,
    );
  }
  if (drafts.length === 0) {
    throw new Error(`No draft exists for ${TAG_NAME}.`);
  }
  const draft = assertExpectedRelease(
    drafts[0],
    TAG_NAME,
    VERSION,
    "Publishing draft",
  );
  const expectedPrerelease = /-beta\.\d+$/.test(VERSION);
  if (Boolean(draft.prerelease) !== expectedPrerelease) {
    throw new Error(
      `Draft ${TAG_NAME} prerelease=${draft.prerelease}, expected ${expectedPrerelease}; re-run npm run release:draft.`,
    );
  }
  if (draft.target_commitish !== commit) {
    throw new Error(
      `Draft ${TAG_NAME} targets ${draft.target_commitish}, not HEAD ${commit}.`,
    );
  }
  if (!Number.isSafeInteger(draft.id) || draft.id !== proof.releaseId) {
    throw new Error(
      `Draft ${TAG_NAME} id ${draft.id} does not match the verified release id ${proof.releaseId}.`,
    );
  }

  // This invokes the same branch, clean-tree and pushed-HEAD check used by release
  // preparation. It stays adjacent to the publish request so old build-time
  // evidence cannot authorize a later direct publication.
  runReleasePreflight();
  const currentCommit = currentReleaseCommit();
  if (currentCommit !== commit) {
    throw new Error(
      `HEAD changed during publication checks: expected ${commit}, now ${currentCommit}.`,
    );
  }
  const prePublishTagCommit = assertReleaseTagMatchesHead({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag: TAG_NAME,
    headCommit: currentCommit,
    api: githubApi,
    allowMissing: true,
  });
  if (initialTagCommit !== null && prePublishTagCommit !== initialTagCommit) {
    throw new Error(
      `Release tag ${TAG_NAME} changed while publication checks were running.`,
    );
  }

  const prePublishIdentities = normalizeAssetIdentities(
    await listDraftAssets(draft.id),
    "Draft at publish",
  );
  if (
    JSON.stringify(prePublishIdentities) !== JSON.stringify(proof.identities)
  ) {
    throw new Error(
      `Draft ${TAG_NAME} assets changed after verification; refusing to publish.`,
    );
  }

  const published = githubApi(
    "PATCH",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${draft.id}`,
    {
      tag_name: TAG_NAME,
      target_commitish: commit,
      draft: false,
      prerelease: expectedPrerelease,
    },
  );
  const validated = assertReleaseTagName(
    published,
    TAG_NAME,
    "Published release",
  );
  assertReleaseTagMatchesHead({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag: TAG_NAME,
    headCommit: commit,
    api: githubApi,
  });
  console.log(`Published ${TAG_NAME}: ${validated.html_url}`);
  console.log(
    "Next: npm run release:verify:published (live updater feed + signature proof).",
  );
}

async function main() {
  const proofDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "conv2-publish-proof-"),
  );
  try {
    await publishFromProof(proofDirectory);
  } finally {
    fs.rmSync(proofDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    "✗ ERROR: Failed to publish release: " +
      (error && error.message ? error.message : String(error)),
  );
  process.exit(1);
});
