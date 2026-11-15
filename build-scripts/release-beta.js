const { spawnSync } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Windows needs a shell to run npm.cmd, so only plain release:* names reach it.
const isReleaseScriptName = (name) =>
  typeof name === 'string' && /^release:[a-z0-9:-]+$/.test(name);

// Extra flags (e.g. --skip-check) go after `--` so npm hands them to the script.
// Windows passes these through a shell, so only plain --flag tokens are allowed.
function npmRunArgs(script, extra) {
  const bad = extra.filter((arg) => !/^--[a-z][a-z0-9-]*$/.test(arg));
  if (bad.length > 0) throw new Error(`Refusing release flag: ${bad.join(' ')}`);
  return extra.length > 0 ? ['run', script, '--', ...extra] : ['run', script];
}

function main() {
  const targetScript = process.argv[2];
  if (!isReleaseScriptName(targetScript)) {
    console.error('Usage: node build-scripts/release-beta.js <release:script>');
    return 1;
  }

  let args;
  try {
    args = npmRunArgs(targetScript, process.argv.slice(3));
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const result = spawnSync(npmCommand, args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`Failed to run npm script "${targetScript}": ${result.error.message}`);
    return 1;
  }

  return typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { isReleaseScriptName, npmRunArgs };
