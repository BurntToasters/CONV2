const { spawnSync } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Windows needs a shell to run npm.cmd, so only plain release:* names reach it.
const isReleaseScriptName = (name) =>
  typeof name === 'string' && /^release:[a-z0-9:-]+$/.test(name);

function main() {
  const targetScript = process.argv[2];
  if (!isReleaseScriptName(targetScript)) {
    console.error('Usage: node build-scripts/release-beta.js <release:script>');
    process.exit(1);
  }

  const result = spawnSync(npmCommand, ['run', targetScript], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`Failed to run npm script "${targetScript}": ${result.error.message}`);
    process.exit(1);
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

if (require.main === module) {
  main();
}

module.exports = { isReleaseScriptName };
