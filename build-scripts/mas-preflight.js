// Fails fast when Mac App Store signing inputs are missing, before compile/packaging.
const fs = require('node:fs');
const path = require('node:path');

const PROFILE_RELATIVE_PATH = 'build/embedded.provisionprofile';
const ENTITLEMENTS = ['build/entitlements.mas.plist', 'build/entitlements.mas.inherit.plist'];

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function checkMasPrerequisites(projectRoot = process.cwd()) {
  const errors = [];
  if (!isNonEmptyFile(path.join(projectRoot, PROFILE_RELATIVE_PATH))) {
    errors.push(
      `Missing ${PROFILE_RELATIVE_PATH}. Download the Mac App Store distribution profile ` +
        'for com.burnttoasters.conv2 from developer.apple.com and save it there.'
    );
  }
  for (const relativePath of ENTITLEMENTS) {
    if (!isNonEmptyFile(path.join(projectRoot, relativePath))) {
      errors.push(`Missing ${relativePath}.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

if (require.main === module) {
  const result = checkMasPrerequisites();
  if (!result.ok) {
    for (const error of result.errors) console.error(`MAS preflight: ${error}`);
    process.exit(1);
  }
  console.log('MAS preflight passed.');
}

module.exports = { checkMasPrerequisites, PROFILE_RELATIVE_PATH };
