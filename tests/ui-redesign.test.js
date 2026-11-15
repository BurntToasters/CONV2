const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SETTINGS_SCHEMA_VERSION,
  MAX_RECENT_PRESET_IDS,
  normalizeRecentPresetIds,
  normalizeUiPanels,
  isSettingsCorrupted,
  isSettingsSchemaOutdated,
} = require('../dist/main/settingsSchema.js');
const {
  getAutoVendorPriority,
  recommendGpuVendorFromAvailability,
} = require('../dist/main/gpuRecommendation.js');
const { presets } = require('../dist/main/presets.js');
const { mapPresetsForRenderer } = require('../dist/main/presetProjection.js');

test('settings schema hard reset check is version-gated', () => {
  assert.equal(isSettingsCorrupted(null), true);
  assert.equal(isSettingsCorrupted({}), false);
  assert.equal(isSettingsSchemaOutdated({ settingsSchemaVersion: 1 }), true);
  assert.equal(
    isSettingsSchemaOutdated({
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      outputDirectory: '/tmp',
    }),
    false
  );
});

test('recent preset normalization dedupes, trims, and caps size', () => {
  const result = normalizeRecentPresetIds([
    ' av1-balanced ',
    'h264-fast',
    'av1-balanced',
    '',
    '   ',
    'h265-quality',
    'audio-mp3',
    'audio-aac',
    'audio-flac',
    'remux-mp4',
    'remux-mkv',
    'remux-webm',
    'gif-quality',
  ]);

  assert.equal(result.length, MAX_RECENT_PRESET_IDS);
  assert.deepEqual(result.slice(0, 4), ['av1-balanced', 'h264-fast', 'h265-quality', 'audio-mp3']);
});

test('ui panel normalization defaults to collapsed for missing values', () => {
  assert.deepEqual(normalizeUiPanels(undefined), {
    presetExpanded: false,
    gpuExpanded: false,
  });
  assert.deepEqual(normalizeUiPanels({}), {
    presetExpanded: false,
    gpuExpanded: false,
  });
});

test('ui panel normalization only accepts true values', () => {
  assert.deepEqual(
    normalizeUiPanels({
      presetExpanded: true,
      gpuExpanded: false,
    }),
    {
      presetExpanded: true,
      gpuExpanded: false,
    }
  );
  assert.deepEqual(
    normalizeUiPanels({
      presetExpanded: 'yes',
      gpuExpanded: 1,
    }),
    {
      presetExpanded: false,
      gpuExpanded: false,
    }
  );
});

test('auto priority order follows platform heuristic', () => {
  assert.deepEqual(getAutoVendorPriority('darwin'), ['apple', 'intel', 'amd', 'nvidia', 'cpu']);
  assert.deepEqual(getAutoVendorPriority('win32'), [
    'nvidia',
    'intel',
    'amd',
    'qualcomm',
    'apple',
    'cpu',
  ]);
  assert.deepEqual(getAutoVendorPriority('linux'), [
    'nvidia',
    'intel',
    'amd',
    'qualcomm',
    'apple',
    'cpu',
  ]);
});

test('recommendation selects first available vendor by platform priority', () => {
  const darwinPick = recommendGpuVendorFromAvailability('darwin', 'h265', {
    nvidia: false,
    amd: true,
    intel: true,
    apple: false,
    cpu: true,
  });
  assert.equal(darwinPick.vendor, 'intel');

  const winPick = recommendGpuVendorFromAvailability('win32', 'h264', {
    nvidia: true,
    amd: true,
    intel: true,
    apple: false,
    cpu: true,
  });
  assert.equal(winPick.vendor, 'nvidia');

  const cpuPick = recommendGpuVendorFromAvailability('linux', 'av1', {
    nvidia: false,
    amd: false,
    intel: false,
    apple: false,
    cpu: true,
  });
  assert.equal(cpuPick.vendor, 'cpu');

  const nonVideoPick = recommendGpuVendorFromAvailability('linux', null, {
    nvidia: true,
    amd: true,
    intel: true,
    apple: true,
    cpu: true,
  });
  assert.equal(nonVideoPick.vendor, 'cpu');
});

// --- GPU vendor filtering tests (mirrors renderer getAvailableVendors logic) ---

const GPU_VENDORS = ['nvidia', 'amd', 'intel', 'apple', 'cpu'];
const GPU_CODECS = ['h264', 'h265', 'av1'];

