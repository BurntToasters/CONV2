// Release runner: `npm run release:<target> -- --skip-check`, same contract as S3 Sidekick and Zinnia.
// Failure modes covered here:
//  1. An unknown flag, an unknown target, or two targets runs release steps anyway.
//  2. --skip-check is honored on a stable version.
//  3. --skip-check works without the ALLOW_RELEASE_SKIP_CHECK=1 confirmation.
//  4. FORCE_UPLOAD reaches the prepare steps (their tests would run with the bypass on).
//  5. FORCE_UPLOAD is not set on the continue step, so --skip-check does nothing.
//  6. A failing step does not stop the run, or its exit code is lost.
//  7. package.json wiring drifts: a flag never reaches the runner, a continue script
//     repeats prepare work, or a draft creator and a draft waiter swap roles.
//  8. A stable run with an exported FORCE_UPLOAD sits through prepare before the draft step refuses it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'build-scripts', 'run-release.js');
const scripts = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
const runner = () => require('../build-scripts/run-release.js');

const BETA = '9.9.9-beta.1';
const ALLOW = { ALLOW_RELEASE_SKIP_CHECK: '1' };

function record(argv, { env = {}, version = BETA, failAt = -1 } = {}) {
  const steps = [];
  const status = runner().main(argv, {
    env,
    version,
    run: (step) => {
      steps.push(step);
      return steps.length - 1 === failAt ? 7 : 0;
    },
  });
  return { status, steps };
}

test('unknown flags, unknown targets, and extra targets are refused', () => {
  const { parseReleaseArgs } = runner();
  assert.throws(() => parseReleaseArgs(['linux', '--skip-checks']), /Unknown release flag/);
  assert.throws(() => parseReleaseArgs(['linux', '--force']), /Unknown release flag/);
  assert.throws(() => parseReleaseArgs(['beos']), /Usage/);
  assert.throws(() => parseReleaseArgs([]), /Usage/);
  assert.throws(() => parseReleaseArgs(['linux', 'mac']), /Usage/);
  assert.equal(parseReleaseArgs(['linux', '--skip-check']).skipCheck, true);
  assert.equal(parseReleaseArgs(['linux']).skipCheck, false);
});

test('--skip-check needs a beta version and an explicit confirmation', () => {
  const { assertSkipCheckAllowed } = runner();
  assert.equal(assertSkipCheckAllowed(false, { env: {}, version: '1.7.0' }), false);
  assert.throws(
    () => assertSkipCheckAllowed(true, { env: ALLOW, version: '1.7.0' }),
    /stable release/
  );
  assert.throws(
    () => assertSkipCheckAllowed(true, { env: {}, version: BETA }),
    /ALLOW_RELEASE_SKIP_CHECK=1/
  );
  assert.throws(
    () => assertSkipCheckAllowed(true, { env: { ALLOW_RELEASE_SKIP_CHECK: '0' }, version: BETA }),
    /ALLOW_RELEASE_SKIP_CHECK=1/
  );
  assert.equal(assertSkipCheckAllowed(true, { env: ALLOW, version: BETA }), true);
});

function refusedBeforeAnyStep(argv, options, pattern) {
  let calls = 0;
  assert.throws(
    () =>
      runner().main(argv, {
        ...options,
        run: () => {
          calls += 1;
          return 0;
        },
      }),
    pattern
  );
  assert.equal(calls, 0, `${argv.join(' ')} ran ${calls} step(s) before refusing`);
}

test('refused runs execute no steps', () => {
  refusedBeforeAnyStep(['linux', '--bogus'], { env: {}, version: BETA }, /Unknown release flag/);
  refusedBeforeAnyStep(['beos'], { env: {}, version: BETA }, /Usage/);
  refusedBeforeAnyStep(
    ['linux', '--skip-check'],
    { env: {}, version: BETA },
    /ALLOW_RELEASE_SKIP_CHECK=1/
  );
  refusedBeforeAnyStep(
    ['linux', '--skip-check'],
    { env: ALLOW, version: '1.7.0' },
    /stable release/
  );
});

test('stable runs refuse inherited release overrides before prepare', () => {
  refusedBeforeAnyStep(
    ['linux'],
    { env: { FORCE_UPLOAD: '1' }, version: '1.7.0' },
    /refuses FORCE_UPLOAD/
  );
  // Beta keeps the inherited flag as a manual recovery path.
  assert.equal(record(['linux'], { env: { FORCE_UPLOAD: '1' } }).status, 0);
});

