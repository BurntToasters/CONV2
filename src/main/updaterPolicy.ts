const PRERELEASE_PATTERN = /-(beta|alpha|rc)(?:\.(\d+))?/i;

const PRERELEASE_ORDER: Record<string, number> = {
  alpha: 1,
  beta: 2,
  rc: 3,
};

const stripBuildMetadata = (version: string): string => {
  const plusIndex = version.indexOf('+');
  return plusIndex === -1 ? version : version.slice(0, plusIndex);
};

export const isPrereleaseVersion = (version: string): boolean => {
  return PRERELEASE_PATTERN.test(stripBuildMetadata(version));
};

const getBaseVersion = (version: string): number[] => {
  return stripBuildMetadata(version)
    .replace(/-(beta|alpha|rc).*/i, '')
    .split('.')
    .map((part) => {
      const value = Number(part);
      return Number.isFinite(value) ? value : 0;
    })
    .slice(0, 3);
};

const getPrereleaseParts = (version: string): { tag: string; num: number } | null => {
  const match = stripBuildMetadata(version).match(PRERELEASE_PATTERN);
  if (!match) {
    return null;
  }
  return {
    tag: match[1].toLowerCase(),
    num: match[2] ? Number(match[2]) : 0,
  };
};

/**
 * Compare app versions with semver-like rules:
 * higher base wins; same base → stable > prerelease; same tag → higher number wins.
 */
export const compareVersions = (left: string, right: string): number => {
  const leftBase = getBaseVersion(left);
  const rightBase = getBaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftBase[index] || 0;
    const rightPart = rightBase[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  const leftPre = getPrereleaseParts(left);
  const rightPre = getPrereleaseParts(right);

  if (!leftPre && !rightPre) return 0;
  if (!leftPre && rightPre) return 1;
  if (leftPre && !rightPre) return -1;

  const leftOrder = PRERELEASE_ORDER[leftPre!.tag] || 0;
  const rightOrder = PRERELEASE_ORDER[rightPre!.tag] || 0;
  if (leftOrder > rightOrder) return 1;
  if (leftOrder < rightOrder) return -1;
  if (leftPre!.num > rightPre!.num) return 1;
  if (leftPre!.num < rightPre!.num) return -1;
  return 0;
};

/**
 * Accept only strictly newer versions. Blocks channel-switch downgrades
 * (electron-updater sets allowDowngrade=true when channel changes).
 */
export const shouldAcceptUpdate = (offeredVersion: string, currentVersion: string): boolean => {
  return compareVersions(offeredVersion, currentVersion) > 0;
};

/**
 * @deprecated Prefer shouldAcceptUpdate. Channel no longer changes accept rules;
 * downgrade blocking applies on every channel.
 */
export const shouldAcceptUpdateForChannel = (
  offeredVersion: string,
  currentVersion: string,
  _useBetaChannel?: boolean
): boolean => {
  return shouldAcceptUpdate(offeredVersion, currentVersion);
};