const getAvailableVendors = (payload) => {
  return GPU_VENDORS.filter((vendor) => {
    if (vendor === 'cpu') return true;
    return GPU_CODECS.some((codec) => payload.matrix[codec]?.[vendor]?.available === true);
  });
};

test('getAvailableVendors returns all vendors when all are available', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: true },
        amd: { available: true },
        intel: { available: true },
        apple: { available: true },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['nvidia', 'amd', 'intel', 'apple', 'cpu']);
});

test('getAvailableVendors filters to nvidia + cpu on typical Windows NVIDIA-only system', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
      h265: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
      av1: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['nvidia', 'cpu']);
});

test('getAvailableVendors includes vendor if available for any codec', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: true },
        apple: { available: false },
        cpu: { available: true },
      },
      h265: {
        nvidia: { available: true },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
      av1: {
        nvidia: { available: false },
        amd: { available: true },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['nvidia', 'amd', 'intel', 'cpu']);
});

test('getAvailableVendors returns only cpu when no hardware encoders available', () => {
  const payload = {
    matrix: {
      h264: {
        nvidia: { available: false },
        amd: { available: false },
        intel: { available: false },
        apple: { available: false },
        cpu: { available: true },
      },
    },
  };
  assert.deepEqual(getAvailableVendors(payload), ['cpu']);
});

test('getAvailableVendors handles empty matrix gracefully', () => {
  const payload = { matrix: {} };
  assert.deepEqual(getAvailableVendors(payload), ['cpu']);
});

test('renderer preset projection includes extension and aviTier with stable ids', () => {
  const projected = mapPresetsForRenderer(presets);

  assert.equal(projected.length, presets.length);
  assert.deepEqual(
    projected.map((entry) => entry.id),
    presets.map((entry) => entry.id)
  );
  projected.forEach((entry) => {
    assert.equal(typeof entry.extension, 'string');
    assert.ok(entry.extension.length > 0);
    assert.ok(entry.aviTier === null || typeof entry.aviTier === 'string');
  });

  const aviProjected = projected.find((entry) => entry.id === 'avi-balanced');
  assert.ok(aviProjected);
  assert.equal(aviProjected.aviTier, 'balanced');
});

// Ways the WebP settings UI can fail: tab or panel missing or out of order; loop select
// or tier inputs missing, unlabelled, or with wrong bounds; dither/colour controls leaking
// in; dom.ts refs absent; renderer not loading, saving or resetting webp; webp missing from
// the settings validity check or preset category order; GIF FPS max not 50.
const RENDERER_DIR = path.join(__dirname, '../src/renderer');
const readRendererFile = (name) => fs.readFileSync(path.join(RENDERER_DIR, name), 'utf8');
const WEBP_TIER_KEYS = ['bestQuality', 'quality', 'balanced', 'bestCompression'];
const WEBP_FIELDS = {
  fps: { label: 'FPS', min: 1, max: 60 },
  maxDimension: { label: 'Max Dimension', min: 160, max: 2160 },
  quality: { label: 'Quality', min: 1, max: 100 },
};
const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);
const webpId = (tier, field) => `webp${capitalize(tier)}${capitalize(field)}`;
const tagFor = (html, id) => {
  const match = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `missing element #${id}`);
  return match[0];
};
const optionValues = (html, selectId) => {
  const block = html.match(new RegExp(`<select[^>]*\\bid="${selectId}"[\\s\\S]*?</select>`));
  assert.ok(block, `missing select #${selectId}`);
  return [...block[0].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
};

test('GIF tier FPS inputs cap at 50', () => {
  const html = readRendererFile('index.html');
  for (const tier of WEBP_TIER_KEYS) {
    const id = `gif${capitalize(tier)}Fps`;
    assert.match(tagFor(html, id), /\bmax="50"/, id);
  }
});

test('WebP tab and panel sit directly after the GIF ones', () => {
  const html = readRendererFile('index.html');
  const tabWebp = html.indexOf('id="formatTabWebp"');
  assert.ok(tabWebp > html.indexOf('id="formatTabGif"'));
  assert.ok(tabWebp < html.indexOf('id="formatTabAv1"'));
  assert.match(tagFor(html, 'formatTabWebp'), /data-format-panel="formatPanelWebp"/);
  assert.match(tagFor(html, 'formatTabWebp'), /role="tab"/);
  assert.match(tagFor(html, 'formatTabWebp'), /aria-controls="formatPanelWebp"/);
  const panelWebp = html.indexOf('id="formatPanelWebp"');
  assert.ok(panelWebp > html.indexOf('id="formatPanelGif"'));
  assert.ok(panelWebp < html.indexOf('id="formatPanelAv1"'));
  assert.match(tagFor(html, 'formatPanelWebp'), /aria-labelledby="formatTabWebp"/);
  assert.match(html, /<h3>WebP Preset Tuning<\/h3>/);
  assert.match(tagFor(html, 'resetWebpDefaultsBtn'), /class="btn/);
  assert.match(html, /Reset WebP Defaults/);
});

test('WebP loop select offers the same options as GIF', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<label[^>]*for="webpLoopModeSelect"/);
  assert.deepEqual(optionValues(html, 'webpLoopModeSelect'), ['forever', 'once']);
  assert.deepEqual(
    optionValues(html, 'webpLoopModeSelect'),
    optionValues(html, 'gifLoopModeSelect')
  );
});

