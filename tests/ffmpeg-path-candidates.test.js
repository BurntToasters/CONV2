const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  ffmpegPlatformFolder,
  bundledFFmpegRelDirs,
  bundledBinaryFileName,
} = require('../dist/main/ffmpegPathCandidates.js');

test('platform folders match the repo resources/ffmpeg tree', () => {
  assert.equal(ffmpegPlatformFolder('win32'), 'win');
  assert.equal(ffmpegPlatformFolder('darwin'), 'mac');
  assert.equal(ffmpegPlatformFolder('linux'), 'linux');
  assert.equal(ffmpegPlatformFolder('sunos'), null);
});

test('search dirs include flat, arch, and platform/arch on every OS', () => {
  assert.deepEqual(bundledFFmpegRelDirs('linux', 'x64'), ['', 'x64', path.join('linux', 'x64')]);
  assert.deepEqual(bundledFFmpegRelDirs('darwin', 'arm64'), [
    '',
    'arm64',
    path.join('mac', 'arm64'),
  ]);
  assert.deepEqual(bundledFFmpegRelDirs('win32', 'x64'), ['', 'x64', path.join('win', 'x64')]);
});

test('Windows binaries use .exe', () => {
  assert.equal(bundledBinaryFileName('win32', 'ffmpeg'), 'ffmpeg.exe');
  assert.equal(bundledBinaryFileName('darwin', 'ffprobe'), 'ffprobe');
});

// Failure modes for "Use system FFmpeg" lookup (written before resolveExecutableOnPath):
//  - a relative or empty PATH entry lets a binary in the working directory win
//  - a non-executable file or a directory named ffmpeg is picked
//  - Windows needs PATHEXT (.exe) and case-insensitive matching
//  - no match must be reported as null, not a guess
const fsForPath = require('node:fs');
const osForPath = require('node:os');
const pathForPath = require('node:path');
const { resolveExecutableOnPath } = require('../dist/main/ffmpegPathCandidates.js');

const withPathDirs = (fn) => {
  const root = fsForPath.mkdtempSync(pathForPath.join(osForPath.tmpdir(), 'conv2-pathlookup-'));
  const dirs = ['a', 'b', 'c'].map((name) => {
    const dir = pathForPath.join(root, name);
    fsForPath.mkdirSync(dir);
    return dir;
  });
  try {
    return fn(dirs, root);
  } finally {
    fsForPath.rmSync(root, { recursive: true, force: true });
  }
};
const makeExecutable = (file) => {
  fsForPath.writeFileSync(file, '#!/bin/sh\n');
  fsForPath.chmodSync(file, 0o755);
};

test(
  'resolveExecutableOnPath returns the first executable match as an absolute path',
  { skip: process.platform === 'win32' },
  () => {
    withPathDirs(([a, b, c]) => {
      makeExecutable(pathForPath.join(b, 'ffmpeg'));
      makeExecutable(pathForPath.join(c, 'ffmpeg'));
      const PATH = [a, b, c].join(pathForPath.delimiter);
      assert.equal(
        resolveExecutableOnPath('ffmpeg', { PATH }, 'darwin'),
        pathForPath.join(b, 'ffmpeg')
      );
    });
  }
);

test(
  'resolveExecutableOnPath skips relative and empty PATH entries',
  { skip: process.platform === 'win32' },
  () => {
    withPathDirs(([a], root) => {
      makeExecutable(pathForPath.join(a, 'ffmpeg'));
      const cwd = process.cwd();
      process.chdir(a);
      try {
        const PATH = ['', '.', 'a', pathForPath.join(root, 'b')].join(pathForPath.delimiter);
        assert.equal(resolveExecutableOnPath('ffmpeg', { PATH }, 'linux'), null);
      } finally {
        process.chdir(cwd);
      }
    });
  }
);

test(
  'resolveExecutableOnPath ignores non-executable files and directories',
  { skip: process.platform === 'win32' },
  () => {
    withPathDirs(([a, b, c]) => {
      fsForPath.writeFileSync(pathForPath.join(a, 'ffmpeg'), 'not executable');
      fsForPath.mkdirSync(pathForPath.join(b, 'ffmpeg'));
      makeExecutable(pathForPath.join(c, 'ffmpeg'));
      const PATH = [a, b, c].join(pathForPath.delimiter);
      assert.equal(
        resolveExecutableOnPath('ffmpeg', { PATH }, 'linux'),
        pathForPath.join(c, 'ffmpeg')
      );
    });
  }
);

test('resolveExecutableOnPath applies PATHEXT on Windows', () => {
  withPathDirs(([a, b]) => {
    fsForPath.writeFileSync(pathForPath.join(b, 'ffmpeg.exe'), '');
    const env = { Path: [a, b].join(';'), PATHEXT: '.COM;.EXE;.BAT' };
    const found = resolveExecutableOnPath('ffmpeg', env, 'win32', ';');
    assert.equal(found && found.toLowerCase(), pathForPath.join(b, 'ffmpeg.exe').toLowerCase());
  });
});

test('resolveExecutableOnPath returns null when nothing matches or PATH is unset', () => {
  withPathDirs(([a]) => {
    assert.equal(resolveExecutableOnPath('ffmpeg', { PATH: a }, 'linux'), null);
    assert.equal(resolveExecutableOnPath('ffmpeg', {}, 'linux'), null);
  });
});
