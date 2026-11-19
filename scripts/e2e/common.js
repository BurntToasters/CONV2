// Process, environment, and git helpers shared by the E2E gate and its runners.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { sha256 } from "../../e2e/helpers/hash.js";
import { usesWindowsCmdShell } from "../npm-safe-update.mjs";

export const ARTIFACT_DIR = path.join(REPO_ROOT, "e2e", "artifacts");

export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function e2eChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Cursor/CI helper envs must not redirect the e2e binary away from
  // src-tauri/target/debug, where the stamp and WDIO launcher look.
  delete env.CARGO_TARGET_DIR;
  return env;
}

/**
 * Arguments for a spawn. With the Windows cmd shell on (npm.cmd, npx.cmd) the
 * command line is re-parsed, so an argument with spaces or shell characters
 * is quoted; without a shell it is passed through untouched.
 */
export function shellSafeArgs(command, args) {
  if (!usesWindowsCmdShell(command)) return args;
  return args.map((arg) =>
    /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg,
  );
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, shellSafeArgs(command, args), {
    cwd: options.cwd ?? REPO_ROOT,
    env: e2eChildEnv(options.env),
    stdio: "inherit",
    windowsHide: true,
    encoding: "utf8",
    shell: usesWindowsCmdShell(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

/**
 * Asynchronous variant for WebdriverIO: the in-process media server must keep
 * serving while the app downloads, so the event loop cannot be blocked.
 */
export function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, shellSafeArgs(command, args), {
      cwd: options.cwd ?? REPO_ROOT,
      env: e2eChildEnv(options.env),
      stdio: "inherit",
      windowsHide: true,
      shell: usesWindowsCmdShell(command),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? signal}`,
          ),
        );
    });
  });
}

export function which(bin) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [bin],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
}

/** Platforms with an implemented background mode. Linux has none. */
const BACKGROUND_PLATFORMS = new Set(["darwin", "win32"]);

/**
 * `CONV2_E2E_BACKGROUND` for the app launches of this run. Local macOS and
 * Windows runs default to "1" so CONV2 never takes focus or covers other apps.
 * CI and `CONV2_E2E_FOREGROUND=1` keep the foreground behavior; an explicit
 * value wins. Failure modes: scripts/test-e2e-background.failure-modes.md.
 */
export function e2eBackgroundValue({ env, platform }) {
  if (env.CONV2_E2E_BACKGROUND !== undefined) return env.CONV2_E2E_BACKGROUND;
  if (!BACKGROUND_PLATFORMS.has(platform)) return null;
  if (env.CONV2_E2E_FOREGROUND === "1") return null;
  const ci = (env.CI ?? "").trim().toLowerCase();
  if (ci !== "" && ci !== "false" && ci !== "0") return null;
  return "1";
}

export function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function gitSourceTree() {
  const result = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Whether the working tree differs from HEAD, plus a hash of the exact status
 * listing. An unreadable status fails closed: it counts as dirty, with no hash.
 */
export function gitWorktreeState(cwd = REPO_ROOT) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-uall"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { worktreeDirty: true, worktreeStatusSha256: null };
  }
  return {
    worktreeDirty: result.stdout.length > 0,
    worktreeStatusSha256: crypto
      .createHash("sha256")
      .update(result.stdout)
      .digest("hex"),
  };
}

/** One TCP probe of 127.0.0.1:port: "refused", "listening", or an error tag. */
export function probeTcpPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1_000, () => finish("timeout"));
    socket.once("connect", () => finish("listening"));
    socket.once("error", (error) =>
      finish(
        error.code === "ECONNREFUSED"
          ? "refused"
          : `error:${error.code ?? error.message}`,
      ),
    );
  });
}

/**
 * A loopback port nothing answers on, for one pass's embedded WebDriver. A
 * fixed port lets a leftover CONV2 (or another Tauri app) answer /status, so
 * the pass would attach to the wrong app.
 */
export async function reserveFreePort(attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: chosen } = server.address();
        server.close(() => resolve(chosen));
      });
    });
    if ((await probeTcpPort(port)) === "refused") return port;
  }
  throw new Error("Could not find a free loopback port for the E2E WebDriver");
}

export function cleanupProfile(profileDir) {
  try {
    fs.rmSync(profileDir, {
      recursive: true,
      force: true,
      // WebView2 can retain file handles briefly after a clean application
      // exit. Its retries use linear backoff, giving Windows up to 21 seconds.
      maxRetries: process.platform === "win32" ? 20 : 8,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(
      `WARNING: Could not remove temporary E2E profile ${profileDir}; leaving it for OS cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function relativeToRepo(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** True when `report.reportSha256` matches the hash of the rest of the report. */
export function reportSelfHashMatches(report) {
  const { reportSha256, ...body } = report;
  return reportSha256 === sha256(Buffer.from(JSON.stringify(body, null, 2)));
}
