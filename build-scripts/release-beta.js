const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const targetScript = process.argv[2];
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const backupPath = path.join(__dirname, '..', 'build', 'index.html.bak');

if (!targetScript || !targetScript.startsWith('release:')) {
  console.error('Usage: node build-scripts/release-beta.js <release:script>');
  process.exit(1);
}

function runNpmScript(script, extraEnv = {}) {
  const result = spawnSync(npmCommand, ['run', script], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });

  if (result.error) {
    console.error(`Failed to run npm script "${script}": ${result.error.message}`);
    return 1;
  }

  if (typeof result.status !== 'number') {
    return 1;
  }

  return result.status;
}

const patchExitCode = runNpmScript('patch:beta');
if (patchExitCode !== 0) {
  process.exit(patchExitCode);
}

if (!fs.existsSync(backupPath)) {
  console.error('Beta patch completed but backup file was not created.');
  process.exit(1);
}

const releaseExitCode = runNpmScript(targetScript, { IS_BETA: 'true' });
const restoreExitCode = runNpmScript('restore:release');

if (releaseExitCode !== 0) {
  process.exit(releaseExitCode);
}

if (restoreExitCode !== 0) {
  process.exit(restoreExitCode);
}
