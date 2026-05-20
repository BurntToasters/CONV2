export const normalizeFileUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') {
      return null;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

export const isFrameUrlTrusted = (
  frameUrl: string | undefined | null,
  trustedUrl: string | null
): boolean => {
  if (!trustedUrl) return false;
  const normalized = normalizeFileUrl(frameUrl || '');
  return normalized !== null && normalized === trustedUrl;
};
