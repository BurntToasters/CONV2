const { spawnSync } = require('child_process');

const targetScript = process.argv[2];
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!targetScript || !targetScript.startsWith('release:')) {
  console.error('Usage: node build-scripts/release-beta.js <release:script>');
  process.exit(1);
}

const result = spawnSync(npmCommand, ['run', targetScript], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`Failed to run npm script "${targetScript}": ${result.error.message}`);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
