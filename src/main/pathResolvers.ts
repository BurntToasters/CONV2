import * as fs from 'fs';
import * as path from 'path';

// Renderer-supplied paths are only trusted when absolute and of the expected kind.

export const resolveAbsolutePath = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  return path.resolve(trimmed);
};

export const resolveExistingFilePath = (value: unknown): string | null => {
  const resolved = resolveAbsolutePath(value);
  if (!resolved) {
    return null;
  }
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
};

export const resolveExistingDirectoryPath = (value: unknown): string | null => {
  const resolved = resolveAbsolutePath(value);
  if (!resolved) {
    return null;
  }
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
};
