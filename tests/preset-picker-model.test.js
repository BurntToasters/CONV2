const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPresetParentBuckets,
  resolveActiveParentKey,
  pickPresetIdForParent,
  buildPresetPaneState,
} = require('../dist/renderer/presetPickerModel.js');

const samplePresets = [
  {
    id: 'av1-balanced',
    category: 'av1',
    categoryLabel: 'AV1',
    displayName: 'Balanced',
    searchText: 'av1 balanced quality mp4',
  },
  {
    id: 'av1-quality',
    category: 'av1',
    categoryLabel: 'AV1',
    displayName: 'Quality',
    searchText: 'av1 quality mp4',
  },
  {
    id: 'h265-balanced',
    category: 'h265',
    categoryLabel: 'H.265/HEVC',
    displayName: 'Balanced',
    searchText: 'h265 balanced hevc mp4',
  },
  {
    id: 'audio-mp3',
    category: 'audio',
    categoryLabel: 'Audio',
    displayName: 'MP3',
    searchText: 'audio mp3 extract',
  },
];

test('buildPresetParentBuckets keeps recent first and category order after', () => {
  const buckets = buildPresetParentBuckets({
    presets: samplePresets,
    recentPresetIds: ['h265-balanced', 'av1-quality'],
    categoryOrder: ['av1', 'h265', 'audio'],
  });

  assert.equal(buckets[0].key, 'recent');
  assert.deepEqual(
    buckets.map((bucket) => bucket.key),
    ['recent', 'av1', 'h265', 'audio']
  );
  assert.deepEqual(
    buckets[0].presets.map((preset) => preset.id),
    ['h265-balanced', 'av1-quality']
  );
});

test('resolveActiveParentKey falls back to first when current missing', () => {
  const buckets = buildPresetParentBuckets({
    presets: samplePresets,
    recentPresetIds: [],
    categoryOrder: ['av1', 'h265', 'audio'],
  });

  assert.equal(resolveActiveParentKey('h265', buckets), 'h265');
  assert.equal(resolveActiveParentKey('missing', buckets), 'av1');
  assert.equal(resolveActiveParentKey('anything', []), '');
});

test('pickPresetIdForParent prefers balanced when switching parent', () => {
  const av1Parent = samplePresets.filter((preset) => preset.category === 'av1');
  const audioParent = samplePresets.filter((preset) => preset.category === 'audio');

  assert.equal(pickPresetIdForParent('av1-quality', av1Parent), 'av1-quality');
  assert.equal(pickPresetIdForParent('h265-balanced', av1Parent), 'av1-balanced');
  assert.equal(pickPresetIdForParent('missing', audioParent), 'audio-mp3');
  assert.equal(pickPresetIdForParent('missing', []), '');
});

test('buildPresetPaneState supports active-only and global search scope', () => {
  const buckets = buildPresetParentBuckets({
    presets: samplePresets,
    recentPresetIds: [],
    categoryOrder: ['av1', 'h265', 'audio'],
  });

  const activeScope = buildPresetPaneState({
    buckets,
    activeParentKey: 'av1',
    query: 'mp3',
    searchAllFormats: false,
  });
  assert.equal(activeScope.totalVisible, 0);
  assert.equal(activeScope.hasMatchesOutsideActive, true);

  const globalScope = buildPresetPaneState({
    buckets,
    activeParentKey: 'av1',
    query: 'balanced',
    searchAllFormats: true,
  });
  assert.equal(globalScope.totalVisible, 2);
  assert.deepEqual(
    globalScope.groups.map((group) => group.key),
    ['av1', 'h265']
  );
});
