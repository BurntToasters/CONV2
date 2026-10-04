const test = require('node:test');
const assert = require('node:assert/strict');
const { toSafeExternalUrl, isAllowedNavigation } = require('../dist/main/navigationPolicy.js');

// Failure modes for links leaving the app and for in-window navigation. Written before
// navigationPolicy.ts.
//  - file:, javascript:, data:, custom protocol handlers, or plain http reach shell.openExternal
//  - credentials smuggled in the URL (https://user:pass@host) or a local/intranet host
//  - redirects or navigation to anything other than the bundled index.html

const TRUSTED =
  'file:///Applications/CONV2.app/Contents/Resources/app.asar/dist/renderer/index.html';

test('https links to public hosts are allowed and normalised', () => {
  assert.equal(toSafeExternalUrl('https://rosie.run/support'), 'https://rosie.run/support');
  assert.equal(
    toSafeExternalUrl('https://github.com/BurntToasters/CONV2/releases/tag/v1.6.0'),
    'https://github.com/BurntToasters/CONV2/releases/tag/v1.6.0'
  );
});

test('non-https schemes are refused', () => {
  for (const url of [
    'http://rosie.run',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>x',
    'vbscript:msgbox',
    'ms-settings:privacy',
    'smb://server/share',
    'mailto:someone@example.com',
  ]) {
    assert.equal(toSafeExternalUrl(url), null, url);
  }
});

test('credentials in the URL are refused', () => {
  assert.equal(toSafeExternalUrl('https://user:pass@rosie.run/'), null);
  assert.equal(toSafeExternalUrl('https://user@rosie.run/'), null);
});

test('local and private hosts are refused', () => {
  for (const url of [
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://10.0.0.5/',
    'https://192.168.1.1/',
    'https://172.16.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://printer.local/',
  ]) {
    assert.equal(toSafeExternalUrl(url), null, url);
  }
});

test('garbage and non-strings are refused without throwing', () => {
  for (const value of ['', 'not a url', '   ', null, undefined, 42, {}]) {
    assert.equal(toSafeExternalUrl(value), null, String(value));
  }
});

test('overlong URLs are refused', () => {
  assert.equal(toSafeExternalUrl(`https://rosie.run/${'a'.repeat(5000)}`), null);
});

test('navigation is allowed only to the bundled renderer, ignoring query and hash', () => {
  assert.equal(isAllowedNavigation(TRUSTED, TRUSTED), true);
  assert.equal(isAllowedNavigation(`${TRUSTED}?x=1#top`, TRUSTED), true);
  for (const target of [
    'https://rosie.run/',
    'file:///Applications/CONV2.app/Contents/Resources/app.asar/dist/renderer/other.html',
    'file:///etc/passwd',
    'about:blank',
    '',
  ]) {
    assert.equal(isAllowedNavigation(target, TRUSTED), false, target);
  }
  assert.equal(isAllowedNavigation(TRUSTED, null), false, 'no trusted URL yet');
});
