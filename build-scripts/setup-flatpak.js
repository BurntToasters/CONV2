const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

const RUNTIME_VERSION = '24.08';
const ARCHS = ['x86_64', 'aarch64'];

if (process.platform !== 'linux') {
  console.error('Flatpak setup can only run on Linux.');
  process.exit(1);
}

const FLATPAK_RUNTIMES = [
  'org.freedesktop.Platform',
  'org.freedesktop.Sdk',
  'org.electronjs.Electron2.BaseApp',
];

const SDK_EXTENSIONS = ['org.freedesktop.Sdk.Extension.node22'];

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
    return true;
  } catch {
    if (!opts.allowFail) {
      console.error(`Command failed: ${cmd}`);
      process.exit(1);
    }
    return false;
  }
}

function runSilent(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function detectDistro() {
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf-8');
    const idMatch = release.match(/^ID=(.+)$/m);
    const id = idMatch ? idMatch[1].replace(/"/g, '') : '';

    const idLikeMatch = release.match(/^ID_LIKE=(.+)$/m);
    const idLike = idLikeMatch ? idLikeMatch[1].replace(/"/g, '') : '';

    if (
      id === 'ubuntu' ||
      id === 'debian' ||
      idLike.includes('ubuntu') ||
      idLike.includes('debian')
    ) {
      return 'debian';
    }
    if (id === 'fedora' || id === 'rhel' || id === 'centos' || idLike.includes('fedora')) {
      return 'fedora';
    }
    if (id === 'arch' || idLike.includes('arch')) {
      return 'arch';
    }
    return id || 'unknown';
  } catch {
    return 'unknown';
  }
}

function checkRoot() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    console.error('This script must be run with sudo/root privileges to install system packages.');
    console.error('Usage: sudo node build-scripts/setup-flatpak.js');
    process.exit(1);
  }
}

function installSystemPackages(distro) {
  console.log(`\nDetected distribution family: ${distro}`);
  console.log('Installing system packages...\n');

  switch (distro) {
    case 'debian':
      run('apt-get update');
      run('apt-get install -y flatpak flatpak-builder qemu-user-static binfmt-support');
      break;
    case 'fedora':
      run('dnf install -y flatpak flatpak-builder qemu-user-static qemu-user-binfmt');
      break;
    case 'arch':
      run(
        'pacman -S --needed --noconfirm flatpak flatpak-builder qemu-user-static qemu-user-static-binfmt'
      );
      break;
    default:
      console.error(
        `Unsupported distribution: ${distro}. Please install flatpak, flatpak-builder, and qemu-user-static manually.`
      );
      process.exit(1);
  }
}

function setupFlathub() {
  console.log('\nConfiguring Flathub repository...\n');
  run('flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo');
}

function installFlatpakRuntimes() {
  console.log('\nInstalling Flatpak runtimes and SDKs for all architectures...\n');

  for (const arch of ARCHS) {
    console.log(`\n--- Architecture: ${arch} ---\n`);

    for (const runtime of FLATPAK_RUNTIMES) {
      console.log(`Installing ${runtime}//${RUNTIME_VERSION} (${arch})...`);
      run(`flatpak install -y --arch=${arch} flathub ${runtime}//${RUNTIME_VERSION}`);
    }

    for (const ext of SDK_EXTENSIONS) {
      console.log(`Installing ${ext}//${RUNTIME_VERSION} (${arch})...`);
      run(`flatpak install -y --arch=${arch} flathub ${ext}//${RUNTIME_VERSION}`);
    }
  }
}

function verifyInstallation() {
  console.log('\n--- Verification ---\n');

  const flatpakVersion = runSilent('flatpak --version');
  const builderVersion = runSilent('flatpak-builder --version');
  const qemuCheck = runSilent('which qemu-aarch64-static') || runSilent('which qemu-x86_64-static');

  console.log(`flatpak: ${flatpakVersion || 'NOT FOUND'}`);
  console.log(`flatpak-builder: ${builderVersion || 'NOT FOUND'}`);
  console.log(`qemu-user-static: ${qemuCheck ? 'installed' : 'NOT FOUND'}`);
  if (!flatpakVersion || !builderVersion) {
    console.error('\nFlatpak tooling verification failed.');
    process.exit(1);
  }
  if (!qemuCheck) {
    console.error('\nqemu-user-static is required for cross-architecture builds.');
    process.exit(1);
  }

  const hostArch = os.arch() === 'x64' ? 'x86_64' : 'aarch64';
  const crossArch = hostArch === 'x86_64' ? 'aarch64' : 'x86_64';

  console.log(`\nHost architecture: ${hostArch}`);
  console.log(`Cross-build architecture: ${crossArch}`);

  console.log('\nInstalled Flatpak runtimes:\n');
  run('flatpak list --runtime --columns=application,arch,branch');

  const installedOutput = runSilent('flatpak list --runtime --columns=application,arch,branch');
  const installed = new Set(
    installedOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 3)
      .map((parts) => `${parts[0]}|${parts[1]}|${parts[2]}`)
  );
  const requiredIds = [...FLATPAK_RUNTIMES, ...SDK_EXTENSIONS];
  const missing = [];
  for (const arch of ARCHS) {
    for (const id of requiredIds) {
      const key = `${id}|${arch}|${RUNTIME_VERSION}`;
      if (!installed.has(key)) {
        missing.push(`${id}//${RUNTIME_VERSION} (${arch})`);
      }
    }
  }
  if (missing.length > 0) {
    console.error('\nMissing Flatpak runtimes/extensions after setup:');
    for (const entry of missing) {
      console.error(`- ${entry}`);
    }
    process.exit(1);
  }
}

function main() {
  console.log('=== CONV2 Flatpak Build Environment Setup ===\n');

  checkRoot();

  const distro = detectDistro();
  installSystemPackages(distro);
  setupFlathub();
  installFlatpakRuntimes();
  verifyInstallation();

  console.log('\nSetup complete. You can now build Flatpak packages with:');
  console.log('  npm run flatpak:bundle         (both architectures)');
  console.log('  npm run flatpak:bundle:x64      (x86_64 only)');
  console.log('  npm run flatpak:bundle:arm64    (aarch64 only)');
}

main();
