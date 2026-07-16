'use strict';

const path = require('node:path');

/**
 * electron-builder publishes its own artifacts. Flatpak bundles are created
 * afterwards by build-scripts/flatpak.js, so they must be explicitly uploaded
 * alongside the generated signatures and checksum manifest.
 *
 * @param {string[]} artifactFiles filenames found in release/
 * @param {string[]} signatureFiles absolute paths to detached signatures
 * @param {string} checksumFile absolute path to the checksum manifest
 * @param {string} releaseDir absolute release directory
 * @returns {string[]} absolute paths to upload
 */
function getReleaseUploadFiles(artifactFiles, signatureFiles, checksumFile, releaseDir) {
  const flatpakBundles = artifactFiles
    .filter((file) => file.toLowerCase().endsWith('.flatpak'))
    .map((file) => path.join(releaseDir, file));

  return [...flatpakBundles, ...signatureFiles, checksumFile];
}

module.exports = { getReleaseUploadFiles };
