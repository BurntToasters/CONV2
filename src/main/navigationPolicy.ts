import { normalizeFileUrl } from './ipcTrust';

// Single policy for URLs handed to the OS browser and for in-window navigation.

const MAX_URL_LENGTH = 2048;
const LOCAL_HOST = /^(?:localhost|.*\.local|.*\.localhost|.*\.internal)$/i;
const PRIVATE_IPV4 =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/;

const isLocalOrPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (LOCAL_HOST.test(host) || PRIVATE_IPV4.test(host)) return true;
  // IPv6 loopback, link-local, and unique-local ranges.
  return host.includes(':') && (/^(?:::1?|fe80:|fc|fd)/i.test(host) || host === '::');
};

/** Returns a normalised https URL safe for shell.openExternal, or null. */
export const toSafeExternalUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (!parsed.hostname || isLocalOrPrivateHost(parsed.hostname)) return null;
  return parsed.toString();
};

/** The window may only ever show the bundled renderer page. */
export const isAllowedNavigation = (targetUrl: string, trustedUrl: string | null): boolean => {
  if (!trustedUrl) return false;
  const normalized = normalizeFileUrl(targetUrl);
  return normalized !== null && normalized === trustedUrl;
};
