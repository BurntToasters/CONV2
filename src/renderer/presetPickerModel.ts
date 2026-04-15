interface PresetPickerItem {
  id: string;
  category: string;
  categoryLabel: string;
  displayName: string;
  searchText: string;
}

interface PresetParentBucket {
  key: string;
  label: string;
  presets: PresetPickerItem[];
}

interface BuildPresetBucketsArgs {
  presets: PresetPickerItem[];
  recentPresetIds: string[];
  categoryOrder: string[];
}

interface PresetPaneGroup {
  key: string;
  label: string;
  presets: PresetPickerItem[];
}

interface PresetPaneState {
  groups: PresetPaneGroup[];
  totalVisible: number;
  hasMatchesOutsideActive: boolean;
}

interface PresetPickerModelApi {
  buildPresetParentBuckets: (args: BuildPresetBucketsArgs) => PresetParentBucket[];
  resolveActiveParentKey: (requestedKey: string, buckets: PresetParentBucket[]) => string;
  pickPresetIdForParent: (currentSelectedId: string, parentPresets: PresetPickerItem[]) => string;
  buildPresetPaneState: (args: {
    buckets: PresetParentBucket[];
    activeParentKey: string;
    query: string;
    searchAllFormats: boolean;
  }) => PresetPaneState;
  isPresetVisibleInGroups: (presetId: string, groups: PresetPaneGroup[]) => boolean;
}

const normalizeQueryTokens = (query: string): string[] => {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
};

const buildPresetParentBuckets = ({
  presets,
  recentPresetIds,
  categoryOrder,
}: BuildPresetBucketsArgs): PresetParentBucket[] => {
  const grouped = new Map<string, PresetPickerItem[]>();
  presets.forEach((preset) => {
    if (!grouped.has(preset.category)) {
      grouped.set(preset.category, []);
    }
    grouped.get(preset.category)?.push(preset);
  });

  const buckets: PresetParentBucket[] = [];
  const presetById = new Map(presets.map((preset) => [preset.id, preset] as const));
  const recent = recentPresetIds
    .map((id) => presetById.get(id))
    .filter((preset): preset is PresetPickerItem => !!preset);
  if (recent.length > 0) {
    buckets.push({ key: 'recent', label: 'Recent', presets: recent });
  }

  const orderedKeys = Array.from(grouped.keys()).sort((left, right) => {
    const leftIndex = categoryOrder.indexOf(left);
    const rightIndex = categoryOrder.indexOf(right);
    const normalizedLeft = leftIndex >= 0 ? leftIndex : categoryOrder.length + 1;
    const normalizedRight = rightIndex >= 0 ? rightIndex : categoryOrder.length + 1;
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }
    const leftLabel = grouped.get(left)?.[0]?.categoryLabel || left.toUpperCase();
    const rightLabel = grouped.get(right)?.[0]?.categoryLabel || right.toUpperCase();
    return leftLabel.localeCompare(rightLabel);
  });

  orderedKeys.forEach((key) => {
    const categoryPresets = grouped.get(key) || [];
    if (categoryPresets.length === 0) {
      return;
    }
    buckets.push({
      key,
      label: categoryPresets[0].categoryLabel,
      presets: categoryPresets,
    });
  });

  return buckets;
};

const resolveActiveParentKey = (requestedKey: string, buckets: PresetParentBucket[]): string => {
  if (buckets.length === 0) {
    return '';
  }
  if (buckets.some((bucket) => bucket.key === requestedKey)) {
    return requestedKey;
  }
  return buckets[0].key;
};

const pickPresetIdForParent = (
  currentSelectedId: string,
  parentPresets: PresetPickerItem[]
): string => {
  if (parentPresets.length === 0) {
    return '';
  }
  if (parentPresets.some((preset) => preset.id === currentSelectedId)) {
    return currentSelectedId;
  }
  const balanced = parentPresets.find((preset) =>
    preset.displayName.toLowerCase().includes('balanced')
  );
  if (balanced) {
    return balanced.id;
  }
  return parentPresets[0].id;
};

const matchesQuery = (preset: PresetPickerItem, queryTokens: string[]): boolean => {
  if (queryTokens.length === 0) {
    return true;
  }
  const haystack = preset.searchText;
  return queryTokens.every((token) => haystack.includes(token));
};

const buildPresetPaneState = ({
  buckets,
  activeParentKey,
  query,
  searchAllFormats,
}: {
  buckets: PresetParentBucket[];
  activeParentKey: string;
  query: string;
  searchAllFormats: boolean;
}): PresetPaneState => {
  const queryTokens = normalizeQueryTokens(query);

  if (searchAllFormats) {
    const groups = buckets
      .map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        presets: bucket.presets.filter((preset) => matchesQuery(preset, queryTokens)),
      }))
      .filter((group) => group.presets.length > 0);
    return {
      groups,
      totalVisible: groups.reduce((count, group) => count + group.presets.length, 0),
      hasMatchesOutsideActive: false,
    };
  }

  const activeBucket = buckets.find((bucket) => bucket.key === activeParentKey);
  const activeMatches = (activeBucket?.presets || []).filter((preset) =>
    matchesQuery(preset, queryTokens)
  );

  const hasMatchesOutsideActive =
    queryTokens.length > 0 &&
    buckets.some((bucket) => {
      if (bucket.key === activeParentKey) {
        return false;
      }
      return bucket.presets.some((preset) => matchesQuery(preset, queryTokens));
    });

  if (!activeBucket) {
    return {
      groups: [],
      totalVisible: 0,
      hasMatchesOutsideActive,
    };
  }

  return {
    groups: [
      {
        key: activeBucket.key,
        label: activeBucket.label,
        presets: activeMatches,
      },
    ],
    totalVisible: activeMatches.length,
    hasMatchesOutsideActive,
  };
};

const isPresetVisibleInGroups = (presetId: string, groups: PresetPaneGroup[]): boolean => {
  return groups.some((group) => group.presets.some((preset) => preset.id === presetId));
};

const presetPickerModel: PresetPickerModelApi = {
  buildPresetParentBuckets,
  resolveActiveParentKey,
  pickPresetIdForParent,
  buildPresetPaneState,
  isPresetVisibleInGroups,
};

declare const module: { exports?: unknown } | undefined;

if (typeof window !== 'undefined') {
  (window as Window & { presetPickerModel?: PresetPickerModelApi }).presetPickerModel =
    presetPickerModel;
}

if (typeof module !== 'undefined' && module && typeof module.exports !== 'undefined') {
  module.exports = presetPickerModel;
}
