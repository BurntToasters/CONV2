/**
 * dist-tools.js — Build helper for CONV2
 *
 * Usage:
 *   node build/dist-tools.js clean       — Remove /dist and /release directories
 *   node build/dist-tools.js copy        — Copy renderer assets (HTML/CSS) to dist/renderer
 *   node build/dist-tools.js compile     — Clean, run tsc, then copy assets (full rebuild)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function cleanBuildArtifacts() {
  console.log('[dist-tools] Cleaning build artifacts...');
  for (const dir of ['release', 'dist']) {
    const fullPath = path.join(ROOT, dir);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`  Removed ${dir}/`);
    } catch {
      // Ignore cleanup errors — locked files from a previous build are harmless.
    }
  }
  console.log('[dist-tools] Clean complete.');
}

function copyRendererAssets() {
  console.log('[dist-tools] Copying renderer assets...');
  const srcDir = path.join(ROOT, 'src', 'renderer');
  const destDir = path.join(ROOT, 'dist', 'renderer');

  fs.mkdirSync(destDir, { recursive: true });

  const assets = ['index.html', 'main.css', 'extra.css'];
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
  console.log('[dist-tools] Copy complete.');
}

function compile() {
  cleanBuildArtifacts();
  console.log('[dist-tools] Compiling TypeScript...');
  execSync('tsc', { cwd: ROOT, stdio: 'inherit' });
  copyRendererAssets();
  console.log('[dist-tools] Compile complete.');
}

const mode = process.argv[2];

if (mode === 'clean') {
  cleanBuildArtifacts();
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

console.error('Usage: node build/dist-tools.js <clean|copy|compile>');
process.exit(1);