test('WebP tier inputs are labelled and bounded like GIF inputs', () => {
  const html = readRendererFile('index.html');
  for (const tier of WEBP_TIER_KEYS) {
    for (const [field, spec] of Object.entries(WEBP_FIELDS)) {
      const id = webpId(tier, field);
      const tag = tagFor(html, id);
      assert.match(tag, new RegExp(`\\bmin="${spec.min}"`), id);
      assert.match(tag, new RegExp(`\\bmax="${spec.max}"`), id);
      assert.match(tag, new RegExp(`data-webp-tier="${tier}"`), id);
      assert.match(tag, new RegExp(`data-webp-field="${field}"`), id);
      assert.match(
        html,
        new RegExp(`<label>\\s*${spec.label}\\s*<input[^>]*\\bid="${id}"`),
        `${id} must sit inside its label`
      );
    }
  }
});

test('WebP panel has no dither or colour controls', () => {
  const html = readRendererFile('index.html');
  const start = html.indexOf('id="formatPanelWebp"');
  assert.ok(start > 0, 'WebP panel must exist');
  const panel = html.slice(start, html.indexOf('id="formatPanelAv1"'));
  assert.doesNotMatch(panel, /dither|maxColors|Dither|Max Colors/i);
});

test('dom.ts exposes element refs for every WebP control', () => {
  const dom = readRendererFile('dom.ts');
  const ids = [
    'formatTabWebp',
    'formatPanelWebp',
    'resetWebpDefaultsBtn',
    'webpLoopModeSelect',
    ...WEBP_TIER_KEYS.flatMap((tier) =>
      Object.keys(WEBP_FIELDS).map((field) => webpId(tier, field))
    ),
  ];
  for (const id of ids) {
    assert.match(dom, new RegExp(`\\b${id}: getRequiredElement<`), id);
  }
});

test('renderer loads, saves and resets WebP settings', () => {
  const source = readRendererFile('renderer.ts');
  assert.match(
    source,
    /type \{[^}]*WebpAdvancedSettings[^}]*\} from '\.\.\/main\/advancedFormats'/
  );
  assert.match(source, /const webpTierInputs\b/);
  assert.match(source, /const setWebpControlValues = /);
  assert.match(source, /const readWebpControls = /);
  assert.match(source, /setWebpControlValues\(advanced\.webp\)/);
  assert.match(source, /webp: readWebpControls\(\)/);
  assert.match(source, /!settings\.advancedFormatSettings\.webp/);
  assert.match(source, /resetWebpDefaultsBtn\.addEventListener/);
  assert.match(source, /resetFormatSettingsToDefaults\('webp', 'WebP'\)/);
  for (const id of [
    'webpLoopModeSelect',
    ...WEBP_TIER_KEYS.flatMap((tier) =>
      Object.keys(WEBP_FIELDS).map((field) => webpId(tier, field))
    ),
  ]) {
    assert.ok(
      source.split(`elements.${id}`).length - 1 >= 2,
      `renderer must read and write #${id}`
    );
  }
});

test('renderer registers the WebP tab and panel with format switching', () => {
  const source = readRendererFile('renderer.ts');
  const tabsBlock = source.match(/const formatTabs = \[([^\]]*)\];/);
  const panelsBlock = source.match(/const formatPanels = \[([^\]]*)\];/);
  assert.ok(tabsBlock && tabsBlock[1].includes('elements.formatTabWebp'));
  assert.ok(panelsBlock && panelsBlock[1].includes('elements.formatPanelWebp'));
  assert.match(source, /type FormatPanelId =[\s\S]*?'formatPanelWebp'[\s\S]*?;/);
  assert.equal((source.match(/panelId === 'formatPanelWebp'/g) || []).length, 2);
});

