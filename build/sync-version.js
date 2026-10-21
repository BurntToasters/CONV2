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
  const syncedDownloads = downloadsSection.replace(
    /\/releases\/download\/v[^/]+\//g,
    `/releases/download/${tag}/`
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
  syncNpmLockfileVersion,
  syncVersion,
};
