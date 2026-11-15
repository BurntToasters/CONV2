'use strict';

// Electron entry for release-e2e.js: can this machine open a hidden window at all?
// Loads no CONV2 code, so a failure here means the machine, not the app.
const { app, BrowserWindow } = require('electron');

if (process.platform === 'darwin') app.dock?.hide();

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false, width: 320, height: 240 });
    await win.loadURL('data:text/html,<p>display probe</p>');
    console.log('[display-probe] hidden window loaded');
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    console.error(`[display-probe] ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  });
