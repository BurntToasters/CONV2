// Verifies a packaged app.asar ships every runtime asset and nothing build-only.
// CLI: node build-scripts/verify-package-contents.js [release-dir] -> writes coverage/e2e report.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSET_REF_PATTERN = /(?:\.\.\/)+(assets\/[\w./-]+\.(?:png|svg|ico))/g;
const RENDERER_EXTENSIONS = new Set(['.html', '.css', '.ts']);
const FORBIDDEN = [
  { pattern: /\.map$/, reason: 'source map' },
  { pattern: /^assets\/conv2\.icns$/, reason: 'build-only macOS icon' },
  { pattern: /^assets\/conv2\.iconset\//, reason: 'build-only icon source' },
];

function collectRendererAssetRefs(rendererDir) {
  const refs = new Set();
  for (const name of fs.readdirSync(rendererDir)) {
    if (!RENDERER_EXTENSIONS.has(path.extname(name))) continue;
    const source = fs.readFileSync(path.join(rendererDir, name), 'utf8');
    for (const match of source.matchAll(ASSET_REF_PATTERN)) refs.add(match[1]);
  }
  return [...refs].sort();
}

const normalizeEntry = (entry) => entry.replace(/\\/g, '/').replace(/^\/+/, '');

function verifyPackageEntries(rawEntries, { mainEntry, referencedAssets, requiredFiles = [] }) {
  const entries = new Set(rawEntries.map(normalizeEntry));
  const errors = [];
  if (entries.size === 0) return ['package is empty'];

  for (const file of [mainEntry, ...requiredFiles]) {
    if (!entries.has(file)) errors.push(`missing required file: ${file}`);
  }
  for (const asset of referencedAssets) {
    if (!entries.has(asset)) errors.push(`missing renderer asset: ${asset}`);
  }

  const referenced = new Set(referencedAssets);
  for (const entry of entries) {
    if (entry.startsWith('assets/twemoji/') && entry.endsWith('.svg') && !referenced.has(entry)) {
      errors.push(`unreferenced twemoji shipped: ${entry}`);
    }
    const forbidden = FORBIDDEN.find(({ pattern }) => pattern.test(entry));
    if (forbidden) errors.push(`${forbidden.reason} shipped: ${entry}`);
  }
  return errors;
}

function findAsarFiles(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) found.push(...findAsarFiles(full));
    else if (dirent.name === 'app.asar') found.push(full);
  }
  return found;
}

function runCli(releaseDir) {
  const asar = require('@electron/asar');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const referencedAssets = collectRendererAssetRefs(path.join(ROOT, 'src', 'renderer'));
  const asarFiles = findAsarFiles(releaseDir);
  const report = { at: new Date().toISOString(), releaseDir, referencedAssets, packages: [] };
  let failed = asarFiles.length === 0;
  if (failed) console.error(`No app.asar found under ${releaseDir}`);

  for (const asarPath of asarFiles) {
    const entries = asar.listPackage(asarPath, { isPack: false });
    const isWindows = fs.existsSync(path.join(path.dirname(asarPath), '..', 'CONV2.exe'));
    const errors = verifyPackageEntries(entries, {
      mainEntry: pkg.main,
      referencedAssets,
      requiredFiles: [
        'dist/main/preload.js',
        'dist/renderer/index.html',
        'licenses.json',
        ...(isWindows ? ['assets/icon.ico'] : []),
      ],
    });
    report.packages.push({
      asar: path.relative(ROOT, asarPath),
      bytes: fs.statSync(asarPath).size,
      entryCount: entries.length,
      twemojiCount: entries.filter((e) => normalizeEntry(e).startsWith('assets/twemoji/')).length,
      errors,
    });
    if (errors.length > 0) failed = true;
  }

  const outDir = path.join(ROOT, 'coverage', 'e2e');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'package-contents.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  for (const pkgReport of report.packages) {
    const status = pkgReport.errors.length === 0 ? 'OK' : 'FAIL';
    console.log(
      `${status} ${pkgReport.asar} (${pkgReport.entryCount} entries, ${pkgReport.bytes} bytes)`
    );
    for (const error of pkgReport.errors) console.error(`  ${error}`);
  }
  console.log(`Report: ${path.relative(ROOT, outFile)}`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  process.exit(runCli(path.resolve(process.argv[2] || path.join(ROOT, 'release'))));
}

module.exports = { collectRendererAssetRefs, verifyPackageEntries, findAsarFiles };
