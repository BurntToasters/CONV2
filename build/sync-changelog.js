const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

if (!fs.existsSync(pkgPath)) {
  console.error(`Error: package.json not found at ${pkgPath}`);
  process.exit(1);
}

if (!fs.existsSync(changelogPath)) {
  console.error(`Error: CHANGELOG.md not found at ${changelogPath}`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (error) {
  console.error('Error: failed to parse package.json');
  throw error;
}

const version = pkg.version;
if (!version) {
  console.error('Error: package.json has no version field');
  process.exit(1);
}

const tag = `v${version}`;
const sectionHeading = `## Changes in \`${tag}:\``;
const changelog = fs.readFileSync(changelogPath, 'utf8');
const downloadsHeading = changelog.match(/^# .*Downloads\s*$/m);
const firstChangesHeading = changelog.search(/^## Changes in /m);

if (
  !downloadsHeading ||
  downloadsHeading.index === undefined ||
  firstChangesHeading === -1 ||
  firstChangesHeading <= downloadsHeading.index
) {
  console.error('Error: CHANGELOG.md download section markers not found');
  process.exit(1);
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

if (updated === changelog) {
  console.log(`CHANGELOG.md already matches ${version}`);
  process.exit(0);
}

fs.writeFileSync(changelogPath, updated, 'utf8');
console.log(`Updated CHANGELOG.md to ${version} (download URLs + section)`);
