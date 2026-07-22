// CI package-smoke helper. Release VMs remain responsible for release scripts;
// this only makes CI validate real bundled FFmpeg payloads when the download
// server secret is configured.
const { execFileSync } = require('node:child_process');

const TRUSTED_RELEASE_REFS = new Set(['refs/heads/main', 'refs/heads/beta']);

function requiresRealPayload(env = process.env) {
  if (env.REQUIRE_FFMPEG_PAYLOAD === '1') {
    return true;
  }
  return env.GITHUB_EVENT_NAME === 'push' && TRUSTED_RELEASE_REFS.has(env.GITHUB_REF || '');
}

function run(env = process.env) {
  if (!env.FFMPEG_DL_SERVER?.trim()) {
    if (requiresRealPayload(env)) {
      throw new Error(
        'FFMPEG_DL_SERVER is required for package smoke on trusted main/beta pushes.'
      );
    }
    console.warn(
      '[ci-ffmpeg] FFMPEG_DL_SERVER is not configured; pull-request package smoke will validate packaging structure only.'
    );
    return;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const platform =
    process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

  execFileSync(npmCommand, ['run', 'get:ffmpeg'], { stdio: 'inherit', env });
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
    { stdio: 'inherit', env }
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`[ci-ffmpeg] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { requiresRealPayload, run };
