const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Failure modes for release:mac:ssh keychain prep (helper: scripts/keychain-security.sh):
//  - security's "password to unlock <path>:" prompt goes unanswered, the keychain stays locked,
//    and the helper still reports success, so codesign prompts the user mid-release
//  - a wrong SSH_USER_PWD is reported as success
//  - an unexpected prompt hangs the release forever
//  - the password reaches security's argv (visible in ps)

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts', 'keychain-security.sh');
const macOnly = process.platform !== 'darwin' && 'macOS keychain only';

const searchList = () =>
  execFileSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

// System LibreSSL: Homebrew OpenSSL 3+ writes PKCS#12 that `security import` cannot verify.
const importTestIdentity = (dir, keychain) => {
  const file = (name) => path.join(dir, name);
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=conv2-test',
      '-keyout',
      file('key.pem'),
      '-out',
      file('cert.pem'),
    ],
    { stdio: 'ignore' }
  );
  execFileSync('/usr/bin/openssl', [
    'pkcs12',
    '-export',
    '-inkey',
    file('key.pem'),
    '-in',
    file('cert.pem'),
    '-out',
    file('id.p12'),
    '-passout',
    'pass:conv2',
  ]);
  execFileSync('security', ['import', file('id.p12'), '-k', keychain, '-P', 'conv2'], {
    stdio: 'ignore',
  });
};

/** Throwaway locked keychain; the user's search list is restored afterwards. */
function withTempKeychain(password, fn, { identity = false } = {}) {
  const before = searchList();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv2-kc-'));
  const keychain = path.join(dir, 'test.keychain-db');
  execFileSync('security', ['create-keychain', '-p', password, keychain]);
  if (identity) importTestIdentity(dir, keychain);
  execFileSync('security', ['lock-keychain', keychain]);
  try {
    return fn(keychain);
  } finally {
    spawnSync('security', ['delete-keychain', keychain]);
    execFileSync('security', ['list-keychains', '-d', 'user', '-s', ...before]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const runHelper = (password, ...args) =>
  spawnSync(
    'bash',
    ['-c', `source "${HELPER}" && security_with_password "$@"`, 'helper', ...args],
    {
      env: { ...process.env, KEYCHAIN_PASSWORD: password },
      encoding: 'utf8',
      timeout: 60_000,
    }
  );

// SecKeychainGetStatus never prompts; `security show-keychain-info` pops a GUI unlock dialog.
const LOCK_STATUS_PY = `
import ctypes, sys
sec = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/Security.framework/Security')
ref, status = ctypes.c_void_p(), ctypes.c_uint32()
assert sec.SecKeychainOpen(sys.argv[1].encode(), ctypes.byref(ref)) == 0
assert sec.SecKeychainGetStatus(ref, ctypes.byref(status)) == 0
print('unlocked' if status.value & 1 else 'locked')
`;
const isUnlocked = (keychain) =>
  execFileSync('python3', ['-c', LOCK_STATUS_PY, keychain], { encoding: 'utf8' }).trim() ===
  'unlocked';

test('unlock answers the real prompt and leaves the keychain unlocked', { skip: macOnly }, () => {
  withTempKeychain('c0nv2 "pw" $x [y]', (keychain) => {
    const result = runHelper('c0nv2 "pw" $x [y]', 'unlock-keychain', keychain);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(isUnlocked(keychain), true, 'keychain still locked');
  });
});

test('a wrong password fails instead of reporting success', { skip: macOnly }, () => {
  withTempKeychain('right-pw', (keychain) => {
    const result = runHelper('wrong-pw', 'unlock-keychain', keychain);
    assert.notEqual(result.status, 0, 'wrong password reported as success');
    assert.equal(isUnlocked(keychain), false);
  });
});

test('partition list update answers its prompt and succeeds', { skip: macOnly }, () => {
  withTempKeychain(
    'pl-pw',
    (keychain) => {
      assert.equal(runHelper('pl-pw', 'unlock-keychain', keychain).status, 0);
      const result = runHelper(
        'pl-pw',
        'set-key-partition-list',
        '-S',
        'apple-tool:,apple:,codesign:',
        '-s',
        keychain
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
    { identity: true }
  );
});

test('keychain scripts never put the password on security argv', () => {
  for (const file of ['scripts/mac-keychain-ssh.sh', 'scripts/keychain-security.sh']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /unlock-keychain -p /, file);
    assert.doesNotMatch(source, /set-key-partition-list[^\n]* -k /, file);
  }
});

test('release keychain prep stops when unlock fails', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'mac-keychain-ssh.sh'), 'utf8');
  assert.match(source, /source "[^"]*keychain-security\.sh"/);
  assert.match(source, /if ! security_with_password unlock-keychain/);
});
