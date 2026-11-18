// E2E gate orchestrator: builds the binary, runs the WebdriverIO passes,
// verifies the evidence, and writes the gate report.
// Modules: scripts/e2e/ (manifest, common, build, fixtures, runners/*, stability).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  createE2eProfile,
  e2eBinaryPath,
} from "../e2e/helpers/profile.js";
import { sha256 } from "../e2e/helpers/hash.js";
import { LEGACY_IMPORT_FAILURE_MODES } from "../e2e/helpers/legacy-v1.js";
import {
  ARTIFACT_DIR,
  cleanupProfile,
  e2eBackgroundValue,
  gitCommit,
  gitSourceTree,
  relativeToRepo,
  which,
} from "./e2e/common.js";
import {
  buildE2eBinary,
  e2eBinaryIsFresh,
  mayReuseE2eBinary,
} from "./e2e/build.js";
import {
  buildMediaFixtures,
  companionFfprobe,
  resolveTestFfmpeg,
} from "./e2e/fixtures.js";
import {
  buildCoreRunPlan,
  coreArtifactPaths,
  createE2eRunId,
  parseE2eProfile,
} from "./e2e/core.js";
import {
  e2eOnlySpec,
  e2eRunPlan,
  groupedScenarioResults,
  onlyRunScenarioProblems,
  parseE2eGroups,
  scenarioOutcomeProblems,
  verifyScreenshots,
} from "./e2e/manifest.js";
import {
  buildLegacyPasses,
  buildSharedWdioEnv,
  runRecordedWdioPass,
} from "./e2e/runners/wdio-passes.js";
import { parseRepeat, runStability } from "./e2e/stability.js";

// Public names other scripts and tests import from this module.
export {
  ALLOWED_E2E_SKIPS,
  E2E_SUITE_MANIFEST,
  EXPECTED_SCENARIOS,
  SCREENSHOT_SCENARIO_NAMES,
  e2eOnlySpec,
  e2eRunPlan,
  onlyRunScenarioProblems,
  parseE2eGroups,
  scenarioOutcomeProblems,
} from "./e2e/manifest.js";
export { e2eBackgroundValue, reportSelfHashMatches } from "./e2e/common.js";
export { buildE2eBinary, mayReuseE2eBinary } from "./e2e/build.js";
export { parseRepeat, summarizeStability } from "./e2e/stability.js";

function needsXvfb() {
  return (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  );
}

