// Shared fixtures for the release E2E suites (verify, publish). Not a test file.
// Mirrors the real CONV2 Electron release matrix observed on GitHub:
// beta = 11 installers, stable adds 2 MSI (windows-build refuses MSI for beta).
// Updater feeds are the four latest*.yml files; each carries version + sha512.
const crypto = require('node:crypto');

const WIN_INSTALLERS = [
  'CONV2-Win-Setup.exe',
  'CONV2-Win-x64-Setup.exe',
  'CONV2-Win-arm64-Setup.exe',
  'CONV2-Win-Portable.exe',
  'CONV2-Win-x64-Portable.exe',
  'CONV2-Win-arm64-Portable.exe',
];
const MAC_INSTALLERS = ['CONV2-macOS-universal.dmg', 'CONV2-macOS-universal.zip'];
const LINUX_X64_INSTALLERS = [
  'CONV2-Linux-x86_64.AppImage',
  'CONV2-Linux-amd64.deb',
  'CONV2-Linux-x86_64.rpm',
];
const LINUX_ARM64_INSTALLERS = [
  'CONV2-Linux-arm64.AppImage',
  'CONV2-Linux-arm64.deb',
  'CONV2-Linux-aarch64.rpm',
];
const MSI_INSTALLERS = ['CONV2-Win-x64.msi', 'CONV2-Win-arm64.msi'];
const BLOCKMAP_NAMES = [
  'CONV2-Win-Setup.exe.blockmap',
  'CONV2-Win-x64-Setup.exe.blockmap',
  'CONV2-Win-arm64-Setup.exe.blockmap',
  'CONV2-macOS-universal.dmg.blockmap',
  'CONV2-macOS-universal.zip.blockmap',
];
const CHECKSUM_NAMES = ['SHA256SUMS-Windows.txt', 'SHA256SUMS-macOS.txt', 'SHA256SUMS-Linux.txt'];

// Feed -> [feed file, default path, referenced installer files].
const FEED_MAP = {
  'latest.yml': [
    'CONV2-Win-Setup.exe',
    ['CONV2-Win-Setup.exe', 'CONV2-Win-x64-Setup.exe', 'CONV2-Win-arm64-Setup.exe'],
  ],
  'latest-mac.yml': [
    'CONV2-macOS-universal.dmg',
    ['CONV2-macOS-universal.dmg', 'CONV2-macOS-universal.zip'],
  ],
  'latest-linux.yml': [
    'CONV2-Linux-x86_64.AppImage',
    ['CONV2-Linux-x86_64.AppImage', 'CONV2-Linux-amd64.deb', 'CONV2-Linux-x86_64.rpm'],
  ],
  'latest-linux-arm64.yml': [
    'CONV2-Linux-arm64.AppImage',
    ['CONV2-Linux-arm64.AppImage', 'CONV2-Linux-arm64.deb', 'CONV2-Linux-aarch64.rpm'],
  ],
};

function installers({ stable = false, arm64 = false } = {}) {
  const names = [...WIN_INSTALLERS, ...MAC_INSTALLERS, ...LINUX_X64_INSTALLERS];
  if (arm64) names.push(...LINUX_ARM64_INSTALLERS);
  if (stable) names.push(...MSI_INSTALLERS);
  return names;
}

function feedNames({ arm64 = false } = {}) {
  const names = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];
  if (arm64) names.push('latest-linux-arm64.yml');
  return names;
}

// Full required draft asset list for the verify gate.
function requiredAssetNames({ stable = false, arm64 = false } = {}) {
  const list = [...installers({ stable, arm64 })];
  for (const name of installers({ stable, arm64 })) list.push(name + '.asc');
  list.push(...BLOCKMAP_NAMES);
  list.push(...CHECKSUM_NAMES);
  for (const name of CHECKSUM_NAMES) list.push(name + '.asc');
  list.push(...feedNames({ arm64 }));
  return [...new Set(list)].sort();
}

// Deterministic fixture bytes so the fake GitHub serves exactly what the yml hashes.
function fixtureBytes(name) {
  return `fixture-bytes-for:${name}\n`;
}

function sha512Base64(text) {
  return crypto.createHash('sha512').update(text).digest('base64');
}

function buildFeedYml(feedName, version) {
  const [defaultPath, files] = FEED_MAP[feedName];
  const lines = [`version: ${version}`, 'files:'];
  for (const file of files) {
    const bytes = fixtureBytes(file);
    lines.push(
      `  - url: ${file}`,
      `    sha512: ${sha512Base64(bytes)}`,
      `    size: ${Buffer.byteLength(bytes)}`
    );
  }
  lines.push(
    `path: ${defaultPath}`,
    `sha512: ${sha512Base64(fixtureBytes(defaultPath))}`,
    `releaseDate: '2026-10-04T00:00:00.000Z'`
  );
  return lines.join('\n') + '\n';
}

