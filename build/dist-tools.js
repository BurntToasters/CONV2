const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createReleaseSession, verifyQualityGate } = require('../build-scripts/release-session');

const ROOT = path.resolve(__dirname, '..');
const FLATPAK_BUILD_DIR_PREFIX = 'build-dir';
const RENDERER_MODULES_DIR = path.join(ROOT, 'src', 'renderer', 'modules');
const RELEASE_BUILD_SESSION = '.build-session.json';

function listFlatpakBuildDirs() {
  try {
    return fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name === FLATPAK_BUILD_DIR_PREFIX ||
            entry.name.startsWith(`${FLATPAK_BUILD_DIR_PREFIX}-`))
      )
      .map((entry) => path.join(ROOT, entry.name));
  } catch {
    return [];
  }
}

function rmDir(fullPath, label) {
  try {
    fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log(`  Removed ${label}`);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    console.warn(`  Warning: failed to remove ${label}: ${error.message}`);
  }
}

function cleanRendererModuleArtifacts() {
  let entries;
  try {
    entries = fs.readdirSync(RENDERER_MODULES_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const stem = entry.name.slice(0, -3);
    for (const target of [`${stem}.js`, `${stem}.js.map`]) {
      const artifactPath = path.join(RENDERER_MODULES_DIR, target);
      try {
        fs.rmSync(artifactPath, { force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error) {
        if (error && error.code !== 'ENOENT') {
          console.warn(`  Warning: failed to remove ${target}: ${error.message}`);
        }
      }
    }
  }
}

function cleanBuildArtifacts() {
  console.log('[dist-tools] Cleaning build artifacts...');
  // The build session proves the quality gate for this commit and environment.
  // Later release steps verify it, so a rebuild inside the same release chain
  // must not invalidate it.
  const sessionPath = path.join(ROOT, 'release', RELEASE_BUILD_SESSION);
  let preservedSession = null;
  try {
    preservedSession = fs.readFileSync(sessionPath);
  } catch {
    preservedSession = null;
  }
  const dirs = [path.join(ROOT, 'release'), path.join(ROOT, 'dist'), ...listFlatpakBuildDirs()];
  for (const dir of dirs) {
    rmDir(dir, path.relative(ROOT, dir) + '/');
  }
  if (preservedSession !== null) {
    fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
    fs.writeFileSync(sessionPath, preservedSession, { mode: 0o600 });
  }
  cleanRendererModuleArtifacts();
  console.log('[dist-tools] Clean complete.');
}

function cleanReleaseArtifacts() {
  console.log('[dist-tools] Cleaning release artifacts...');
  // Refuse before deleting prior artifacts if the full quality gate was not
  // completed for this exact clean checkout and environment.
  verifyQualityGate(ROOT);
  const dirs = [path.join(ROOT, 'release'), path.join(ROOT, 'dist'), ...listFlatpakBuildDirs()];
  for (const dir of dirs) {
    rmDir(dir, path.relative(ROOT, dir) + '/');
  }
  cleanRendererModuleArtifacts();
  const releaseDir = path.join(ROOT, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(releaseDir, RELEASE_BUILD_SESSION),
    `${JSON.stringify(createReleaseSession(ROOT))}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  console.log('[dist-tools] Release session created for this clean commit.');
}

function copyRendererAssets() {
  console.log('[dist-tools] Copying renderer assets...');
  const srcDir = path.join(ROOT, 'src', 'renderer');
  const destDir = path.join(ROOT, 'dist', 'renderer');
  fs.mkdirSync(destDir, { recursive: true });
  const assets = ['index.html', 'fonts.css', 'main.css', 'settings.css'];
  for (const file of assets) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`  Copied ${file}`);
    } else {
      console.warn(`  Warning: ${file} not found in src/renderer/`);
    }
  }
  const fontsSrc = path.join(srcDir, 'fonts');
  const fontsDest = path.join(destDir, 'fonts');
  if (fs.existsSync(fontsSrc)) {
    fs.mkdirSync(fontsDest, { recursive: true });
    for (const fontFile of fs.readdirSync(fontsSrc)) {
      fs.copyFileSync(path.join(fontsSrc, fontFile), path.join(fontsDest, fontFile));
    }
    console.log('  Copied fonts/');
  }
  // Main-process files reached only through `import type` are emitted but never loaded.
  rmDir(path.join(destDir, 'js', 'main'), 'dist/renderer/js/main/ (type-only)');
  console.log('[dist-tools] Copy complete.');
}

function compile() {
  cleanBuildArtifacts();
  console.log('[dist-tools] Compiling TypeScript...');
  execSync('tsc -p tsconfig.json', { cwd: ROOT, stdio: 'inherit' });
  execSync('tsc -p tsconfig.renderer.json', { cwd: ROOT, stdio: 'inherit' });
  copyRendererAssets();
  console.log('[dist-tools] Compile complete.');
}

const mode = process.argv[2];

if (mode === 'clean') {
  cleanBuildArtifacts();
  process.exit(0);
}

if (mode === 'clean-release-artifacts') {
  cleanReleaseArtifacts();
  process.exit(0);
}

if (mode === 'copy') {
  copyRendererAssets();
  process.exit(0);
}

if (mode === 'compile') {
  compile();
  process.exit(0);
}

console.error('Usage: node build/dist-tools.js <clean|clean-release-artifacts|copy|compile>');
process.exit(1);
