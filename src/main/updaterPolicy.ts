const PRERELEASE_PATTERN = /-(beta|alpha|rc)/i;

export const isPrereleaseVersion = (version: string): boolean => {
  return PRERELEASE_PATTERN.test(version);
};

const getBaseVersion = (version: string): number[] => {
  return version
    .replace(/-(beta|alpha|rc).*/i, '')
    .split('.')
    .map(Number)
    .slice(0, 3);
};

const compareBaseVersions = (left: string, right: string): number => {
  const leftBase = getBaseVersion(left);
  const rightBase = getBaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftBase[index] || 0;
    const rightPart = rightBase[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
};

/**
 * Beta users should receive the matching stable release. Electron-updater
 * handles normal semver filtering; this policy only prevents an older stable
 * release from displacing a newer beta line.
 */
export const shouldAcceptUpdateForChannel = (
  offeredVersion: string,
  currentVersion: string,
  useBetaChannel: boolean
): boolean => {
  if (!useBetaChannel || isPrereleaseVersion(offeredVersion)) {
    return true;
  }

  return compareBaseVersions(offeredVersion, currentVersion) >= 0;
};
