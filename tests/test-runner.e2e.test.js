// Failure modes: truncated failure names, missing logs, CRLF checkout drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const scenarios = [];

test('failed commands expose the failing test and save the full output', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-runner-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(tmp, 'failure.js'),
    "console.log('✖ failing tests:'); console.log('test at fixture.test.js:1:1'); console.log('✖ named failure'); for(let i=0;i<30;i++) console.log('stack detail'); process.exit(1);\n"
  );
  const runner = path.join(ROOT, 'build-scripts', 'test-all.js');
  fs.writeFileSync(
    path.join(tmp, 'run.js'),
    `require(${JSON.stringify(runner)}).runCommand('unit', '\"' + process.execPath + '\" failure.js');\n`
  );
  const result = spawnSync(process.execPath, ['run.js'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /named failure/);
  assert.match(
    fs.readFileSync(path.join(tmp, 'coverage', 'test-all', 'unit.log'), 'utf8'),
    /named failure/
  );
  scenarios.push({ scenario: 'failure details and log', ok: true });
});

test('Windows-style Git checkout retains LF for formatted files', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-eol-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git(['init']);
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(tmp, '.gitattributes'));
  fs.writeFileSync(path.join(tmp, 'fixture.js'), 'const value = 1;\n');
  git(['add', '.']);
  fs.unlinkSync(path.join(tmp, 'fixture.js'));
  git(['-c', 'core.autocrlf=true', 'checkout-index', '-f', '-a']);
  assert.equal(fs.readFileSync(path.join(tmp, 'fixture.js'), 'utf8'), 'const value = 1;\n');
  scenarios.push({ scenario: 'LF checkout with autocrlf enabled', ok: true });
});

test('writes runner E2E artifact', () => {
  assert.equal(scenarios.length, 2);
  const artifact = path.join(ROOT, 'coverage', 'test-runner-e2e.json');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify({ scenarios }, null, 2) + '\n');
});
