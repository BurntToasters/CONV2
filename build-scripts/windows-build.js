const { spawnSync } = require('child_process');
const path = require('path');

const { version } = require(path.join(__dirname, '..', 'package.json'));

const args = process.argv.slice(2);

let arch = 'all';
let publish = null;
let msiOnly = false;
let dryRun = false;

function usage() {
  console.error(
    'Usage: node build-scripts/windows-build.js [--arch all|x64|arm64] [--publish always|onTag|onTagOrDraft|never] [--msi-only] [--dry-run]'
  );
  process.exit(1);
}

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--arch') {
    const value = args[i + 1];
    if (value !== 'all' && value !== 'x64' && value !== 'arm64') {
      usage();
    }
    arch = value;
    i += 1;
    continue;
  }
  if (arg === '--publish') {
    const value = args[i + 1];
    if (!value) {
      usage();
    }
    publish = value;
    i += 1;
    continue;
  }
  if (arg === '--msi-only') {
    msiOnly = true;
    continue;
  }
  if (arg === '--dry-run') {
    dryRun = true;
    continue;
  }
  usage();
}

const isBetaVersion = /-beta\.\d+$/i.test(version);

if (msiOnly && isBetaVersion) {
  console.error(`Refusing MSI build for beta version "${version}". MSI requires numeric-only versioning.`);
  process.exit(1);
}

const targets = msiOnly ? ['msi'] : ['nsis', 'portable', ...(isBetaVersion ? [] : ['msi'])];

const electronBuilderArgs = ['electron-builder', '--win', ...targets];

if (arch === 'x64') {
  electronBuilderArgs.push('--x64');
} else if (arch === 'arm64') {
  electronBuilderArgs.push('--arm64');
} else {
  electronBuilderArgs.push('--arm64', '--x64');
}

if (publish) {
  electronBuilderArgs.push('--publish', publish);
}

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

console.log(
  `[windows-build] version=${version} beta=${isBetaVersion ? 'yes' : 'no'} targets=${targets.join(',')} arch=${arch}`
);

if (dryRun) {
  console.log(`[windows-build] dry-run command: ${npxCommand} ${electronBuilderArgs.join(' ')}`);
  process.exit(0);
}

const result = spawnSync(npxCommand, electronBuilderArgs, {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
