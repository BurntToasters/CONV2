/**
 * Failure modes for the CONV2 v1 update feed that every CONV2 v2 release
 * carries, written before scripts/legacy-v1-feed.js. Each test lists the ids it covers.
 *
 * missing-file      A v1 feed file is absent, so that platform's v1 updater
 *                   fails with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND.
 * bare-url          A file url or `path` still resolves inside the v2 release,
 *                   where a colliding v2 asset name would hand a v2 build to
 *                   a v1 updater.
 * absolute-url      An absolute URL gets the v2 download path prepended.
 * unsafe-name       A name with "/", "\", "..", "?", "#", "%" or a space moves
 *                   the resolved URL somewhere else.
 * wrong-target      The feed points at a v1 prerelease, a draft, a v2 tag, or
 *                   a tag other than the configured one.
 * version-mismatch  The feed version differs from the release it points at.
 * hash-lost         sha512 or size changes during the rewrite.
 * extra-keys        Source keys CONV2 v1 does not need leak into the feed.
 * bad-yaml          Output that js-yaml, electron-updater's parser, reads
 *                   differently than intended.
 * missing-asset     The feed names a file the v1 release lacks or with a
 *                   different size.
 * gate-missing      The draft gate accepts a draft without the feed files.
 * gate-content      The draft gate accepts feed files that point elsewhere.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  LEGACY_FEED_FILES,
  assertLegacyFeedAssets,
  assertLegacySourceRelease,
  buildLegacyFeed,
  readLegacyFeedConfig,
  validateLegacyFeed,
} from "./legacy-v1-feed.js";
import {
  assertDraftReleaseShape,
  requiredDraftAssetNames,
} from "./verify-release-draft.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "testdata", "legacy-v1", "v1.6.1");
const SOURCE_TAG = "v1.6.1";
const sources = Object.fromEntries(
  LEGACY_FEED_FILES.map((name) => [
    name,
    fs.readFileSync(path.join(fixtureDir, name), "utf8"),
  ]),
);
const sourceRelease = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "release.json"), "utf8"),
);

/**
 * electron-updater 6.8.9 GitHubProvider.resolveFiles, reimplemented so the
 * test does not trust the module under test: getBaseDownloadPath(tag, url)
 * joined onto https://github.com with `new URL`.
 */
function resolveLikeElectronUpdater(releaseTag, fileUrl) {
  const pathname = `/BurntToasters/CONV2/releases/download/${releaseTag}/${fileUrl.replace(/ /g, "-")}`;
  return new URL(pathname, "https://github.com").href;
}

function withSource(name, mutate) {
  const parsed = yaml.load(sources[name]);
  mutate(parsed);
  return { ...sources, [name]: yaml.dump(parsed) };
}

test("the feed covers every channel file electron-updater requests (missing-file)", () => {
  assert.deepEqual([...LEGACY_FEED_FILES].sort(), [
    "latest-linux-arm64.yml",
    "latest-linux.yml",
    "latest-mac.yml",
    "latest.yml",
  ]);
  for (const name of LEGACY_FEED_FILES) {
    const partial = { ...sources };
    delete partial[name];
    assert.throws(
      () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: partial }),
      new RegExp(name.replace(/\./g, "\\.")),
    );
  }
});

test("rewritten URLs resolve to the v1 release from any v2 tag (bare-url, hash-lost, bad-yaml, missing-asset)", () => {
  const feed = buildLegacyFeed({ sourceTag: SOURCE_TAG, sources });
  assert.deepEqual(Object.keys(feed).sort(), [...LEGACY_FEED_FILES].sort());
  const sizes = new Map(
    sourceRelease.assets.map((asset) => [asset.name, asset.size]),
  );
  for (const name of LEGACY_FEED_FILES) {
    const out = yaml.load(feed[name]);
    const src = yaml.load(sources[name]);
    assert.equal(out.version, "1.6.1", name);
    assert.equal(out.sha512, src.sha512, `${name} sha512`);
    assert.equal(out.path, `../${SOURCE_TAG}/${src.path}`, `${name} path`);
    assert.equal(out.files.length, src.files.length, `${name} files`);
    out.files.forEach((file, index) => {
      const original = src.files[index];
      assert.equal(file.url, `../${SOURCE_TAG}/${original.url}`);
      assert.equal(file.sha512, original.sha512);
      assert.equal(file.size, original.size);
      assert.equal(file.blockMapSize, original.blockMapSize);
      for (const releaseTag of ["v2.0.0", "v2.0.0-beta.1", "v2.12.3"]) {
        assert.equal(
          resolveLikeElectronUpdater(releaseTag, file.url),
          `https://github.com/BurntToasters/CONV2/releases/download/${SOURCE_TAG}/${original.url}`,
        );
      }
      assert.equal(sizes.get(original.url), original.size, original.url);
    });
    assert.doesNotThrow(() =>
      validateLegacyFeed({ name, text: feed[name], sourceTag: SOURCE_TAG }),
    );
  }
  assert.doesNotThrow(() =>
    assertLegacyFeedAssets({
      feed,
      sourceTag: SOURCE_TAG,
      assets: sourceRelease.assets,
    }),
  );
});

test("absolute and unsafe source URLs are refused (absolute-url, unsafe-name)", () => {
  const bad = [
    "https://example.com/CONV2-Win-Setup.exe",
    "//example.com/CONV2-Win-Setup.exe",
    "../v1.6.0/CONV2-Win-Setup.exe",
    "sub/CONV2-Win-Setup.exe",
    "sub\\CONV2-Win-Setup.exe",
    "CONV2 Win-Setup.exe",
    "CONV2-Win-Setup.exe?x=1",
    "CONV2-Win-Setup.exe#frag",
    "CONV2%2FWin-Setup.exe",
    "..",
    "",
  ];
  for (const url of bad) {
    const mutated = withSource("latest.yml", (parsed) => {
      parsed.files[0].url = url;
    });
    assert.throws(
      () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated }),
      /file name/i,
      JSON.stringify(url),
    );
  }
  const badPath = withSource("latest-mac.yml", (parsed) => {
    parsed.path = "https://example.com/x.zip";
  });
  assert.throws(
    () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: badPath }),
    /file name/i,
  );
});

