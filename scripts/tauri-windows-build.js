import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

const rawArgs = process.argv.slice(2);
// `--msstore` bakes the Microsoft Store distribution channel into both the
// frontend (Vite define) and the Rust binary (option_env!), which disables the
// in-app updater. It is not a Tauri CLI flag, so strip it before forwarding.
const msStore = rawArgs.includes("--msstore");
const args = rawArgs.filter((arg) => arg !== "--msstore");
assertStableReleaseOverridesAllowed();
const skipWindowsCodeSigning = process.env.SKIP_WIN_CODESIGN?.trim() === "1";
const required = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER_DN",
];
const missing = skipWindowsCodeSigning
  ? []
  : required.filter((name) => !process.env[name]?.trim());
if (process.platform !== "win32")
  throw new Error("Signed Windows builds must run on Windows.");
if (missing.length)
  throw new Error(
    `Missing Artifact Signing environment variables: ${missing.join(", ")}`,
  );
if (skipWindowsCodeSigning)
  console.warn(
    "[tauri-windows-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.",
  );
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] ?? "";
  return (
    args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? ""
  );
};
const target = valueAfter("--target");
if (!target.includes("windows"))
  throw new Error("A Windows --target is required.");
const root = fileURLToPath(new URL("..", import.meta.url));
const targetReleaseDir = path.join(
  root,
  "src-tauri",
  "target",
  target,
  "release",
);
const signScript = fileURLToPath(
  new URL("./windows-artifact-sign.ps1", import.meta.url),
);

function runPowershell(scriptPath, extraArgs = [], { capture = false } = {}) {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...extraArgs,
    ],
    {
      encoding: capture ? "utf8" : undefined,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: process.env,
    },
  );
  if (capture) process.stdout.write(output);
  return capture ? String(output) : "";
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

// gpg-sign.js normalizes these installer names before upload; match its output.
function releaseAssetName(name) {
  if (/x64-setup\.exe$/i.test(name)) return "CONV2-Win-x64-Setup.exe";
  if (/arm64-setup\.exe$/i.test(name)) return "CONV2-Win-arm64-Setup.exe";
  return name;
}

function readAttestationEntries(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
  } catch {
    return [];
  }
}

const buildEnv = { ...process.env };
if (msStore) {
  buildEnv.CONV2_DISTRIBUTION_CHANNEL = "msstore";
  console.log(
    "[tauri-windows-build] Building the Microsoft Store channel (in-app updater disabled).",
  );
} else {
  delete buildEnv.CONV2_DISTRIBUTION_CHANNEL;
}

const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
execFileSync(process.execPath, [tauriCli, "build", ...args, "--", "--locked"], {
  stdio: "inherit",
  env: buildEnv,
});
if (!skipWindowsCodeSigning) {
  const runtimeExecutables = readdirSync(targetReleaseDir, {
    withFileTypes: true,
  })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"),
    )
    .map((entry) => path.join(targetReleaseDir, entry.name));
  if (!runtimeExecutables.length)
    throw new Error(
      `No final Windows runtime executables found under ${targetReleaseDir}`,
    );
  for (const executable of runtimeExecutables) {
    console.log(
      `[tauri-windows-build] Finalizing Authenticode signature: ${executable}`,
    );
    runPowershell(signScript, ["-FilePath", executable]);
  }
  const verifyOutput = runPowershell(
    fileURLToPath(
      new URL("./verify-windows-authenticode.ps1", import.meta.url),
    ),
    ["-TargetReleaseDir", targetReleaseDir],
    { capture: true },
  );
  const verifiedPaths = String(verifyOutput)
    .split(/\r?\n/u)
    .map((line) => line.match(/^Verified: (.+)$/u)?.[1]?.trim())
    .filter(Boolean);
  if (verifiedPaths.length === 0)
    throw new Error(
      "verify-windows-authenticode.ps1 reported no verified artifacts.",
    );
  const verifiedByResolvedPath = new Map(
    verifiedPaths.map((filePath) => [
      path.resolve(filePath).toLowerCase(),
      filePath,
    ]),
  );
  for (const executable of runtimeExecutables) {
    if (!verifiedByResolvedPath.has(path.resolve(executable).toLowerCase()))
      throw new Error(
        `verify-windows-authenticode.ps1 did not report ${executable} as verified.`,
      );
  }
  // The attestation lets the host-agnostic draft gate rebind these bytes to
  // the publisher identity that was verified here.
  const publisher = process.env.AZURE_ARTIFACT_SIGNING_PUBLISHER.trim();
  const subject = process.env.AZURE_ARTIFACT_SIGNING_PUBLISHER_DN.trim();
  const attestationPath = path.join(
    root,
    "release",
    "windows-authenticode.json",
  );
  const artifacts = [
    ...readAttestationEntries(attestationPath).filter(
      (entry) => entry?.target !== target,
    ),
    ...verifiedPaths
      .filter((filePath) => path.extname(filePath).toLowerCase() === ".exe")
      .map((filePath) => ({
        target,
        name: path.basename(filePath),
        assetName: releaseAssetName(path.basename(filePath)),
        sha256: sha256File(filePath),
        publisher,
        subject,
        verified: true,
      })),
  ];
  mkdirSync(path.dirname(attestationPath), { recursive: true });
  writeFileSync(
    attestationPath,
    `${JSON.stringify(
      {
        schema: "conv2-windows-authenticode/v1",
        generatedAt: new Date().toISOString(),
        publisher,
        subject,
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[tauri-windows-build] Wrote Authenticode attestation to ${attestationPath}`,
  );
}
