import * as fs from 'fs';
import * as path from 'path';

// Disk cache for hardware-encoder probe results, invalidated by FFmpeg binary + app version + TTL.

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface HwProbeStore {
  get: (encoder: string) => boolean | undefined;
  set: (encoder: string, available: boolean) => void;
  clear: () => void;
}

interface StoreFile {
  version: number;
  fingerprint: string;
  savedAt: number;
  results: Record<string, boolean>;
}

export const binaryFingerprint = (binaryPath: string, appVersion: string): string => {
  const base = `${process.platform}-${process.arch}|${appVersion}|${binaryPath}`;
  try {
    const stat = fs.statSync(binaryPath);
    return `${base}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  } catch {
    return base;
  }
};

const readResults = (filePath: string, fingerprint: string, now: number, ttlMs: number) => {
  const results = new Map<string, boolean>();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StoreFile> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== STORE_VERSION ||
      parsed.fingerprint !== fingerprint ||
      typeof parsed.savedAt !== 'number' ||
      now - parsed.savedAt > ttlMs ||
      !parsed.results ||
      typeof parsed.results !== 'object' ||
      Array.isArray(parsed.results)
    ) {
      return { results, savedAt: now };
    }
    for (const [encoder, value] of Object.entries(parsed.results)) {
      if (typeof value === 'boolean') results.set(encoder, value);
    }
    return { results, savedAt: parsed.savedAt };
  } catch {
    return { results, savedAt: now };
  }
};

export const createHwProbeStore = (options: {
  filePath: string;
  fingerprint: string;
  ttlMs?: number;
  now?: () => number;
}): HwProbeStore => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let { results, savedAt } = readResults(options.filePath, options.fingerprint, now(), ttlMs);

  const persist = (): void => {
    const payload: StoreFile = {
      version: STORE_VERSION,
      fingerprint: options.fingerprint,
      savedAt,
      results: Object.fromEntries(results),
    };
    const tmpPath = `${options.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(payload));
      fs.renameSync(tmpPath, options.filePath);
    } catch {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // cache is best-effort
      }
    }
  };

  return {
    get: (encoder) => results.get(encoder),
    set: (encoder, available) => {
      if (results.size === 0) savedAt = now();
      results.set(encoder, available);
      persist();
    },
    clear: () => {
      results = new Map();
      savedAt = now();
      try {
        fs.rmSync(options.filePath, { force: true });
      } catch {
        // best-effort
      }
    },
  };
};
