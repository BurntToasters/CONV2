// E2E suite manifest, feature groups, run plan, and scenario outcome checks.
// The gate (scripts/test-e2e.js) reads e2e/suites.json through this module.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { sha256 } from "../../e2e/helpers/hash.js";

const SUITE_MANIFEST_PATH = path.join(REPO_ROOT, "e2e", "suites.json");
export const E2E_SUITE_MANIFEST = JSON.parse(
  fs.readFileSync(SUITE_MANIFEST_PATH, "utf8"),
);

const PLATFORMS = ["darwin", "linux", "win32"];

function fail(message) {
  throw new Error(`e2e/suites.json ${message}`);
}

export function validateSuiteManifest(manifest) {
  if (manifest?.schemaVersion !== 1) fail("has an unsupported schemaVersion");
  if (!Array.isArray(manifest.scenarios) || !Array.isArray(manifest.groups)) {
    fail("must define scenarios and groups arrays");
  }
  const ownerIds = new Set(Object.keys(manifest.owners ?? {}));
  const groupIds = new Set();
  for (const group of manifest.groups) {
    if (!group?.id || groupIds.has(group.id)) {
      fail(`has a missing or duplicate group id: ${group?.id}`);
    }
    groupIds.add(group.id);
    if (!Array.isArray(group.owners)) {
      fail(`group ${group.id} has an invalid owner list`);
    }
    for (const owner of group.owners) {
      if (!ownerIds.has(owner)) {
        fail(`group ${group.id} has unknown owner ${owner}`);
      }
    }
  }
  const names = new Set();
  for (const scenario of manifest.scenarios) {
    if (!scenario?.name || names.has(scenario.name)) {
      fail(`has a missing or duplicate scenario: ${scenario?.name}`);
    }
    names.add(scenario.name);
    if (!groupIds.has(scenario.feature) || !ownerIds.has(scenario.owner)) {
      fail(`scenario ${scenario.name} has an unknown feature or owner`);
    }
    if (!Array.isArray(scenario.allowedSkips)) {
      fail(`scenario ${scenario.name} has invalid skip allowances`);
    }
    if (
      scenario.allowedSkips.some((platform) => !PLATFORMS.includes(platform))
    ) {
      fail(`scenario ${scenario.name} has an unknown platform allowance`);
    }
  }
  for (const group of manifest.groups) {
    const scenarioOwners = new Set(
      manifest.scenarios
        .filter((scenario) => scenario.feature === group.id)
        .map((scenario) => scenario.owner),
    );
    if ([...scenarioOwners].some((owner) => !group.owners.includes(owner))) {
      fail(`group ${group.id} omits a scenario owner`);
    }
  }
  for (const [profileId, profile] of Object.entries(manifest.profiles ?? {})) {
    const mainIds = profile.mainScenarioIds;
    const titles = profile.mainMochaTitles;
    if (
      !Array.isArray(mainIds) ||
      mainIds.length === 0 ||
      new Set(mainIds).size !== mainIds.length ||
      !titles ||
      typeof titles !== "object" ||
      Array.isArray(titles)
    ) {
      fail(`profile ${profileId} is invalid`);
    }
    if (
      Object.keys(titles).length !== mainIds.length ||
      mainIds.some(
        (name) =>
          manifest.scenarios.find((scenario) => scenario.name === name)
            ?.owner !== "main" ||
          typeof titles[name] !== "string" ||
          !titles[name].trim(),
      ) ||
      new Set(mainIds.map((name) => titles[name])).size !== mainIds.length
    ) {
      fail(`profile ${profileId} has invalid main scenario/title mappings`);
    }
    if (
      !Array.isArray(profile.completeOwners) ||
      profile.completeOwners.length === 0 ||
      new Set(profile.completeOwners).size !== profile.completeOwners.length ||
      profile.completeOwners.some(
        (owner) => owner === "main" || !ownerIds.has(owner),
      ) ||
      !Array.isArray(profile.requiredTools) ||
      profile.requiredTools.some(
        (tool) => typeof tool !== "string" || !tool.trim(),
      )
    ) {
      fail(`profile ${profileId} has invalid owners or required tools`);
    }
  }
}

validateSuiteManifest(E2E_SUITE_MANIFEST);

export const EXPECTED_SCENARIOS = E2E_SUITE_MANIFEST.scenarios.map(
  (scenario) => scenario.name,
);
export const ALLOWED_E2E_SKIPS = Object.freeze(
  Object.fromEntries(
    E2E_SUITE_MANIFEST.scenarios
      .filter((scenario) => scenario.allowedSkips.length > 0)
      .map((scenario) => [scenario.name, Object.freeze(scenario.allowedSkips)]),
  ),
);

export function groupedScenarioResults(scenarios, expectedScenarios) {
  const expected = new Set(expectedScenarios);
  return Object.fromEntries(
    E2E_SUITE_MANIFEST.groups.map((group) => {
      const groupNames = E2E_SUITE_MANIFEST.scenarios
        .filter((scenario) => scenario.feature === group.id)
        .map((scenario) => scenario.name)
        .filter((name) => expected.has(name));
      const reported = scenarios.filter((scenario) =>
        groupNames.includes(scenario?.name),
      );
      const reportedNames = new Set(reported.map((scenario) => scenario.name));
      return [
        group.id,
        {
          expectedScenarios: groupNames,
          reportedScenarios: reported,
          missingScenarios: groupNames.filter(
            (name) => !reportedNames.has(name),
          ),
        },
      ];
    }),
  );
}

