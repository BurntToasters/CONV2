const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const autoUpdater = new EventEmitter();
autoUpdater.checkForUpdates = async () => undefined;
autoUpdater.downloadUpdate = async () => undefined;
autoUpdater.quitAndInstall = () => undefined;

const dialogCalls = [];
const fakeElectron = {
  app: { getVersion: () => '1.5.1' },
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

test('downloaded update state survives a closed macOS window and replays after load', () => {
  const firstWindow = createWindow();
  updater.initUpdater(firstWindow);
  updater.setUpdaterWindow(null);

  autoUpdater.emit('update-downloaded', { version: '1.5.2' });
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
        message: 'Version 1.5.2 downloaded.',
      },
    },
  ]);
  assert.equal(dialogCalls.length, 0, 'replay should restore the install button without a dialog');
});
