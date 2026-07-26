const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SETTINGS_SCHEMA_VERSION,
  normalizeSetupWizardCompleted,
} = require('../dist/main/settingsSchema.js');

test('settings schema version includes setup wizard flag', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 6);
});

test('normalizeSetupWizardCompleted defaults for explicit values', () => {
  assert.equal(normalizeSetupWizardCompleted(false, true), false);
  assert.equal(normalizeSetupWizardCompleted(true, true), true);
});

test('normalizeSetupWizardCompleted treats missing legacy key as completed', () => {
  assert.equal(normalizeSetupWizardCompleted(undefined, false), true);
});

test('normalizeSetupWizardCompleted treats invalid explicit key as not completed', () => {
  assert.equal(normalizeSetupWizardCompleted('yes', true), false);
});

test('createDefaultSettings includes setupWizardCompleted false', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.ts'), 'utf8');
  assert.match(mainSource, /setupWizardCompleted:\s*false/);
});

test('setup wizard DOM contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(html, /id="setupWizardModal"/);
  assert.match(html, /id="replaySetupWizardBtn"/);
  assert.match(html, /data-wizard-step="9"/);
  assert.match(html, /data-wizard-presentation="spotlight"/);
  assert.match(html, /id="setupWizardSkipBtn"/);
  assert.match(html, /setup-wizard-step-skip/);
  assert.match(html, /src="setupWizard\.js"/);
  assert.match(html, /src="\.\.\/shared\/queueSummary\.js"/);
});

test('setup wizard step indices align with SETUP_WIZARD_STEP_COUNT', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const wizardSource = fs.readFileSync(
    path.join(__dirname, '../src/renderer/setupWizard.ts'),
    'utf8'
  );
  const countMatch = wizardSource.match(/SETUP_WIZARD_STEP_COUNT = (\d+)/);
  assert.ok(countMatch, 'SETUP_WIZARD_STEP_COUNT must be defined');
  const stepCount = Number(countMatch[1]);
  const steps = [...html.matchAll(/data-wizard-step="(\d+)"/g)].map((match) => Number(match[1]));
  const uniqueSteps = [...new Set(steps)].sort((a, b) => a - b);
  assert.equal(uniqueSteps.length, stepCount);
  for (let index = 0; index < stepCount; index += 1) {
    assert.equal(uniqueSteps[index], index, `missing setup wizard step ${index}`);
  }
});

test('setup wizard spotlight targets exist in main window markup', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const targets = [...html.matchAll(/data-spotlight-target="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length > 0, 'expected at least one spotlight step');
  for (const targetId of targets) {
    assert.match(
      html,
      new RegExp(`id="${targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      `spotlight target #${targetId} must exist`
    );
  }
});

test('setup wizard spotlight mode must block main UI pointer events', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/main.css'), 'utf8');
  assert.match(css, /\.setup-wizard-overlay\.spotlight-mode\s*\{[^}]*pointer-events:\s*auto/s);
  assert.doesNotMatch(
    css,
    /\.setup-wizard-overlay\.spotlight-mode\s*\{[^}]*pointer-events:\s*none/s
  );
  assert.match(css, /\.setup-wizard-spotlight-layer\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.setup-wizard-dialog\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});

test('replay setup tour closes settings first', () => {
  const rendererSource = fs.readFileSync(
    path.join(__dirname, '../src/renderer/renderer.ts'),
    'utf8'
  );
  assert.match(
    rendererSource,
    /replaySetupWizardBtn[\s\S]*closeSettingsModal\(\)[\s\S]*openSetupWizard\(\)/
  );
});

test('setup wizard uses class-based ffmpeg note for spotlight clones', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const wizardSource = fs.readFileSync(
    path.join(__dirname, '../src/renderer/setupWizard.ts'),
    'utf8'
  );
  assert.match(html, /wizard-ffmpeg-note/);
  assert.doesNotMatch(html, /id="wizardFfmpegNote"/);
  assert.match(wizardSource, /\.wizard-ffmpeg-note/);
  assert.match(wizardSource, /clone\.removeAttribute\('id'\)/);
  assert.match(wizardSource, /wizardCompleting/);
  assert.match(wizardSource, /addEventListener\('scroll'/);
});

test('setup wizard blocks other modals while visible', () => {
  const rendererSource = fs.readFileSync(
    path.join(__dirname, '../src/renderer/renderer.ts'),
    'utf8'
  );
  assert.match(rendererSource, /isSetupWizardBlockingUi/);
  assert.match(rendererSource, /hasBlockingModalForShortcuts[\s\S]*isSetupWizardBlockingUi\(\)/);
  assert.match(rendererSource, /openSettingsModal[\s\S]*isSetupWizardBlockingUi\(\)[\s\S]*return;/);
});

test('setup wizard clears spotlight chrome on close and reopen', () => {
  const wizardSource = fs.readFileSync(
    path.join(__dirname, '../src/renderer/setupWizard.ts'),
    'utf8'
  );
  assert.match(wizardSource, /resetSpotlightChromeStyles/);
  assert.match(wizardSource, /detachSpotlightTargetObserver/);
  assert.match(wizardSource, /ResizeObserver/);
  assert.match(wizardSource, /openSetupWizard[\s\S]*clearSpotlightLayout\(\)/);
});

test('renderer bundle must not redeclare helper script globals', () => {
  const rendererJs = fs.readFileSync(path.join(__dirname, '../dist/renderer/renderer.js'), 'utf8');
  const reserved = [
    'initSetupWizard',
    'maybeOpenSetupWizard',
    'openSetupWizard',
    'isSetupWizardVisible',
    'getSetupWizardOverlay',
    'skipSetupWizardFromEscape',
    'summarizeQueueForUiStatus',
    'countQueueOutcomes',
    'summarizeQueueForNotification',
  ];
  for (const name of reserved) {
    assert.doesNotMatch(
      rendererJs,
      new RegExp(`const ${name}\\s*=`),
      `renderer.js must not declare const ${name} (shared global scope with script tags)`
    );
  }
});

test('renderer bundle must not use CommonJS require (no nodeIntegration)', () => {
  const rendererJs = fs.readFileSync(path.join(__dirname, '../dist/renderer/renderer.js'), 'utf8');
  assert.equal(
    /require\s*\(/.test(rendererJs),
    false,
    'renderer.js must not call require(); load helpers via script tags + window globals'
  );
});
