const { spawnSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const checks = [
  { key: 'format', label: 'Format', args: ['run', 'format:check'] },
  { key: 'typecheck', label: 'TypeCheck', args: ['run', 'typecheck'] },
  { key: 'build', label: 'Build', args: ['run', 'build'] },
  { key: 'tests', label: 'Tests', args: ['run', 'tests:node'] },
];

const results = {};

for (const check of checks) {
  console.log(`${colors.blue}${colors.bold}Running ${check.label}...${colors.reset}`);
  const run = spawnSync(npmCommand, check.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  const passed = !run.error && run.status === 0;
  results[check.key] = passed ? 'passed' : 'failed';
  if (passed) {
    console.log(`${colors.green}✓ ${check.label} passed${colors.reset}\n`);
  } else {
    const reason = run.error
      ? run.error.message
      : run.status === null
        ? `signal ${run.signal || 'unknown'}`
        : `exit code ${run.status}`;
    console.log(`${colors.red}✗ ${check.label} failed (${reason})${colors.reset}\n`);
  }
}

console.log(`${colors.bold}${colors.blue}Summary${colors.reset}`);
for (const check of checks) {
  const status =
    results[check.key] === 'passed'
      ? `${colors.green}PASS${colors.reset}`
      : `${colors.red}FAIL${colors.reset}`;
  console.log(`${check.label}: ${status}`);
}

const hasFailure = Object.values(results).some((status) => status !== 'passed');
process.exit(hasFailure ? 1 : 0);
