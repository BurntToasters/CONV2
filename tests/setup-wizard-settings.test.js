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
  assert.match(html, /data-wizard-step="7"/);
  assert.match(html, /src="setupWizard\.js"/);
  assert.match(html, /src="\.\.\/shared\/queueSummary\.js"/);
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