test('steps run in release order with the target FFmpeg payload', () => {
  const { status, steps } = record(['linux']);
  assert.equal(status, 0);
  assert.deepEqual(
    steps.map((step) => [step.command, ...step.args]),
    [
      ['npm', 'run', 'prerelease:prepare'],
      [
        'node',
        'build-scripts/ensure-release-ffmpeg.js',
        '--target',
        'linux:x64',
        '--target',
        'linux:arm64',
      ],
      ['npm', 'run', 'release:prepare'],
      ['npm', 'run', 'release:linux:continue'],
    ]
  );
  assert.deepEqual(record(['all']).steps[1].args, [
    'build-scripts/ensure-release-ffmpeg.js',
    '--all',
  ]);
});

test('--skip-check sets FORCE_UPLOAD on the continue step only', () => {
  const { steps } = record(['mac', '--skip-check'], { env: ALLOW });
  const last = steps.at(-1);
  assert.equal(last.args[1], 'release:mac:continue');
  assert.equal(last.env.FORCE_UPLOAD, '1');
  for (const step of steps.slice(0, -1)) {
    assert.ok(Object.hasOwn(step.env, 'FORCE_UPLOAD'), 'prepare steps must clear FORCE_UPLOAD');
    assert.equal(step.env.FORCE_UPLOAD, undefined);
  }
});

test('without --skip-check the continue step keeps the caller environment', () => {
  const { steps } = record(['linux']);
  assert.ok(!Object.hasOwn(steps.at(-1).env, 'FORCE_UPLOAD'));
});

test('a failing step stops the run and returns its exit code', () => {
  const { status, steps } = record(['linux'], { failAt: 1 });
  assert.equal(status, 7);
  assert.equal(steps.length, 2);
});

test('child environment drops cleared variables instead of passing "undefined"', () => {
  const { childEnv } = runner();
  const env = childEnv({ FORCE_UPLOAD: '1', KEEP: 'yes' }, { FORCE_UPLOAD: undefined, ADD: 'x' });
  assert.ok(!Object.hasOwn(env, 'FORCE_UPLOAD'));
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.ADD, 'x');
});

test('CLI refuses bad input before running anything', () => {
  const env = { ...process.env, ALLOW_RELEASE_SKIP_CHECK: '' };
  const unknown = spawnSync(process.execPath, [RUNNER, 'linux', '--bogus'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown release flag: --bogus/);
  assert.equal(unknown.stdout, '');
  const unconfirmed = spawnSync(process.execPath, [RUNNER, 'linux', '--skip-check'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /--skip-check/);
  assert.equal(unconfirmed.stdout, '');
});

test('every release target routes through the runner and has a lean continue script', () => {
  const all = scripts();
  const { RELEASE_TARGETS } = runner();
  const drafters = new Set(['win', 'win:x64', 'win:arm64', 'msstore', 'all']);
  for (const target of Object.keys(RELEASE_TARGETS)) {
    assert.equal(all[`release:${target}`], `node build-scripts/run-release.js ${target}`, target);
    const next = all[`release:${target}:continue`];
    assert.ok(next, `release:${target}:continue is missing`);
    assert.match(next, /^npm run compile && /, target);
    assert.doesNotMatch(next, /prerelease:prepare|release:prepare|ensure-release-ffmpeg/, target);
    assert.match(next, /&& npm run sign:gpg && npm run release:finalize$/, target);
    if (drafters.has(target)) {
      assert.match(next, /npm run release:draft &&/, target);
    } else {
      assert.match(next, /npm run release:wait-draft &&/, target);
    }
  }
});

test('release aliases pass flags through to the runner', () => {
  const all = scripts();
  // npm appends `-- <flags>` to the end of a script, so the runner must come last.
  assert.match(all['release:mac:ssh'], /&& node build-scripts\/run-release\.js mac$/);
  assert.equal(all['release:linux:all'], 'node build-scripts/run-release.js linux');
  assert.match(all['release:linux:native'], /node build-scripts\/run-release\.js linux$/);
});

test('beta release wrapper forwards extra flags after --', () => {
  const { npmRunArgs } = require('../build-scripts/release-beta.js');
  assert.deepEqual(npmRunArgs('release:linux', []), ['run', 'release:linux']);
  assert.deepEqual(npmRunArgs('release:linux', ['--skip-check']), [
    'run',
    'release:linux',
    '--',
    '--skip-check',
  ]);
  // Windows runs npm through a shell, so only plain --flag tokens may pass.
  assert.throws(() => npmRunArgs('release:linux', ['--skip-check & calc']), /flag/);
  assert.throws(() => npmRunArgs('release:linux', ['linux']), /flag/);
});
