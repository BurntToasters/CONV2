const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeFileUrl, isFrameUrlTrusted } = require('../dist/main/ipcTrust.js');

test('normalizeFileUrl accepts a plain file:// url', () => {
  const result = normalizeFileUrl(
    'file:///Applications/CONV2.app/Contents/Resources/app.asar/dist/renderer/index.html'
  );
  assert.equal(
    result,
    'file:///Applications/CONV2.app/Contents/Resources/app.asar/dist/renderer/index.html'
  );
});

test('normalizeFileUrl strips query string', () => {
  const result = normalizeFileUrl('file:///app/index.html?inject=evil');
  assert.equal(result, 'file:///app/index.html');
});

test('normalizeFileUrl strips hash fragment', () => {
  const result = normalizeFileUrl('file:///app/index.html#section');
  assert.equal(result, 'file:///app/index.html');
});

test('normalizeFileUrl strips both query and hash', () => {
  const result = normalizeFileUrl('file:///app/index.html?a=1#b');
  assert.equal(result, 'file:///app/index.html');
});

test('normalizeFileUrl rejects http(s) urls', () => {
  assert.equal(normalizeFileUrl('http://evil.example.com/page'), null);
  assert.equal(normalizeFileUrl('https://example.com/'), null);
});

test('normalizeFileUrl rejects javascript: data: blob: urls', () => {
  assert.equal(normalizeFileUrl('javascript:alert(1)'), null);
  assert.equal(normalizeFileUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(normalizeFileUrl('blob:file:///abc'), null);
});

test('normalizeFileUrl rejects malformed input', () => {
  assert.equal(normalizeFileUrl(''), null);
  assert.equal(normalizeFileUrl('not a url'), null);
  assert.equal(normalizeFileUrl('://broken'), null);
});

test('isFrameUrlTrusted matches identical file urls', () => {
  const trusted = 'file:///app/index.html';
  assert.equal(isFrameUrlTrusted('file:///app/index.html', trusted), true);
});

test('isFrameUrlTrusted matches when query/hash differ', () => {
  const trusted = 'file:///app/index.html';
  assert.equal(isFrameUrlTrusted('file:///app/index.html?cache=1', trusted), true);
  assert.equal(isFrameUrlTrusted('file:///app/index.html#top', trusted), true);
});

test('isFrameUrlTrusted rejects path mismatch', () => {
  const trusted = 'file:///app/index.html';
  assert.equal(isFrameUrlTrusted('file:///app/other.html', trusted), false);
  assert.equal(isFrameUrlTrusted('file:///etc/passwd', trusted), false);
});

test('isFrameUrlTrusted rejects non-file protocols even when paths look similar', () => {
  const trusted = 'file:///app/index.html';
  assert.equal(isFrameUrlTrusted('http://app/index.html', trusted), false);
  assert.equal(isFrameUrlTrusted('https://app/index.html', trusted), false);
});

test('isFrameUrlTrusted rejects when trustedUrl is null', () => {
  assert.equal(isFrameUrlTrusted('file:///app/index.html', null), false);
});

test('isFrameUrlTrusted rejects when frame url is missing', () => {
  const trusted = 'file:///app/index.html';
  assert.equal(isFrameUrlTrusted(undefined, trusted), false);
  assert.equal(isFrameUrlTrusted(null, trusted), false);
  assert.equal(isFrameUrlTrusted('', trusted), false);
});

test('isFrameUrlTrusted is case-sensitive on path (POSIX semantics)', () => {
  const trusted = 'file:///app/Index.html';
  assert.equal(isFrameUrlTrusted('file:///app/index.html', trusted), false);
});
