// Accessibility E2E: axe-core (WCAG 2.2 A/AA rules) against the real app in every theme and dialog.
// Artifact: coverage/e2e/a11y-report.json.
//
// Failure modes pinned here:
//  - no <main> landmark / content outside landmarks
//  - text below 4.5:1 contrast in any theme (dark, light, midnight-blue, high-contrast-dark)
//  - dialogs without accessible names, unlabeled form controls, duplicate ids
//  - prefers-contrast: more is ignored
//  - prefers-reduced-motion still animates
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const axeSource = require('axe-core').source;
const { launchApp, returningUserSettings } = require('./app.js');
const { writeArtifact } = require('./helpers.js');

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const THEMES = [
  { theme: 'dark' },
  { theme: 'light' },
  { theme: 'custom', customTheme: 'midnight-blue' },
  { theme: 'custom', customTheme: 'high-contrast-dark' },
];
const report = { axe: require('axe-core').version, tags: WCAG_TAGS, runs: [] };

after(() => writeArtifact('a11y-report.json', report));

async function runAxe(window, label, extraRules = {}) {
  // Let finite entrance animations settle; looping ones (spinners) never finish.
  await window.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined))
    )
  );
  await window.evaluate(axeSource);
  const result = await window.evaluate(
    async ({ tags, rules }) => {
      const r = await globalThis.axe.run(document, {
        runOnly: { type: 'tag', values: tags },
        rules,
        resultTypes: ['violations'],
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes
          .slice(0, 5)
          .map((n) => ({ target: n.target.join(' '), summary: n.failureSummary })),
      }));
    },
    { tags: WCAG_TAGS, rules: extraRules }
  );
  report.runs.push({ label, violations: result });
  return result;
}

const describe = (violations) =>
  violations
    .map(
      (v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target).join('\n    ')}`
    )
    .join('\n');

for (const variant of THEMES) {
  const name = variant.customTheme || variant.theme;
  test(`main window has no WCAG 2.2 AA violations (${name})`, { timeout: 60_000 }, async () => {
    const ctx = await launchApp({
      settings: returningUserSettings(variant),
      label: `a11y-${name}`,
    });
    try {
      await ctx.window.click('#presetPanelToggle');
      // Each preset family renders different intent badges; check them all.
      const families = await ctx.window.locator('.preset-parent-btn').count();
      assert.ok(families > 0);
      for (let i = 0; i < families; i += 1) {
        await ctx.window.locator('.preset-parent-btn').nth(i).click();
        const violations = await runAxe(ctx.window, `main:${name}:family-${i}`, {
          'landmark-one-main': { enabled: true },
          region: { enabled: true },
        });
        assert.deepEqual(violations, [], `family ${i}\n${describe(violations)}`);
      }
    } finally {
      await ctx.close();
    }
  });
}

test('settings dialog has no WCAG 2.2 AA violations', { timeout: 60_000 }, async () => {
  const ctx = await launchApp({
    settings: returningUserSettings({ theme: 'dark' }),
    label: 'a11y-settings',
  });
  try {
    await ctx.window.click('#settingsBtn');
    await ctx.window.locator('#settingsModal.visible').waitFor();
    const byTab = {};
    for (const tab of ['#settingsGeneralTab', '#settingsAdvancedFormatsTab', '#settingsDebugTab']) {
      await ctx.window.click(tab);
      byTab[tab] = await runAxe(ctx.window, `settings:${tab}`);
    }
    for (const [tab, violations] of Object.entries(byTab)) {
      assert.deepEqual(violations, [], `${tab}\n${describe(violations)}`);
    }
  } finally {
    await ctx.close();
  }
});

test('the main landmark wraps the primary content', { timeout: 60_000 }, async () => {
  const ctx = await launchApp({ settings: returningUserSettings(), label: 'a11y-landmark' });
  try {
    const landmark = await ctx.window.evaluate(() => {
      const main = document.querySelector('main');
      return (
        main &&
        ['dropZone', 'presetPanelSection', 'convertBtn', 'statusMessage'].every((id) =>
          main.contains(document.getElementById(id))
        )
      );
    });
    assert.equal(landmark, true);
  } finally {
    await ctx.close();
  }
});

test('prefers-contrast: more strengthens muted text and borders', { timeout: 60_000 }, async () => {
  const ctx = await launchApp({
    settings: returningUserSettings({ theme: 'dark' }),
    label: 'a11y-contrast',
  });
  try {
    const read = () =>
      ctx.window.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          muted: style.getPropertyValue('--text-muted').trim(),
          border: style.getPropertyValue('--border-subtle').trim(),
        };
      });
    const normal = await read();
    await ctx.window.emulateMedia({ contrast: 'more' });
    const more = await read();
    assert.ok(more.muted && more.border, `unresolved token: ${JSON.stringify(more)}`);
    assert.notEqual(more.muted, normal.muted, 'muted text unchanged under prefers-contrast: more');
    assert.notEqual(more.border, normal.border, 'borders unchanged under prefers-contrast: more');
    const violations = await runAxe(ctx.window, 'main:prefers-contrast-more');
    assert.deepEqual(violations, [], describe(violations));
  } finally {
    await ctx.close();
  }
});

test(
  'prefers-reduced-motion disables animations and transitions',
  { timeout: 60_000 },
  async () => {
    const ctx = await launchApp({ settings: returningUserSettings(), label: 'a11y-motion' });
    try {
      await ctx.window.emulateMedia({ reducedMotion: 'reduce' });
      const durations = await ctx.window.evaluate(() =>
        [...document.querySelectorAll('button, .preset-card, .status-message, .progress-fill')]
          .map((el) => getComputedStyle(el))
          .flatMap((s) => [s.transitionDuration, s.animationDuration])
          .flatMap((value) => value.split(',').map((part) => parseFloat(part) || 0))
      );
      assert.ok(durations.length > 0);
      assert.ok(Math.max(...durations) <= 0.01, `max duration ${Math.max(...durations)}s`);
    } finally {
      await ctx.close();
    }
  }
);
