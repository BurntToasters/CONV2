export type FileSelectionMode = 'replace' | 'append';

export const mergeSelectedFilePaths = (
  current: string[],
  incoming: string[],
  mode: FileSelectionMode
): string[] => {
  const nextIncoming = incoming.filter((entry) => typeof entry === 'string' && entry.length > 0);
  if (mode === 'replace') {
    return Array.from(new Set(nextIncoming));
  }
  return Array.from(new Set([...current, ...nextIncoming]));
};

export const removeSelectedFile = (paths: string[], index: number): string[] => {
  if (index < 0 || index >= paths.length) {
    return [...paths];
  }
  return paths.filter((_, current) => current !== index);
};

export const moveSelectedFile = (paths: string[], index: number, delta: number): string[] => {
  const next = [...paths];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
    return next;
  }
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
};

export interface FileSelectionApi {
  mergeSelectedFilePaths: typeof mergeSelectedFilePaths;
  removeSelectedFile: typeof removeSelectedFile;
  moveSelectedFile: typeof moveSelectedFile;
}

const fileSelectionApi: FileSelectionApi = {
  mergeSelectedFilePaths,
  removeSelectedFile,
  moveSelectedFile,
};

if (typeof window !== 'undefined') {
  (window as Window & { conv2FileSelection?: FileSelectionApi }).conv2FileSelection =
    fileSelectionApi;
}
