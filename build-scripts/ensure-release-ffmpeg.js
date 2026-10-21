// Release VMs refresh a bad or missing payload, then verify the replacement.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const TARGET = /^(?:win|mac|linux):(?:x64|arm64)$/;

function usage() {
  console.error(
    'Usage: node build-scripts/ensure-release-ffmpeg.js --all | --target <platform:arch>...'
  );
  process.exit(1);
}

function releaseArgs(args) {
  if (args.length === 1 && args[0] === '--all') {
    return args;
  }
  if (args.length === 0 || args.length % 2 !== 0) {
    usage();
  }
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--target' || !TARGET.test(args[i + 1] || '')) {
      usage();
    }
  }
  return args;
}

function runNode(scriptName, args) {
  const result = spawnSync(process.execPath, [path.join('build-scripts', scriptName), ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

function main() {
  const args = releaseArgs(process.argv.slice(2));
  if (runNode('check-ffmpeg.js', ['--require-checksums', ...args]) === 0) {
    return;
  }

  console.error(
    '[release-ffmpeg] Checksum verification failed. Downloading FFmpeg and re-checking.'
  );
  const downloadStatus = runNode('get-ffmpeg.js', args);
  if (downloadStatus !== 0) {
    process.exit(downloadStatus);
  }
  process.exit(runNode('check-ffmpeg.js', ['--require-checksums', ...args]));
}

if (require.main === module) {
  main();
}

module.exports = { releaseArgs };
