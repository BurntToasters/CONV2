const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/main/preload.ts'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8');

const extractAll = (source, regex) => {
  const matches = new Set();
  let m;
  while ((m = regex.exec(source)) !== null) {
    matches.add(m[1]);
  }
  return matches;
};

// preload uses ipcRenderer.invoke('channel', ...)
const preloadInvokes = extractAll(preloadSrc, /ipcRenderer\.invoke\(\s*['"]([a-z0-9-]+)['"]/gi);

// preload subscribes to one-way main->renderer events via subscribe('channel', ...)
// or directly via ipcRenderer.on('channel', ...).
const preloadOns = new Set([
  ...extractAll(preloadSrc, /\bsubscribe\(\s*['"]([a-z0-9-]+)['"]/gi),
  ...extractAll(preloadSrc, /ipcRenderer\.on\(\s*['"]([a-z0-9-]+)['"]/gi),
]);

// main uses ipcMain.handle('channel', ...) for invoke targets
const mainHandles = extractAll(mainSrc, /ipcMain\.handle\(\s*['"]([a-z0-9-]+)['"]/gi);

// main emits one-way events via webContents.send('channel', ...) or window.webContents.send
const mainSends = new Set();
const sendRegex = /\.webContents\.send\(\s*['"]([a-z0-9-]+)['"]/gi;
let s;
while ((s = sendRegex.exec(mainSrc)) !== null) {
  mainSends.add(s[1]);
}
// also include sends from updater.ts (main process module that emits to renderer)
const updaterSrc = fs.readFileSync(path.join(ROOT, 'src/main/updater.ts'), 'utf8');
let u;
const sendRegex2 = /\.webContents\.send\(\s*['"]([a-z0-9-]+)['"]/gi;
while ((u = sendRegex2.exec(updaterSrc)) !== null) {
  mainSends.add(u[1]);
}

test('preload declares at least one invoke channel and one event channel', () => {
  assert.ok(preloadInvokes.size > 0, 'preload should declare invoke channels');
  assert.ok(preloadOns.size > 0, 'preload should declare event channels');
});

test('every preload invoke channel has a matching ipcMain.handle', () => {
  const missing = [];
  for (const channel of preloadInvokes) {
    if (!mainHandles.has(channel)) {
      missing.push(channel);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `preload invokes channels with no main-side handler: ${missing.join(', ')}`
  );
});

test('every ipcMain.handle channel is reachable from preload', () => {
  const orphan = [];
  for (const channel of mainHandles) {
    if (!preloadInvokes.has(channel)) {
      orphan.push(channel);
    }
  }
  assert.deepEqual(
    orphan,
    [],
    `main exposes handlers no preload caller uses: ${orphan.join(', ')}`
  );
});

test('every preload event listener has a main-side webContents.send emitter', () => {
  const missing = [];
  for (const channel of preloadOns) {
    if (!mainSends.has(channel)) {
      missing.push(channel);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `preload subscribes to channels no main code sends: ${missing.join(', ')}`
  );
});

test('every main-side webContents.send has a preload subscriber', () => {
  const orphan = [];
  for (const channel of mainSends) {
    if (!preloadOns.has(channel)) {
      orphan.push(channel);
    }
  }
  assert.deepEqual(
    orphan,
    [],
    `main emits events no preload listener consumes: ${orphan.join(', ')}`
  );
});

test('channel names use kebab-case (no underscores or camelCase)', () => {
  const offenders = [];
  for (const channel of [...preloadInvokes, ...preloadOns, ...mainHandles, ...mainSends]) {
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(channel)) {
      offenders.push(channel);
    }
  }
  assert.deepEqual(offenders, [], `non-kebab-case channels: ${offenders.join(', ')}`);
});