function reexecUnderXvfb() {
  if (process.env.CONV2_E2E_XVFB === "1") return false;
  if (!needsXvfb()) return false;
  if (!which("xvfb-run")) {
    throw new Error(
      "Linux E2E needs a display. Install xvfb with `sudo apt install -y xvfb` (also in npm run setup:deb), or set DISPLAY.",
    );
  }
  const result = spawnSync(
    "xvfb-run",
    [
      "-a",
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, CONV2_E2E_XVFB: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function writeEvidence(report, { corePaths = null } = {}) {
  fs.mkdirSync(corePaths?.hostDirectory ?? ARTIFACT_DIR, { recursive: true });
  const body = { ...report };
  const canonical = JSON.stringify(body, null, 2);
  body.reportSha256 = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex");
  const file = corePaths
    ? corePaths.reportPath
    : path.join(
        ARTIFACT_DIR,
        `e2e-report-${process.platform}-${process.arch}.json`,
      );
  const contents = `${JSON.stringify(body, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (corePaths) {
    const temporaryLatest = `${corePaths.latestReportPath}.${body.runId}.tmp`;
    fs.writeFileSync(temporaryLatest, contents);
    fs.rmSync(corePaths.latestReportPath, { force: true });
    fs.renameSync(temporaryLatest, corePaths.latestReportPath);
    console.log(
      `Core E2E evidence written to ${path.relative(REPO_ROOT, file)} (latest: ${path.relative(REPO_ROOT, corePaths.latestReportPath)})`,
    );
  } else {
    console.log(`E2E evidence written to ${path.relative(REPO_ROOT, file)}`);
  }
  return file;
}

function createTimingState() {
  return { started: process.hrtime.bigint(), stages: [], printed: false };
}

function timingFailed(value) {
  if (Array.isArray(value)) return value.some(timingFailed);
  return value?.status === "failed";
}

async function timedStage(timing, name, action) {
  const started = process.hrtime.bigint();
  let status = "passed";
  try {
    const value = await action();
    if (timingFailed(value)) status = "failed";
    return value;
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    timing.stages.push({
      name,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      status,
    });
  }
}

function timingReport(timing) {
  return {
    totalMs: Number(process.hrtime.bigint() - timing.started) / 1_000_000,
    stages: timing.stages.map((stage) => ({
      ...stage,
      durationMs: Math.round(stage.durationMs * 10) / 10,
    })),
  };
}

function printTimingSummary(timing, error = null) {
  if (timing.printed) return;
  const report = timingReport(timing);
  const slowest = [...report.stages]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5)
    .map(
      ({ name, durationMs, status }) =>
        `${name}=${(durationMs / 1000).toFixed(1)}s${status === "failed" ? " (failed)" : ""}`,
    );
  console.log(
    `E2E timing: total ${(report.totalMs / 1000).toFixed(1)}s; slowest stages: ${slowest.join(", ") || "none completed"}${error ? "; invocation failed" : ""}`,
  );
  timing.printed = true;
}

async function main(options = {}) {
  const timing = createTimingState();
  try {
    return await runE2e(timing, options);
  } catch (error) {
    printTimingSummary(timing, error);
    throw error;
  }
}

function requireTool(tool, found) {
  if (!found) throw new Error(`Core E2E requires a working ${tool} executable`);
}

async function runE2e(timing, options = {}) {
  const profileName = parseE2eProfile(process.argv.slice(2), process.env);
  if (process.env.SKIP_E2E === "1") {
    throw new Error(
      "SKIP_E2E=1 is not allowed. Unset it and run the unpackaged WebdriverIO suite.",
    );
  }
  const onlySpec = e2eOnlySpec(process.env.CONV2_E2E_ONLY);
  const selectedGroups = parseE2eGroups(process.argv.slice(2), process.env);
  const runId =
    options.runId ?? (process.env.CONV2_E2E_RUN_ID?.trim() || createE2eRunId());
  const corePaths = profileName ? coreArtifactPaths({ runId }) : null;
  const runPlan = profileName
    ? buildCoreRunPlan()
    : e2eRunPlan({ onlySpec, selectedGroups });
  const ownerEnabled = (owner) =>
    runPlan.fullSuite || runPlan.enabledOwners.includes(owner);
  // Set before any launch so every pass inherits it.
  const background = e2eBackgroundValue({
    env: process.env,
    platform: process.platform,
  });
  if (background !== null) process.env.CONV2_E2E_BACKGROUND = background;
  reexecUnderXvfb();
  const startedAt = new Date().toISOString();
  // The full suite is release evidence and must always run against a freshly
  // compiled binary. Reuse is limited to an explicitly selected ad-hoc spec.
  const reuseRequested = process.env.CONV2_E2E_REUSE === "1";
  await timedStage(timing, "build", () => {
    const reuse = mayReuseE2eBinary({
      onlySpec: Boolean(onlySpec) && selectedGroups.length === 0,
      reuseRequested,
      binaryFresh: !reuseRequested || e2eBinaryIsFresh(),
    });
    if (!reuse) buildE2eBinary();
    return { reusedBinary: reuse };
  });

  const ffmpeg = resolveTestFfmpeg();
  if (!ffmpeg) {
    throw new Error(
      "The E2E suite needs a real FFmpeg (bundled sidecar, CONV2_E2E_FFMPEG, or PATH).",
    );
  }
  const ffprobe = companionFfprobe(ffmpeg.binary) ?? which("ffprobe");
  if (runPlan.requiredTools?.includes("ffprobe")) {
    requireTool("FFprobe", ffprobe && fs.existsSync(ffprobe));
  }
  const probe = ffprobe
    ? spawnSync(ffprobe, ["-version"], { encoding: "utf8", windowsHide: true })
    : null;
  if (probe && probe.status !== 0) {
    throw new Error(
      `Core E2E could not run FFprobe: ${probe.stderr || probe.error?.message || "unknown error"}`,
    );
  }
  const screenshotDir = corePaths
    ? corePaths.screenshotDir
    : path.join(
        ARTIFACT_DIR,
        "screenshots",
        `${process.platform}-${process.arch}`,
      );
  // Full-run screenshots start empty; core paths are unique per invocation.
  if (!corePaths) fs.rmSync(screenshotDir, { recursive: true, force: true });
  fs.mkdirSync(screenshotDir, { recursive: true });

  const useSystemFfmpeg = ffmpeg.source === "system";
  const mainProfile = createE2eProfile({ useSystemFfmpeg });
  const fixtureDir = path.join(mainProfile.profileDir, "fixtures");
  const { fixtures, files: fixtureFiles } = await timedStage(
    timing,
    "fixtures",
    () => buildMediaFixtures({ ffmpeg: ffmpeg.binary, fixtureDir }),
  );
  const sharedEnv = buildSharedWdioEnv({
    ffmpeg,
    ffprobe,
    fixtures,
    fixtureFiles,
  });
  const runRecordedPass = (pass, env) =>
    timedStage(timing, `wdio:${pass.name}`, async () => {
      await runRecordedWdioPass(pass, env, sharedEnv);
      return pass;
    });

  const mainPass = {
    name: "main",
    profile: mainProfile,
    resultsPath: path.join(mainProfile.profileDir, "results.json"),
    status: "pending",
    reason: null,
  };
  const legacyPasses = buildLegacyPasses({
    onlySpec,
    ownerEnabled,
    useSystemFfmpeg,
  });

  let failure = null;
  try {
    for (const pass of legacyPasses) {
      await runRecordedPass(pass, {
        CONV2_E2E_SPECS: "./specs/legacy-import.spec.js",
        CONV2_E2E_LEGACY_CASE: pass.legacyCase,
        CONV2_E2E_LEGACY_V1: JSON.stringify(pass.seed),
        CONV2_E2E_SCREENSHOTS: screenshotDir,
      });
    }
    if (onlySpec || ownerEnabled("main")) {
      await runRecordedPass(mainPass, {
        // CONV2_E2E_ONLY runs one ad-hoc spec while debugging; the full gate
        // always runs main.spec.js and requires every scenario.
        CONV2_E2E_SPECS: runPlan.mainSpecs,
        CONV2_E2E_SCREENSHOTS: screenshotDir,
        ...(runPlan.mainMochaTitles
          ? {
              CONV2_E2E_MOCHA_TITLES: JSON.stringify(
                runPlan.mainMochaTitles.map((entry) => entry.title),
              ),
            }
          : {}),
      });
    }
  } catch (error) {
    // Only an error outside the pass runs reaches here.
    failure = error instanceof Error ? error.message : String(error);
  }
  const wdioPasses = [...legacyPasses, mainPass];
  for (const pass of wdioPasses) {
    if (pass.status !== "failed") continue;
    const detail = `${pass.name}: ${pass.reason}`;
    failure = failure ? `${failure}; ${detail}` : detail;
  }

  const { expectedScenarios, fullSuite } = runPlan;
  const readResults = (file) =>
    fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const readLogTail = (pass, lines) => {
    const file = path.join(pass.profile.dataDir, "logs", "conv2.log");
    return fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines)
      : [];
  };
  const scenarios = [
    ...legacyPasses,
    ...(onlySpec || ownerEnabled("main") ? [mainPass] : []),
  ].flatMap((pass) => readResults(pass.resultsPath));
  const seen = new Set(scenarios.map((scenario) => scenario.name));
  const missing = expectedScenarios.filter((name) => !seen.has(name));
  const legacyImportCoverage = Object.fromEntries(
    Object.entries(LEGACY_IMPORT_FAILURE_MODES).map(([id, description]) => [
      id,
      {
        description,
        coveredBy: scenarios
          .filter((scenario) => scenario.covers?.includes(id))
          .map((scenario) => scenario.name),
      },
    ]),
  );
  const checksLegacyImportCoverage =
    fullSuite || runPlan.enabledOwners.includes("legacy-import");
  const uncovered = checksLegacyImportCoverage
    ? Object.entries(legacyImportCoverage)
        .filter(([, mode]) => mode.coveredBy.length === 0)
        .map(([id]) => id)
    : [];
  const { screenshots, problems: screenshotProblems } = verifyScreenshots(
    scenarios,
    screenshotDir,
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const scenarioProblems =
    fullSuite || selectedGroups.length > 0 || profileName !== null
      ? scenarioOutcomeProblems(scenarios, process.platform, expectedScenarios)
      : onlyRunScenarioProblems({
          onlySpec,
          scenarios,
          platform: process.platform,
        });
  const legacyPassLogTails = Object.fromEntries(
    legacyPasses.map((pass) => [pass.legacyCase, readLogTail(pass, 15)]),
  );
  const appLogTail = readLogTail(mainPass, 40);
  await timedStage(timing, "cleanup:profiles", () => {
    for (const pass of wdioPasses) cleanupProfile(pass.profile.profileDir);
    return {};
  });
  const evidence = writeEvidence(
    {
      app: "CONV2",
      fullSuite,
      runId,
      ...(profileName ? { profile: profileName } : {}),
      ...(corePaths
        ? {
            runDirectory: relativeToRepo(corePaths.runDir),
            reportPath: relativeToRepo(corePaths.reportPath),
          }
        : {}),
      // Present only on partial runs, so full-gate evidence keeps its shape.
      ...(onlySpec ? { onlySpec } : {}),
      ...(selectedGroups.length > 0
        ? { selectedGroups, selectedOwners: runPlan.enabledOwners }
        : {}),
      expectedScenarios,
      version: packageJson.version,
      commit: gitCommit(),
      sourceTree: gitSourceTree(),
      packageLockSha256: sha256(
        fs.readFileSync(path.join(REPO_ROOT, "package-lock.json")),
      ),
      cargoLockSha256: sha256(
        fs.readFileSync(path.join(REPO_ROOT, "src-tauri", "Cargo.lock")),
      ),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      binarySha256: sha256(fs.readFileSync(e2eBinaryPath())),
      startedAt,
      ...(runPlan.requiredTools
        ? { requiredTools: runPlan.requiredTools }
        : {}),
      ffmpeg: { source: ffmpeg.source, binary: path.basename(ffmpeg.binary) },
      ffprobe: ffprobe ? { binary: path.basename(ffprobe) } : null,
      fixtures,
      scenarios,
      // Each WebdriverIO pass that ran, with its own outcome. Scenario results
      // come from the pass results files, so a failed pass still reports
      // whatever scenarios it wrote.
      wdioPasses: wdioPasses
        .filter((pass) => pass.status !== "pending")
        .map(({ name, status, reason }) => ({ name, status, reason })),
      scenarioGroups: groupedScenarioResults(scenarios, expectedScenarios),
      missingScenarios: missing,
      scenarioProblems,
      legacyImportCoverage,
      uncoveredLegacyImportFailureModes: uncovered,
      screenshots,
      screenshotProblems,
      failure,
      passed:
        !failure &&
        missing.length === 0 &&
        scenarioProblems.length === 0 &&
        uncovered.length === 0 &&
        screenshotProblems.length === 0,
      legacyPassLogTails,
      appLogTail,
      finishedAt: new Date().toISOString(),
      timings: timingReport(timing),
    },
    { corePaths },
  );
  printTimingSummary(
    timing,
    failure ||
      missing.length > 0 ||
      scenarioProblems.length > 0 ||
      uncovered.length > 0 ||
      screenshotProblems.length > 0
      ? new Error("E2E validation failed")
      : null,
  );
  if (failure) throw new Error(`${failure} (evidence: ${evidence})`);
  if (missing.length > 0) {
    throw new Error(
      `E2E scenarios did not report: ${missing.join(", ")} (evidence: ${evidence})`,
    );
  }
  if (scenarioProblems.length > 0) {
    throw new Error(
      `E2E scenario outcomes are incomplete or unsuccessful: ${scenarioProblems.join(", ")} (evidence: ${evidence})`,
    );
  }
  if (uncovered.length > 0) {
    throw new Error(
      `CONV2 1 import failure modes without a covering scenario: ${uncovered.join(", ")} (evidence: ${evidence})`,
    );
  }
  if (screenshotProblems.length > 0) {
    throw new Error(
      `Screenshot evidence is inconsistent: ${screenshotProblems.join(", ")} (evidence: ${evidence})`,
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  Promise.resolve()
    .then(() => {
      const times = parseRepeat(process.argv.slice(2));
      const profile = parseE2eProfile(process.argv.slice(2), process.env);
      return times > 1 ? runStability(times, main, { profile }) : main();
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
