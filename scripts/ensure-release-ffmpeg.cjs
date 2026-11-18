// Release VMs refresh a bad or missing payload, then verify the replacement.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const TARGET = /^(?:win|mac|linux):(?:x64|arm64)$/;

function usage() {
  throw new Error(
    "Usage: node scripts/ensure-release-ffmpeg.cjs --all | --target <platform:arch>...",
  );
}

function releaseArgs(args) {
  if (args.length === 1 && args[0] === "--all") {
    return args;
  }
  if (args.length === 0 || args.length % 2 !== 0) {
    usage();
  }
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== "--target" || !TARGET.test(args[i + 1] || "")) {
      usage();
    }
  }
  return args;
}

function runNode(scriptName, args) {
  const result = spawnSync(
    process.execPath,
    [path.join("scripts", scriptName), ...args],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return typeof result.status === "number" ? result.status : 1;
}

function main() {
  const args = releaseArgs(process.argv.slice(2));
  if (runNode("check-ffmpeg.cjs", ["--require-checksums", ...args]) === 0) {
    return 0;
  }

  console.error(
    "[release-ffmpeg] Checksum verification failed. Downloading FFmpeg and re-checking.",
  );
  const downloadStatus = runNode("get-ffmpeg.cjs", args);
  if (downloadStatus !== 0) {
    return downloadStatus;
  }
  return runNode("check-ffmpeg.cjs", ["--require-checksums", ...args]);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { releaseArgs };
