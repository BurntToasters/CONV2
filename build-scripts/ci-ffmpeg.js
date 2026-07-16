// CI package-smoke helper. Release VMs remain responsible for release scripts;
// this only makes CI validate real bundled FFmpeg payloads when the download
// server secret is configured.
const { execFileSync } = require('node:child_process');

if (!process.env.FFMPEG_DL_SERVER?.trim()) {
  console.warn(
    '[ci-ffmpeg] FFMPEG_DL_SERVER is not configured; package smoke will validate packaging structure only.'
  );
  process.exit(0);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

execFileSync(npmCommand, ['run', 'get:ffmpeg'], { stdio: 'inherit' });
execFileSync(
  process.execPath,
  [
    'build-scripts/check-ffmpeg.js',
    '--target',
    `${platform}:x64`,
    '--target',
    `${platform}:arm64`,
    '--require-checksums',
  ],
  { stdio: 'inherit' }
);