test("a source feed whose version differs from the tag is refused (version-mismatch)", () => {
  const mutated = withSource("latest-linux.yml", (parsed) => {
    parsed.version = "1.6.0";
  });
  assert.throws(
    () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated }),
    /1\.6\.0.*v1\.6\.1|v1\.6\.1.*1\.6\.0/,
  );
});

test("missing hashes or sizes are refused (hash-lost)", () => {
  for (const key of ["sha512", "size"]) {
    const mutated = withSource("latest.yml", (parsed) => {
      delete parsed.files[1][key];
    });
    assert.throws(
      () => buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated }),
      new RegExp(key),
    );
  }
});

test("only keys electron-updater uses are kept (extra-keys)", () => {
  const mutated = withSource("latest-mac.yml", (parsed) => {
    parsed.releaseNotes = "## v1 notes";
    parsed.somethingElse = true;
    parsed.minimumSystemVersion = "12.0.0";
  });
  const out = yaml.load(
    buildLegacyFeed({ sourceTag: SOURCE_TAG, sources: mutated })[
      "latest-mac.yml"
    ],
  );
  assert.equal(out.releaseNotes, undefined);
  assert.equal(out.somethingElse, undefined);
  assert.equal(out.minimumSystemVersion, "12.0.0");
  assert.equal(
    out.releaseDate,
    yaml.load(sources["latest-mac.yml"]).releaseDate,
  );
});

test("the source release must be a published CONV2 v1 release (wrong-target)", () => {
  const ok = { tag_name: "v1.6.1", draft: false, prerelease: false };
  assert.doesNotThrow(() => assertLegacySourceRelease(ok, "v1.6.1"));
  const cases = [
    [{ ...ok, tag_name: "v1.6.2-beta.1", prerelease: true }, "v1.6.2-beta.1"],
    [{ ...ok, draft: true }, "v1.6.1"],
    [{ ...ok, prerelease: true }, "v1.6.1"],
    [{ ...ok, tag_name: "v2.0.0" }, "v2.0.0"],
    [{ ...ok, tag_name: "v0.9.0" }, "v0.9.0"],
    [ok, "v1.6.0"],
  ];
  for (const [release, configured] of cases) {
    assert.throws(
      () => assertLegacySourceRelease(release, configured),
      Error,
      JSON.stringify({ release, configured }),
    );
  }
  assert.throws(
    () => buildLegacyFeed({ sourceTag: "v2.0.0", sources }),
    /CONV2 v1/,
  );
});

test("the committed config names a CONV2 v1 release", () => {
  const config = readLegacyFeedConfig(root);
  assert.match(config.sourceTag, /^v1\.\d+\.\d+$/);
});

test("feed validation rejects files that do not point at the configured release (gate-content)", () => {
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: sources["latest.yml"],
        sourceTag: SOURCE_TAG,
      }),
    /\.\.\/v1\.6\.1\//,
  );
  const feed = buildLegacyFeed({ sourceTag: SOURCE_TAG, sources });
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: feed["latest.yml"],
        sourceTag: "v1.6.2",
      }),
    /v1\.6\.2/,
  );
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: "version: [",
        sourceTag: SOURCE_TAG,
      }),
    /latest\.yml/,
  );
  const wrongVersion = feed["latest.yml"].replace(
    "version: 1.6.1",
    "version: 1.6.0",
  );
  assert.throws(
    () =>
      validateLegacyFeed({
        name: "latest.yml",
        text: wrongVersion,
        sourceTag: SOURCE_TAG,
      }),
    /1\.6\.0/,
  );
});

test("assets missing from the v1 release, or with another size, are refused (missing-asset)", () => {
  const feed = buildLegacyFeed({ sourceTag: SOURCE_TAG, sources });
  const withoutMac = sourceRelease.assets.filter(
    (asset) => asset.name !== "CONV2-macOS-universal.zip",
  );
  assert.throws(
    () =>
      assertLegacyFeedAssets({
        feed,
        sourceTag: SOURCE_TAG,
        assets: withoutMac,
      }),
    /CONV2-macOS-universal\.zip/,
  );
  const resized = sourceRelease.assets.map((asset) =>
    asset.name === "CONV2-Win-arm64-Setup.exe"
      ? { ...asset, size: asset.size + 1 }
      : asset,
  );
  assert.throws(
    () =>
      assertLegacyFeedAssets({ feed, sourceTag: SOURCE_TAG, assets: resized }),
    /CONV2-Win-arm64-Setup\.exe/,
  );
});

test("the draft gate requires every feed file (gate-missing)", () => {
  const required = requiredDraftAssetNames();
  for (const name of LEGACY_FEED_FILES) assert.ok(required.includes(name));
  const release = { draft: true, prerelease: true, target_commitish: "abc" };
  const complete = requiredDraftAssetNames();
  assert.doesNotThrow(() =>
    assertDraftReleaseShape({
      release,
      assetNames: complete,
      version: "2.0.0-beta.1",
      headCommit: "abc",
    }),
  );
  assert.throws(
    () =>
      assertDraftReleaseShape({
        release,
        assetNames: complete.filter((name) => name !== "latest-mac.yml"),
        version: "2.0.0-beta.1",
        headCommit: "abc",
      }),
    /latest-mac\.yml/,
  );
});
