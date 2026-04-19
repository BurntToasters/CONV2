const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const repoRoot = path.join(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const xmlPath = path.join(repoRoot, 'com.burnttoasters.conv2.metainfo.xml');

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseXmlStrict(xml) {
  const parseErrors = [];
  const parser = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => parseErrors.push(message),
      fatalError: (message) => parseErrors.push(message),
    },
  });
  const doc = parser.parseFromString(xml, 'text/xml');
  if (parseErrors.length > 0 || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error(parseErrors.join('\n') || 'Invalid XML');
  }
  return doc;
}

if (!fs.existsSync(pkgPath)) {
  console.error(`✗ package.json not found at ${pkgPath}`);
  process.exit(1);
}

if (!fs.existsSync(xmlPath)) {
  console.error(`✗ AppStream metadata not found at ${xmlPath}`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (error) {
  console.error('✗ Failed to parse package.json');
  throw error;
}

const version = pkg.version;
if (!version) {
  console.error('✗ package.json has no version field');
  process.exit(1);
}

const dateStr = formatDate(new Date());
const xml = fs.readFileSync(xmlPath, 'utf8');

let doc;
try {
  doc = parseXmlStrict(xml);
} catch (err) {
  console.error(
    `✗ Invalid AppStream metadata XML: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

const releases = doc.getElementsByTagName('releases');
if (releases.length !== 1) {
  console.error('✗ AppStream metadata must contain exactly one <releases> section');
  process.exit(1);
}

const firstRelease = releases[0].getElementsByTagName('release')[0] || null;
const currentVersion = firstRelease ? firstRelease.getAttribute('version') : null;
const currentDate = firstRelease ? firstRelease.getAttribute('date') : null;
if (currentVersion === version && currentDate === dateStr) {
  console.log('✓ AppStream metadata already up to date');
  process.exit(0);
}

const releasesLineMatch = xml.match(/^(\s*)<releases>\s*$/m);
if (!releasesLineMatch) {
  console.error('✗ Could not find <releases> line in AppStream metadata');
  process.exit(1);
}
const baseIndent = releasesLineMatch[1] || '';
const releaseIndent = `${baseIndent}  `;
const replacementSection = `<releases>\n${releaseIndent}<release version="${version}" date="${dateStr}"/>\n${baseIndent}</releases>`;

const releasesSectionRegex = /<releases>[\s\S]*?<\/releases>/;
if (!releasesSectionRegex.test(xml)) {
  console.error('✗ Could not locate releases section in AppStream metadata');
  process.exit(1);
}

const updatedXml = xml.replace(releasesSectionRegex, replacementSection);
try {
  parseXmlStrict(updatedXml);
} catch (err) {
  console.error(
    `✗ Refusing to write invalid AppStream metadata: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

fs.writeFileSync(xmlPath, updatedXml, 'utf8');
console.log(`✓ Updated AppStream release to ${version} (${dateStr})`);
