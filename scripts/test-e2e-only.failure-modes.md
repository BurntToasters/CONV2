# CONV2_E2E_ONLY gate verdict failure inventory

The gate must judge a `CONV2_E2E_ONLY` run by the selected spec alone, and must
never let that run pass as full proof. These failures must be caught:

1. **Full list leaks into ONLY mode.** `expectedScenarios` still holds every
   suite in `EXPECTED_SCENARIOS`, so each skipped suite is reported missing and
   a passing spec exits 1. Check: ONLY mode expects no suite by name.
2. **Full list leaks into full mode.** Changing the expectation for ONLY mode
   drops or reorders suites when `CONV2_E2E_ONLY` is unset. Check: full mode
   returns `EXPECTED_SCENARIOS`, unchanged and in order.
3. **Partial run reads as full proof.** An ONLY run writes `fullSuite: true`,
   so `release-session.js` `verifyFullE2eEvidence` accepts it. Check: ONLY mode
   writes `fullSuite: false`; full mode writes `fullSuite: true`.
4. **Partial run hides its scope.** The report looks like a full run with an
   empty `expectedScenarios`. Check: ONLY mode records the selected spec in
   `onlySpec`; full mode adds no new evidence key.
5. **Blank selector treated as ONLY.** `CONV2_E2E_ONLY=""` or `"   "` disables
   the full gate but runs no spec. Check: blank values are unset everywhere.
6. **Padded spec path passed through raw.** `" ./specs/main.spec.js "` reaches
   WebdriverIO with spaces and matches no file. Check: the spec is trimmed
   before use.
7. **Empty selector sent to WebdriverIO.** An empty `CONV2_E2E_SPECS` makes
   `wdio.conf.js` run every spec glob. Check: the main pass always gets a
   non-empty spec list.
8. **Main spec judged by an empty report.** A `main.spec.js` ONLY run that
   reports nothing passes. Check: ONLY mode with no reported scenarios fails.
9. **Failed scenario passes in ONLY mode.** A reported `failed` or unallowed
   `skipped` status is ignored. Check: any such status fails the run.
10. **Duplicate scenario ignored.** The same name reported twice passes.
    Check: duplicate names fail, as in full mode.
11. **A skip passes.** No scenario may skip on any platform, so a skipped
    scenario fails in ONLY and full mode alike. Check: `ALLOWED_E2E_SKIPS` is
    empty and a `skipped` status is reported as unacceptable.
12. **ONLY combined with a feature group.** The two selections contradict each
    other. Check: `e2eRunPlan` throws "cannot be combined".
13. **Gate scenarios leak into ONLY mode.** Legacy-import passes appear in an
    ONLY run and fail it. Check: those passes stay empty in ONLY mode.
14. **Stability runs carry the flag.** `--repeat` with ONLY set reports full
    coverage. Check: each repeated run uses the same ONLY rules.
