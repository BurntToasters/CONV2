import * as fs from 'fs';
import * as path from 'path';

// Last-resort handling for main-process errors: a capped, redacted log plus one user-facing notice.

export interface FatalErrorHandlerOptions {
  logPath: string;
  redact: (text: string) => string;
  isReady: () => boolean;
  showError: (title: string, body: string) => void;
  now?: () => Date;
  maxLogBytes?: number;
}

export interface FatalErrorHandler {
  onUncaughtException: (error: unknown) => void;
  onUnhandledRejection: (reason: unknown) => void;
}

const DEFAULT_MAX_LOG_BYTES = 256 * 1024;

const describe = (value: unknown): string => {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const createFatalErrorHandler = (options: FatalErrorHandlerOptions): FatalErrorHandler => {
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  let dialogShown = false;

  const append = (kind: string, value: unknown): string => {
    const text = options.redact(describe(value));
    const entry = `${now().toISOString()} ${kind}\n${text}\n\n`;
    try {
      fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
      let existing = '';
      try {
        existing = fs.readFileSync(options.logPath, 'utf8');
      } catch {
        // first entry
      }
      let combined = existing + entry;
      if (Buffer.byteLength(combined) > maxBytes) {
        const entries = combined.split(/\n\n(?=\d{4}-\d{2}-\d{2}T)/);
        while (entries.length > 1 && Buffer.byteLength(entries.join('\n\n')) > maxBytes) {
          entries.shift();
        }
        combined = entries.join('\n\n');
        if (Buffer.byteLength(combined) > maxBytes) combined = entry.slice(-maxBytes);
      }
      fs.writeFileSync(options.logPath, combined);
    } catch {
      // logging must never raise a second error
    }
    return text;
  };

  return {
    onUncaughtException: (error) => {
      console.error('Uncaught exception:', error);
      const text = append('uncaughtException', error);
      if (dialogShown || !options.isReady()) return;
      dialogShown = true;
      try {
        options.showError(
          'CONV2 hit an unexpected error',
          `${text.split('\n')[0]}\n\nCONV2 will keep running, but you may want to restart it. Details were saved to ${path.basename(options.logPath)} in the app data folder.`
        );
      } catch {
        // dialog unavailable
      }
    },
    onUnhandledRejection: (reason) => {
      console.error('Unhandled rejection:', reason);
      append('unhandledRejection', reason);
    },
  };
};
