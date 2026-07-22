import * as fs from 'fs';
import * as path from 'path';

const TEMP_DIRECTORY_PREFIX = 'conv2-bin-';

export const createPrivateExecutableDirectory = (tempRoot: string): string => {
  const directory = fs.mkdtempSync(path.join(tempRoot, TEMP_DIRECTORY_PREFIX));
  fs.chmodSync(directory, 0o700);
  return directory;
};

export const copyExecutableToPrivateDirectory = (
  sourcePath: string,
  destinationDirectory: string
): string => {
  const sourceStats = fs.lstatSync(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error(`Refusing non-regular executable source: ${sourcePath}`);
  }

  const directoryStats = fs.lstatSync(destinationDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Refusing unsafe executable cache directory: ${destinationDirectory}`);
  }

  const destinationPath = path.join(destinationDirectory, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destinationPath, 0o700);
  return destinationPath;
};

export const removePrivateExecutableDirectory = (directory: string | null): void => {
  if (!directory) return;
  fs.rmSync(directory, { recursive: true, force: true });
};