// Fake `gh`: paginated release list, asset list, raw asset downloads with
// deterministic bytes, release PATCH, tag refs, /releases/latest.
// Configure through env: FAKE_GH_STATE (releases), FAKE_GH_TAMPER (name->bytes),
// FAKE_GH_TAG_SHA (sha for git ref lookup, or MISSING for 404), FAKE_GH_LATEST.
const FAKE_GH_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const callsPath = process.env.FAKE_GH_CALLS;
const statePath = process.env.FAKE_GH_STATE;
const readState = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { releases: [] });
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const tamper = process.env.FAKE_GH_TAMPER ? JSON.parse(process.env.FAKE_GH_TAMPER) : {};
const bytesFor = (name) => (tamper[name] !== undefined ? tamper[name] : 'fixture-bytes-for:' + name + '\\n');
if (args[0] === 'auth') {
  if (args[1] === 'token') process.stdout.write(process.env.FAKE_GH_TOKEN || 'fake-token');
  process.exit(0);
}
fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
const mi = args.indexOf('--method');
const method = mi === -1 ? 'GET' : args[mi + 1];
const endpoint = mi === -1 ? args[1] : args[mi + 2];
const state = readState();
const query = (key) => {
  const m = String(endpoint).match(new RegExp('[?&]' + key + '=(\\\\d+)'));
  return m ? Number(m[1]) : null;
};
if (method === 'GET' && endpoint.includes('/releases/tags/')) {
  const tag = endpoint.split('/releases/tags/')[1].split('?')[0];
  const found = state.releases.find((r) => r.tag_name === tag && !r.draft);
  if (!found) { process.stderr.write('HTTP 404: Not Found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(found)); process.exit(0);
}
if (method === 'GET' && endpoint.includes('/releases/latest')) {
  if (!state.latest) { process.stderr.write('HTTP 404: Not Found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(state.latest)); process.exit(0);
}
if (method === 'GET' && endpoint.includes('/git/ref/tags/')) {
  if (!process.env.FAKE_GH_TAG_SHA) { process.stderr.write('HTTP 404: Not Found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ object: { type: 'commit', sha: process.env.FAKE_GH_TAG_SHA } }));
  process.exit(0);
}
if (method === 'GET' && /\\/releases\\/\\d+\\/assets/.test(endpoint.split('?')[0])) {
  const id = Number(endpoint.split('/releases/')[1].split('/')[0]);
  const release = state.releases.find((r) => r.id === id);
  const names = (release && release.assetNames) || [];
  const assets = names.map((name, i) => ({ id: 1000 + i, name, size: Buffer.byteLength(bytesFor(name)) }));
  const perPage = query('per_page') || 100;
  const page = query('page') || 1;
  process.stdout.write(JSON.stringify(assets.slice((page - 1) * perPage, page * perPage)));
  process.exit(0);
}
if (method === 'GET' && /\\/releases\\/assets\\/\\d+/.test(endpoint.split('?')[0])) {
  const id = Number(endpoint.split('/releases/assets/')[1].split('?')[0]);
  const names = [];
  for (const r of state.releases) names.push(...((r && r.assetNames) || []));
  const name = names[id - 1000];
  if (!name) { process.stderr.write('HTTP 404: Not Found\\n'); process.exit(1); }
  if (state.feeds && state.feeds[name] !== undefined) { process.stdout.write(state.feeds[name]); process.exit(0); }
  process.stdout.write(bytesFor(name)); process.exit(0);
}
if (method === 'GET' && endpoint.includes('/releases?')) {
  const perPage = query('per_page') || 100;
  const page = query('page') || 1;
  const slim = state.releases.map((r) => {
    const copy = { ...r };
    delete copy.assetNames;
    return copy;
  });
  process.stdout.write(JSON.stringify(slim.slice((page - 1) * perPage, page * perPage)));
  process.exit(0);
}
if (method === 'PATCH' && /\\/releases\\/\\d+/.test(endpoint.split('?')[0])) {
  const id = Number(endpoint.split('/releases/')[1].split('?')[0]);
  const release = state.releases.find((r) => r.id === id);
  if (!release) { process.stderr.write('fake gh: unknown release\\n'); process.exit(1); }
  let body = {};
  if (args.includes('--input')) body = JSON.parse(fs.readFileSync(0, 'utf8'));
  Object.assign(release, body);
  writeState(state);
  const copy = { ...release };
  delete copy.assetNames;
  process.stdout.write(JSON.stringify(copy)); process.exit(0);
}
process.stderr.write('fake gh: unhandled ' + args.join(' ') + '\\n'); process.exit(1);
`;

module.exports = {
  BLOCKMAP_NAMES,
  CHECKSUM_NAMES,
  FAKE_GH_SOURCE,
  FEED_MAP,
  feedNames,
  fixtureBytes,
  installers,
  buildFeedYml,
  requiredAssetNames,
  sha512Base64,
};
