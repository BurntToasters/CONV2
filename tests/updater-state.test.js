const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const autoUpdater = new EventEmitter();
autoUpdater.channel = 'latest';
autoUpdater.allowPrerelease = false;
autoUpdater.allowDowngrade = false;
autoUpdater.checkForUpdates = async () => undefined;
autoUpdater.downloadUpdate = async () => undefined;
autoUpdater.quitAndInstall = () => undefined;

const dialogCalls = [];
const fakeElectron = {
  app: { getVersion: () => '1.6.0-beta.3' },
  dialog: {
    showMessageBox: async (...args) => {
      dialogCalls.push(args);
      return { response: 1 };
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron-updater') return { autoUpdater };
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const updaterModulePath = require.resolve('../dist/main/updater.js');
delete require.cache[updaterModulePath];
const updater = require(updaterModulePath);
Module._load = originalLoad;

const createWindow = () => {
  const webContents = new EventEmitter();
  const sent = [];
  webContents.send = (channel, payload) => sent.push({ channel, payload });
  return {
    isDestroyed: () => false,
    webContents,
    sent,
  };
};

const waitForImmediate = () => new Promise((resolve) => setImmediate(resolve));

test('downloadAvailableUpdate rejects when no update is cached', () => {
  const windowRef = createWindow();
  updater.initUpdater(windowRef);
  windowRef.sent.length = 0;
  updater.downloadAvailableUpdate();
  assert.ok(
    windowRef.sent.some(
      (entry) =>
        entry.channel === 'update-state' &&
        entry.payload.phase === 'error' &&
        String(entry.payload.message).includes('No update is available')
    ),
    'should emit error when nothing is available to download'
  );
});

test('downloaded update state survives a closed macOS window and replays after load', () => {
  dialogCalls.length = 0;
  const firstWindow = createWindow();
  updater.setUpdaterWindow(firstWindow);
  updater.setUpdaterWindow(null);

  autoUpdater.emit('update-downloaded', { version: '1.6.1' });
  assert.equal(dialogCalls.length, 0, 'no dialog should open without a window');

  const reopenedWindow = createWindow();
  updater.initUpdater(reopenedWindow);
  assert.equal(reopenedWindow.sent.length, 0, 'state should wait for renderer load');
  reopenedWindow.webContents.emit('did-finish-load');

  assert.deepEqual(reopenedWindow.sent, [
    {
      channel: 'update-state',
      payload: {
        phase: 'downloaded',
        manual: false,
        message: 'Version 1.6.1 downloaded.',
      },
    },
  ]);
  assert.equal(dialogCalls.length, 0, 'replay should restore the install button without a dialog');
});

test('channel change during deferred stable fallback does not wedge checks', async () => {
  const windowRef = createWindow();
  updater.setUpdaterWindow(windowRef);
  updater.setUpdateChannel('beta');

  // Drain any silent recheck scheduled by setUpdateChannel.
  await waitForImmediate();
  await waitForImmediate();

  updater.checkForUpdatesSilent();
  autoUpdater.emit('update-not-available');
  // Fallback scheduled; change channel before setImmediate runs.
  updater.setUpdateChannel('stable');
  await waitForImmediate();
  await waitForImmediate();

  windowRef.sent.length = 0;
  updater.checkForUpdatesSilent();
  const stuck = windowRef.sent.some(
    (entry) => entry.channel === 'update-state' && entry.payload.phase === 'already-checking'
  );
  assert.equal(stuck, false, 'update check must not stay wedged after fallback discard');
});

test('allowDowngrade is forced false after channel apply', () => {
  autoUpdater.allowDowngrade = true;
  updater.setUpdateChannel('beta');
  assert.equal(autoUpdater.allowDowngrade, false);
  updater.setUpdateChannel('stable');
  assert.equal(autoUpdater.allowDowngrade, false);
});