export function scenarioOutcomeProblems(
  scenarios,
  platform,
  expected = EXPECTED_SCENARIOS,
) {
  const problems = [];
  const names = scenarios.map((scenario) => scenario?.name);
  for (const name of expected) {
    const count = names.filter((candidate) => candidate === name).length;
    if (count !== 1) {
      problems.push(`${name} reported ${count} times`);
      continue;
    }
    const scenario = scenarios.find((candidate) => candidate?.name === name);
    if (scenario.status === "passed") continue;
    const allowedPlatforms = ALLOWED_E2E_SKIPS[name] ?? [];
    if (scenario.status === "skipped" && allowedPlatforms.includes(platform)) {
      continue;
    }
    problems.push(`${name} has unacceptable status ${scenario.status}`);
  }
  for (const name of names) {
    if (!expected.includes(name)) problems.push(`unexpected scenario ${name}`);
  }
  return problems;
}

/** A blank CONV2_E2E_ONLY means the full gate, as if it were unset. */
export function e2eOnlySpec(value) {
  const spec = typeof value === "string" ? value.trim() : "";
  return spec === "" ? null : spec;
}

/** Read one or more manifest feature groups from CLI arguments or the env. */
export function parseE2eGroups(argv, env = process.env) {
  const fromArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--group") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--group needs a comma-separated feature group list");
      }
      fromArgs.push(value);
      index += 1;
    } else if (argument.startsWith("--group=")) {
      const value = argument.slice("--group=".length);
      if (value.trim() === "") {
        throw new Error("--group needs a comma-separated feature group list");
      }
      fromArgs.push(value);
    }
  }
  const rawGroups =
    fromArgs.length > 0 ? fromArgs : [env.CONV2_E2E_GROUPS ?? ""];
  const groups = rawGroups.flatMap((value) => value.split(","));
  const normalized = groups.map((group) => group.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("E2E feature groups must not be listed more than once");
  }
  return normalized;
}

/**
 * The full gate keeps the complete inventory. Ad-hoc specs and manifest group
 * selections are always partial, so neither report can pass as release proof.
 */
export function e2eRunPlan({ onlySpec, selectedGroups = [] }) {
  if (onlySpec !== null && selectedGroups.length > 0) {
    throw new Error(
      "CONV2_E2E_ONLY cannot be combined with --group or CONV2_E2E_GROUPS",
    );
  }
  if (onlySpec === null && selectedGroups.length === 0) {
    return {
      fullSuite: true,
      mainSpecs: "./specs/main.spec.js",
      expectedScenarios: [...EXPECTED_SCENARIOS],
      enabledOwners: Object.keys(E2E_SUITE_MANIFEST.owners),
      selectedGroups: [],
    };
  }
  if (onlySpec !== null) {
    return {
      fullSuite: false,
      mainSpecs: onlySpec,
      expectedScenarios: [],
      enabledOwners: [],
      selectedGroups: [],
    };
  }
  const groupsById = new Map(
    E2E_SUITE_MANIFEST.groups.map((group) => [group.id, group]),
  );
  const unknownGroups = selectedGroups.filter(
    (group) => !groupsById.has(group),
  );
  if (unknownGroups.length > 0) {
    throw new Error(
      `unknown E2E feature group(s): ${unknownGroups.join(", ")}`,
    );
  }
  const enabledOwners = new Set(
    selectedGroups.flatMap((group) => groupsById.get(group).owners),
  );
  return {
    fullSuite: false,
    mainSpecs: "./specs/main.spec.js",
    expectedScenarios: E2E_SUITE_MANIFEST.scenarios
      .filter((scenario) => enabledOwners.has(scenario.owner))
      .map((scenario) => scenario.name),
    enabledOwners: [...enabledOwners],
    selectedGroups,
  };
}

/**
 * Verdict for an ad-hoc run: it must report at least one scenario, and each
 * reported scenario must pass as it would in the full gate.
 */
export function onlyRunScenarioProblems({ onlySpec, scenarios, platform }) {
  if (scenarios.length === 0) return [`${onlySpec} reported no scenarios`];
  const names = [...new Set(scenarios.map((scenario) => scenario?.name))];
  return scenarioOutcomeProblems(scenarios, platform, names);
}

/** Scenarios whose `shots` the gate re-hashes. */
export const SCREENSHOT_SCENARIO_NAMES = Object.freeze(["ui-screenshots"]);

/**
 * Re-hash every screenshot the spec reported, so the evidence report vouches
 * for the PNGs actually on disk. Returns the list and any mismatch problems.
 */
export function verifyScreenshots(scenarios, directory) {
  const reported = scenarios
    .filter((scenario) => SCREENSHOT_SCENARIO_NAMES.includes(scenario?.name))
    .flatMap((scenario) =>
      Array.isArray(scenario.shots) ? scenario.shots : [],
    );
  const problems = [];
  const screenshots = reported.map((shot) => {
    const file = path.join(directory, shot.file);
    if (!fs.existsSync(file)) {
      problems.push(`${shot.file} is missing`);
      return { ...shot, path: path.relative(REPO_ROOT, file) };
    }
    const actual = sha256(fs.readFileSync(file));
    if (actual !== shot.sha256) problems.push(`${shot.file} changed on disk`);
    return {
      name: shot.name,
      path: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
      sha256: actual,
      bytes: fs.statSync(file).size,
    };
  });
  return { screenshots, problems };
}
