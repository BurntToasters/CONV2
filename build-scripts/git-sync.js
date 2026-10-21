// Destructively resets the checkout to origin/<beta|main> for release VMs.
// Usage: node build-scripts/git-sync.js <beta|main> [--skip-install]
const { spawnSync } = require('node:child_process');

const TARGETS = new Set(['beta', 'main']);
const target = process.argv[2];
const skipInstall = process.argv.includes('--skip-install');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, env = process.env) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32' && command === npmCommand,
  });
  if (result.status !== 0) {
    console.error(`Command failed: ${command} ${args.join(' ')}`);
    process.exit(result.status || 1);
  }
}

async function main() {
  if (!TARGETS.has(target)) {
    console.error('Usage: node build-scripts/git-sync.js <beta|main> [--skip-install]');
    process.exit(1);
  }
  run('git', ['rev-parse', '--is-inside-work-tree']);
  run('git', ['fetch', 'origin']);

  run('git', ['reset', '--hard']);
  run('git', ['clean', '-fd']);
  run('git', ['switch', '-C', target, `origin/${target}`]);
  run('git', ['reset', '--hard', `origin/${target}`]);
  run('git', ['clean', '-fd']);

  if (skipInstall) return;
  run(npmCommand, ['run', 'vi']);
  if (target === 'main') run(npmCommand, ['run', 'gitprune:force']);
}

main().catch((error) => {
  console.error('git-sync failed:', error);
  process.exit(1);
});
