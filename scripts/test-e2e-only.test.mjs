import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_E2E_SKIPS,
  EXPECTED_SCENARIOS,
  e2eOnlySpec,
  e2eRunPlan,
  onlyRunScenarioProblems,
  scenarioOutcomeProblems,
} from "./test-e2e.js";

test("blank CONV2_E2E_ONLY values mean the full gate", () => {
  for (const value of [undefined, "", "   ", "\n\t"]) {
    assert.equal(e2eOnlySpec(value), null, JSON.stringify(value));
  }
});

test("CONV2_E2E_ONLY spec is trimmed and kept otherwise", () => {
  assert.equal(e2eOnlySpec(" ./specs/main.spec.js "), "./specs/main.spec.js");
});

test("full mode keeps the complete inventory and full-suite flag", () => {
  const plan = e2eRunPlan({ onlySpec: null });
  assert.equal(plan.fullSuite, true);
  assert.equal(plan.mainSpecs, "./specs/main.spec.js");
  assert.deepEqual(plan.expectedScenarios, EXPECTED_SCENARIOS);
  assert.deepEqual(plan.enabledOwners.sort(), ["legacy-import", "main"]);
});

test("full mode still rejects a run that reports only one suite", () => {
  const plan = e2eRunPlan({ onlySpec: null });
  const problems = scenarioOutcomeProblems(
    [{ name: "startup", status: "passed" }],
    "linux",
    plan.expectedScenarios,
  );
  assert.ok(problems.includes("legacy-import/import reported 0 times"));
  assert.ok(problems.includes("preset-matrix reported 0 times"));
});

test("ONLY mode is partial and expects no named suites", () => {
  const plan = e2eRunPlan({ onlySpec: "./specs/main.spec.js" });
  assert.equal(plan.fullSuite, false);
  assert.equal(plan.mainSpecs, "./specs/main.spec.js");
  assert.deepEqual(plan.expectedScenarios, []);
});

test("ONLY and a feature group cannot be combined", () => {
  assert.throws(
    () =>
      e2eRunPlan({ onlySpec: "./specs/main.spec.js", selectedGroups: ["ui"] }),
    /cannot be combined/i,
  );
});

test("ONLY spec with no reported scenarios fails", () => {
  const problems = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [],
    platform: "linux",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reported no scenarios/);
});

test("ONLY spec passes when every reported scenario passed", () => {
  const problems = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [
      { name: "startup", status: "passed" },
      { name: "settings-patch", status: "passed" },
    ],
    platform: "linux",
  });
  assert.deepEqual(problems, []);
});

test("ONLY spec fails on a failed or skipped scenario", () => {
  assert.deepEqual(
    onlyRunScenarioProblems({
      onlySpec: "./specs/main.spec.js",
      scenarios: [{ name: "startup", status: "failed" }],
      platform: "linux",
    }),
    ["startup has unacceptable status failed"],
  );
  assert.deepEqual(
    onlyRunScenarioProblems({
      onlySpec: "./specs/main.spec.js",
      scenarios: [{ name: "preset-matrix", status: "skipped" }],
      platform: "win32",
    }),
    ["preset-matrix has unacceptable status skipped"],
  );
});

test("no scenario may skip on any platform", () => {
  assert.deepEqual(ALLOWED_E2E_SKIPS, {});
});

test("ONLY spec rejects a scenario reported twice", () => {
  const problems = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [
      { name: "startup", status: "passed" },
      { name: "startup", status: "passed" },
    ],
    platform: "linux",
  });
  assert.deepEqual(problems, ["startup reported 2 times"]);
});