test('renderer lists the WebP preset category after GIF', () => {
  const source = readRendererFile('renderer.ts');
  assert.match(
    source,
    /const PRESET_CATEGORY_ORDER = \['av1', 'h265', 'h264', 'remux', 'audio', 'avi', 'gif', 'webp'\];/
  );
});

// Failure modes for Qualcomm and the Linux VAAPI labels in the GPU UI. Written before the change.
//  - Qualcomm is offered on x64 or Linux, where its Media Foundation encoders cannot run
//  - a saved Qualcomm choice survives on a device where it is hidden, so the conversion fails
//  - Auto picks Qualcomm over NVIDIA, Intel or AMD on Windows on Arm
//  - the Linux Intel and AMD dropdown still says Quick Sync or AMF instead of VAAPI
//  - the preload does not expose the CPU architecture, so the renderer cannot tell Arm apart
//  - the capability matrix omits the Qualcomm row, so the panel cannot show why it is unavailable

const SRC_DIR = path.join(__dirname, '..', 'src');
const readSource = (...parts) => fs.readFileSync(path.join(SRC_DIR, ...parts), 'utf8');

test('Auto recommendation picks Qualcomm on Windows on Arm when no other GPU encodes', () => {
  const pick = recommendGpuVendorFromAvailability('win32', 'h265', {
    nvidia: false,
    amd: false,
    intel: false,
    qualcomm: true,
    apple: false,
    cpu: true,
  });
  assert.equal(pick.vendor, 'qualcomm');
  const nvidiaFirst = recommendGpuVendorFromAvailability('win32', 'h265', {
    nvidia: true,
    amd: false,
    intel: false,
    qualcomm: true,
    apple: false,
    cpu: true,
  });
  assert.equal(nvidiaFirst.vendor, 'nvidia');
});

test('renderer offers Qualcomm in the vendor list with its own label', () => {
  const source = readRendererFile('renderer.ts');
  assert.match(
    source,
    /const GPU_VENDORS: GPUVendor\[\] = \['nvidia', 'amd', 'intel', 'qualcomm', 'apple', 'cpu'\];/
  );
  assert.match(source, /if \(vendor === 'qualcomm'\) return 'Qualcomm';/);
  assert.match(source, /qualcomm: 'Qualcomm \(Media Foundation\)'/);
});

test('renderer labels Linux Intel and AMD as VAAPI', () => {
  const source = readRendererFile('renderer.ts');
  assert.match(source, /const getVendorDropdownLabel = /);
  assert.match(
    source,
    /currentPlatform === 'linux' && \(vendor === 'intel' \|\| vendor === 'amd'\)/
  );
  assert.match(source, /\(VAAPI\)`/);
});

test('renderer shows and keeps Qualcomm only on Windows on Arm', () => {
  const source = readRendererFile('renderer.ts');
  assert.match(source, /const isQualcommHost = \(\): boolean =>/);
  assert.match(source, /currentPlatform === 'win32' && currentArch === 'arm64'/);
  assert.match(source, /vendor !== 'qualcomm' \|\| isQualcommHost\(\)/);
  assert.match(source, /!isQualcommHost\(\) && settings\.gpuManualVendor === 'qualcomm'/);
  assert.match(source, /option\[value="qualcomm"\]/);
});

test('renderer reads the CPU architecture next to the platform', () => {
  const source = readRendererFile('renderer.ts');
  assert.match(source, /let currentArch = '';/);
  assert.match(source, /currentArch = await window\.electronAPI\.getArch\(\);/);
  const api = readSource('shared', 'electronApi.ts');
  assert.match(api, /getArch: \(\) => Promise<string>;/);
  const preload = readSource('main', 'preload.ts');
  assert.match(preload, /getArch: \(\): Promise<string> => Promise\.resolve\(process\.arch\)/);
});

test('manual vendor dropdown offers Qualcomm in the static markup', () => {
  const html = readRendererFile('index.html');
  assert.ok(optionValues(html, 'gpuManualVendorSelect').includes('qualcomm'));
  assert.match(html, /<option value="qualcomm">Qualcomm \(Media Foundation\)<\/option>/);
});

test('GPU capability matrix includes Qualcomm and gates it to Windows on Arm', () => {
  const source = readSource('main', 'gpuCapabilities.ts');
  assert.match(
    source,
    /const GPU_VENDORS: GPUVendor\[\] = \['nvidia', 'amd', 'intel', 'qualcomm', 'apple', 'cpu'\];/
  );
  assert.match(source, /vendor === 'qualcomm' && !supportsQualcomm\(\)/);
});
