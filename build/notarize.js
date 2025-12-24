
require('dotenv').config();
const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    console.log('Skipping notarization: Not macOS');
    return;
  }

  if (context.packager.config.mac?.type === 'distribution') {
    console.log('Skipping notarization: MAS build');
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('Skipping notarization: Missing Apple credentials');
    console.log('  Required: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`Notarizing: ${appName}.app`);

  try {
    await notarize({
      appPath,
      appleId,
      appleIdPassword,
      teamId,
    });
    console.log('Notarization complete!');
  } catch (error) {
    console.error('Notarization failed:', error.message);
    throw error;
  }
};
