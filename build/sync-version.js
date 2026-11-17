'use strict';

// Synchronize release metadata from package.json, the version source of truth.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function syncNpmLockfileVersion(lockText, version) {
  let parsed;
  try {
    parsed = JSON.parse(lockText);
  } catch (error) {
    throw new Error(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('package-lock.json root must be an object');
  }
  if (!parsed.packages || typeof parsed.packages !== 'object') {
    throw new Error('package-lock.json is missing packages');
  }
  if (!parsed.packages[''] || typeof parsed.packages[''] !== 'object') {
    throw new Error('package-lock.json is missing packages[""]');
  }
  if (parsed.version === version && parsed.packages[''].version === version) {
    return lockText;
  }

  parsed.version = version;
  parsed.packages[''].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// The "This is a Beta" callout, live or wrapped in an HTML comment.
const BETA_NOTE = /(?:<!--\n)?(> \[!NOTE\][^\n]*\n> [^\n]*This is a Beta[^\n]*\n)(?:-->\n)?/;

/** Live beta note for prereleases, commented out for stable versions. */
function setBetaNote(downloadsSection, version) {
  const isBeta = version.includes('-');
  return downloadsSection.replace(BETA_NOTE, (_match, note) =>
    isBeta ? note : `<!--\n${note}-->\n`
  );
}

function syncChangelogForVersion(changelog, version) {
  const tag = `v${version}`;
  const sectionHeading = `## Changes in \`${tag}:\``;
  const downloadsHeading = changelog.match(/^# .*Downloads\s*$/m);
  const firstChangesHeading = changelog.search(/^## Changes in /m);

  if (
    !downloadsHeading ||
    downloadsHeading.index === undefined ||
    firstChangesHeading === -1 ||
    firstChangesHeading <= downloadsHeading.index
  ) {
    throw new Error('CHANGELOG.md download and release markers not found');
  }

  const beforeDownloads = changelog.slice(0, downloadsHeading.index);
  const downloadsSection = changelog.slice(downloadsHeading.index, firstChangesHeading);
  const afterDownloads = changelog.slice(firstChangesHeading);
  const syncedDownloads = setBetaNote(
    downloadsSection.replace(/\/releases\/download\/v[^/]+\//g, `/releases/download/${tag}/`),
    version
  );

  let updated = beforeDownloads + syncedDownloads + afterDownloads;
  if (!updated.includes(sectionHeading)) {
    const insertionPoint = updated.search(/^## Changes in /m);
    updated =
      updated.slice(0, insertionPoint) +
      `${sectionHeading}\n\n- **Fix:** (add release notes)\n\n` +
      updated.slice(insertionPoint);
  }

  return updated;
}

const METAINFO_FILE = 'com.burnttoasters.conv2.metainfo.xml';

function localDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** One-entry releases section, same shape as build/update-metainfo.js writes. */
function syncMetainfoVersion(xml, version, date = new Date()) {
  const releasesLine = xml.match(/^(\s*)<releases>\s*$/m);
  const section = /<releases>[\s\S]*?<\/releases>/;
  if (!releasesLine || !section.test(xml)) {
    throw new Error(`${METAINFO_FILE} has no <releases> section`);
  }
  const current = xml.match(/<release\b[^>]*\bversion="([^"]+)"/);
  // Keep the existing date; update-metainfo.js stamps the real one at release.
  if (current && current[1] === version) return xml;
  const indent = releasesLine[1];
  return xml.replace(
    section,
    `<releases>\n${indent}  <release version="${version}" date="${localDate(date)}"/>\n${indent}</releases>`
  );
}

function readPackageVersion() {
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error(`package.json not found at ${packagePath}`);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!packageJson || typeof packageJson.version !== 'string' || !packageJson.version) {
    throw new Error('package.json has no version field');
  }
  return packageJson.version;
}

function updateFile(fileName, transform) {
  const filePath = path.join(root, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${fileName} not found at ${filePath}`);
  }

  const current = fs.readFileSync(filePath, 'utf8');
  const updated = transform(current);
  if (updated === current) return false;

  fs.writeFileSync(filePath, updated, 'utf8');
  return true;
}

function syncVersion() {
  const version = readPackageVersion();
  const changed = [];

  if (updateFile('CHANGELOG.md', (content) => syncChangelogForVersion(content, version))) {
    changed.push(`CHANGELOG.md → ${version}`);
  }
  if (updateFile('package-lock.json', (content) => syncNpmLockfileVersion(content, version))) {
    changed.push(`package-lock.json → ${version}`);
  }
  if (updateFile(METAINFO_FILE, (content) => syncMetainfoVersion(content, version))) {
    changed.push(`${METAINFO_FILE} → ${version}`);
  }

  if (changed.length === 0) {
    console.log(`Version metadata already matches ${version}`);
  } else {
    for (const message of changed) console.log(message);
  }
  return { version, changed };
}

if (require.main === module) {
  try {
    syncVersion();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  syncChangelogForVersion,
  syncMetainfoVersion,
  syncNpmLockfileVersion,
  syncVersion,
};
