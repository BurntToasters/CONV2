interface Preset {
  id: string;
  name: string;
  description: string;
  category: string;
  categoryLabel: string;
  categoryOrder: number;
  isAdvanced: boolean;
  extension: string;
  aviTier: string | null;
}

type GPUVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
type GPUMode = 'auto' | 'manual';
type GPUCodec = 'h264' | 'h265' | 'av1';

type GifLoopMode = 'forever' | 'once';
type GifDither = 'sierra2_4a' | 'floyd_steinberg' | 'bayer' | 'none';
type GifTierKey = 'bestQuality' | 'quality' | 'balanced' | 'bestCompression';
type VideoPreset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'
  | 'placebo';
type Av1TierKey = 'bestQuality' | 'quality' | 'balanced' | 'bestCompression' | 'compression';
type H264TierKey = 'fast' | 'quality';
type H265TierKey = 'bestQuality' | 'quality' | 'balanced' | 'bestCompression';
type AviTierKey = 'bestQuality' | 'bestCompression' | 'balanced';
type AviCodec = 'h264' | 'h265';

interface GifTierSettings {
  fps: number;
  maxDimension: number;
  maxColors: number;
  dither: GifDither;
}

interface GifTierCollection {
  bestQuality: GifTierSettings;
  quality: GifTierSettings;
  balanced: GifTierSettings;
  bestCompression: GifTierSettings;
}

interface GifAdvancedSettings {
  loopMode: GifLoopMode;
  tiers: GifTierCollection;
}

interface Av1TierSettings {
  quality: number;
  cpuPreset: number;
  audioBitrateKbps: number;
}

interface Av1TierCollection {
  bestQuality: Av1TierSettings;
  quality: Av1TierSettings;
  balanced: Av1TierSettings;
  bestCompression: Av1TierSettings;
  compression: Av1TierSettings;
}

interface Av1AdvancedSettings {
  tiers: Av1TierCollection;
}

interface H264TierSettings {
  quality: number;
  preset: VideoPreset;
  audioBitrateKbps: number;
}

interface H264TierCollection {
  fast: H264TierSettings;
  quality: H264TierSettings;
}

interface H264AdvancedSettings {
  tiers: H264TierCollection;
}

interface H265TierSettings {
  quality: number;
  preset: VideoPreset;
  audioBitrateKbps: number;
  useAdvancedParams: boolean;
}

interface H265TierCollection {
  bestQuality: H265TierSettings;
  quality: H265TierSettings;
  balanced: H265TierSettings;
  bestCompression: H265TierSettings;
}

interface H265AdvancedSettings {
  tiers: H265TierCollection;
}

interface AviTierSettings {
  codec: AviCodec;
  quality: number;
  preset: VideoPreset;
  audioBitrateKbps: number;
  useAdvancedParams: boolean;
}

interface AviTierCollection {
  bestQuality: AviTierSettings;
  bestCompression: AviTierSettings;
  balanced: AviTierSettings;
}

interface AviAdvancedSettings {
  tiers: AviTierCollection;
}

interface AdvancedFormatSettings {
  gif: GifAdvancedSettings;
  av1: Av1AdvancedSettings;
  h264: H264AdvancedSettings;
  h265: H265AdvancedSettings;
  avi: AviAdvancedSettings;
}

interface UIPanelSettings {
  presetExpanded: boolean;
  gpuExpanded: boolean;
}

interface AppSettings {
  settingsSchemaVersion: number;
  outputDirectory: string;
  gpu: GPUVendor;
  gpuMode: GPUMode;
  gpuManualVendor: GPUVendor;
  theme: 'system' | 'dark' | 'light';
  showDebugOutput: boolean;
  autoCheckUpdates: boolean;
  useSystemFFmpeg: boolean;
  useCpuDecodingWhenGpu: boolean;
  moveOriginalToTrashOnSuccess: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  showAdvancedPresets: boolean;
  removeSpacesFromFilenames: boolean;
  showAllGpuVendors: boolean;
  recentPresetIds: string[];
  uiPanels: UIPanelSettings;
  advancedFormatSettings: AdvancedFormatSettings;
}

interface VideoInfo {
  duration: number;
  size: number;
  width: number;
  height: number;
  codec: string;
  format: string;
}

interface ConversionProgressPayload {
  percent: number;
  frame: number;
  fps: number;
  time: string;
  bitrate: string;
  speed: string;
}

interface ConversionResult {
  success: boolean;
  outputPath: string;
  error?: string;
  retryWithCpuSuggested?: boolean;
}

interface BatchConversionOptions {
  gpu: GPUVendor;
  removeSpacesFromFilenames: boolean;
  outputDirectory: string;
  showDebugOutput: boolean;
}

interface ModalOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmClass?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

interface GPUEncoderError {
  type: 'encoder_unavailable' | 'gpu_capability' | 'driver_error' | 'unknown';
  message: string;
  details: string;
  suggestion: string;
  canRetryWithCPU: boolean;
  codec?: string;
  gpu?: GPUVendor;
}

interface GPUCapabilityStatus {
  available: boolean;
  reason: string;
  encoder: string;
}

interface GPUCapabilitiesPayload {
  platform: string;
  requestedCodec: GPUCodec | null;
  checkedCodecs: GPUCodec[];
  matrix: Partial<Record<GPUCodec, Record<GPUVendor, GPUCapabilityStatus>>>;
  recommendedVendor: GPUVendor;
  recommendationReason: string;
}

interface PresetPickerModelPreset {
  id: string;
  category: string;
  categoryLabel: string;
  displayName: string;
  searchText: string;
}

interface PresetParentBucket {
  key: string;
  label: string;
  presets: PresetPickerModelPreset[];
}

interface PresetPaneGroup {
  key: string;
  label: string;
  presets: PresetPickerModelPreset[];
}

interface PresetPaneState {
  groups: PresetPaneGroup[];
  totalVisible: number;
  hasMatchesOutsideActive: boolean;
}

interface PresetPickerModelApi {
  buildPresetParentBuckets: (args: {
    presets: PresetPickerModelPreset[];
    recentPresetIds: string[];
    categoryOrder: string[];
  }) => PresetParentBucket[];
  resolveActiveParentKey: (requestedKey: string, buckets: PresetParentBucket[]) => string;
  pickPresetIdForParent: (
    currentSelectedId: string,
    parentPresets: PresetPickerModelPreset[]
  ) => string;
  buildPresetPaneState: (args: {
    buckets: PresetParentBucket[];
    activeParentKey: string;
    query: string;
    searchAllFormats: boolean;
  }) => PresetPaneState;
  isPresetVisibleInGroups: (presetId: string, groups: PresetPaneGroup[]) => boolean;
}

interface LicenseCrawlerEntry {
  licenses: string | string[];
  repository?: string;
  licenseUrl?: string;
  url?: string;
  license?: string;
}

interface LicenseDisplayEntry {
  name: string;
  license: string;
  link?: string;
  note?: string;
  isSpecial?: boolean;
}

let selectedFiles: string[] = [];
let isConverting = false;
let settings: AppSettings;
let presets: Preset[] = [];
let conversionStartTime = 0;
let lastOutputPath = '';
let themeListenerRegistered = false;
let convertBtnOriginalHTML = '';
let checkUpdateDefaultHTML = '';
let manualUpdateCheckInProgress = false;
let updateDownloadInProgress = false;
let ffmpegInstalled = true;
let cancelRequested = false;
let closeDynamicModal: (() => void) | null = null;
let fileSelectionToken = 0;
let advancedSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let advancedSettingsSaveQueue: Promise<void> = Promise.resolve();
let pendingLogBuffer = '';
let logFlushScheduled = false;
let pendingProgressUpdate: ConversionProgressPayload | null = null;
let progressUpdateScheduled = false;
const MAX_LOG_CHARS = 512 * 1024;
const MAX_RECENT_PRESET_IDS = 8;
const GPU_VENDORS: GPUVendor[] = ['nvidia', 'amd', 'intel', 'apple', 'cpu'];
const GPU_CODECS: GPUCodec[] = ['h264', 'h265', 'av1'];
type UIPanelKey = keyof UIPanelSettings;
const PRESET_CATEGORY_ORDER = ['av1', 'h265', 'h264', 'remux', 'audio', 'avi', 'gif'];
type PresetParentKey = 'recent' | (typeof PRESET_CATEGORY_ORDER)[number];
let selectedPresetId = '';
let activePresetParentKey: PresetParentKey | '' = '';
let presetSearchAllFormats = false;
let currentPlatform = '';
let lastGpuPayload: GPUCapabilitiesPayload | null = null;
const gpuCapabilitiesCache = new Map<string, GPUCapabilitiesPayload>();
let gpuPanelRenderToken = 0;

const getAvailableVendors = (payload: GPUCapabilitiesPayload): GPUVendor[] => {
  return GPU_VENDORS.filter((vendor) => {
    if (vendor === 'cpu') return true;
    return GPU_CODECS.some((codec) => payload.matrix[codec]?.[vendor]?.available === true);
  });
};

const normalizeUiPanels = (value: unknown): UIPanelSettings => {
  const incoming =
    value && typeof value === 'object'
      ? (value as Partial<Record<keyof UIPanelSettings, unknown>>)
      : {};
  return {
    presetExpanded: incoming.presetExpanded === true,
    gpuExpanded: incoming.gpuExpanded === true,
  };
};

const getRequiredElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
};

const elements = {
  dropZone: document.getElementById('dropZone') as HTMLDivElement,
  fileInput: document.getElementById('fileInput') as HTMLInputElement,
  fileInfo: document.getElementById('fileInfo') as HTMLDivElement,
  fileName: document.getElementById('fileName') as HTMLSpanElement,
  fileDetails: document.getElementById('fileDetails') as HTMLSpanElement,
  presetPanelSection: getRequiredElement<HTMLElement>('presetPanelSection'),
  presetPanelToggle: getRequiredElement<HTMLButtonElement>('presetPanelToggle'),
  presetPanelBody: getRequiredElement<HTMLDivElement>('presetPanelBody'),
  presetPanelSummary: getRequiredElement<HTMLSpanElement>('presetPanelSummary'),
  presetSearch: getRequiredElement<HTMLInputElement>('presetSearch'),
  presetSearchAllCheck: getRequiredElement<HTMLInputElement>('presetSearchAllCheck'),
  presetSearchScopeLabel: getRequiredElement<HTMLLabelElement>('presetSearchScopeLabel'),
  presetCountLabel: getRequiredElement<HTMLSpanElement>('presetCountLabel'),
  presetParentList: getRequiredElement<HTMLDivElement>('presetParentList'),
  presetSelectionPreview: getRequiredElement<HTMLDivElement>('presetSelectionPreview'),
  presetCardList: getRequiredElement<HTMLDivElement>('presetCardList'),
  gpuPanelSection: getRequiredElement<HTMLElement>('gpuPanelSection'),
  gpuPanelToggle: getRequiredElement<HTMLButtonElement>('gpuPanelToggle'),
  gpuPanelBody: getRequiredElement<HTMLDivElement>('gpuPanelBody'),
  refreshGpuCapsBtn: getRequiredElement<HTMLButtonElement>('refreshGpuCapsBtn'),
  gpuModeAuto: getRequiredElement<HTMLInputElement>('gpuModeAuto'),
  gpuModeManual: getRequiredElement<HTMLInputElement>('gpuModeManual'),
  gpuManualRow: getRequiredElement<HTMLDivElement>('gpuManualRow'),
  gpuManualVendorSelect: getRequiredElement<HTMLSelectElement>('gpuManualVendorSelect'),
  gpuCapabilityMatrix: getRequiredElement<HTMLDivElement>('gpuCapabilityMatrix'),
  convertBtn: document.getElementById('convertBtn') as HTMLButtonElement,
  cancelBtn: document.getElementById('cancelBtn') as HTMLButtonElement,
  progressContainer: document.getElementById('progressContainer') as HTMLDivElement,
  progressFill: document.getElementById('progressFill') as HTMLDivElement,
  progressPercent: document.getElementById('progressPercent') as HTMLSpanElement,
  progressTime: document.getElementById('progressTime') as HTMLSpanElement,
  progressEta: document.getElementById('progressEta') as HTMLSpanElement,
  progressSpeed: document.getElementById('progressSpeed') as HTMLSpanElement,
  statusMessage: document.getElementById('statusMessage') as HTMLDivElement,
  showInFolderBtn: document.getElementById('showInFolderBtn') as HTMLButtonElement,
  settingsBtn: document.getElementById('settingsBtn') as HTMLButtonElement,
  supportBtn: document.getElementById('supportBtn') as HTMLButtonElement,
  settingsModal: document.getElementById('settingsModal') as HTMLDivElement,
  settingsGeneralTab: getRequiredElement<HTMLButtonElement>('settingsGeneralTab'),
  settingsAdvancedFormatsTab: getRequiredElement<HTMLButtonElement>('settingsAdvancedFormatsTab'),
  settingsDebugTab: getRequiredElement<HTMLButtonElement>('settingsDebugTab'),
  settingsGeneralPanel: getRequiredElement<HTMLDivElement>('settingsGeneralPanel'),
  settingsAdvancedFormatsPanel: getRequiredElement<HTMLDivElement>('settingsAdvancedFormatsPanel'),
  settingsDebugPanel: getRequiredElement<HTMLDivElement>('settingsDebugPanel'),
  showAllGpuVendorsCheck: getRequiredElement<HTMLInputElement>('showAllGpuVendorsCheck'),
  formatTabGif: getRequiredElement<HTMLButtonElement>('formatTabGif'),
  formatTabAv1: getRequiredElement<HTMLButtonElement>('formatTabAv1'),
  formatTabH264: getRequiredElement<HTMLButtonElement>('formatTabH264'),
  formatTabH265: getRequiredElement<HTMLButtonElement>('formatTabH265'),
  formatTabAvi: getRequiredElement<HTMLButtonElement>('formatTabAvi'),
  formatPanelGif: getRequiredElement<HTMLDivElement>('formatPanelGif'),
  formatPanelAv1: getRequiredElement<HTMLDivElement>('formatPanelAv1'),
  formatPanelH264: getRequiredElement<HTMLDivElement>('formatPanelH264'),
  formatPanelH265: getRequiredElement<HTMLDivElement>('formatPanelH265'),
  formatPanelAvi: getRequiredElement<HTMLDivElement>('formatPanelAvi'),
  resetGifDefaultsBtn: getRequiredElement<HTMLButtonElement>('resetGifDefaultsBtn'),
  resetAv1DefaultsBtn: getRequiredElement<HTMLButtonElement>('resetAv1DefaultsBtn'),
  resetH264DefaultsBtn: getRequiredElement<HTMLButtonElement>('resetH264DefaultsBtn'),
  resetH265DefaultsBtn: getRequiredElement<HTMLButtonElement>('resetH265DefaultsBtn'),
  resetAviDefaultsBtn: getRequiredElement<HTMLButtonElement>('resetAviDefaultsBtn'),
  gifLoopModeSelect: getRequiredElement<HTMLSelectElement>('gifLoopModeSelect'),
  gifBestQualityFps: getRequiredElement<HTMLInputElement>('gifBestQualityFps'),
  gifBestQualityMaxDimension: getRequiredElement<HTMLInputElement>('gifBestQualityMaxDimension'),
  gifBestQualityMaxColors: getRequiredElement<HTMLInputElement>('gifBestQualityMaxColors'),
  gifBestQualityDither: getRequiredElement<HTMLSelectElement>('gifBestQualityDither'),
  gifQualityFps: getRequiredElement<HTMLInputElement>('gifQualityFps'),
  gifQualityMaxDimension: getRequiredElement<HTMLInputElement>('gifQualityMaxDimension'),
  gifQualityMaxColors: getRequiredElement<HTMLInputElement>('gifQualityMaxColors'),
  gifQualityDither: getRequiredElement<HTMLSelectElement>('gifQualityDither'),
  gifBalancedFps: getRequiredElement<HTMLInputElement>('gifBalancedFps'),
  gifBalancedMaxDimension: getRequiredElement<HTMLInputElement>('gifBalancedMaxDimension'),
  gifBalancedMaxColors: getRequiredElement<HTMLInputElement>('gifBalancedMaxColors'),
  gifBalancedDither: getRequiredElement<HTMLSelectElement>('gifBalancedDither'),
  gifBestCompressionFps: getRequiredElement<HTMLInputElement>('gifBestCompressionFps'),
  gifBestCompressionMaxDimension: getRequiredElement<HTMLInputElement>(
    'gifBestCompressionMaxDimension'
  ),
  gifBestCompressionMaxColors: getRequiredElement<HTMLInputElement>('gifBestCompressionMaxColors'),
  gifBestCompressionDither: getRequiredElement<HTMLSelectElement>('gifBestCompressionDither'),
  closeSettings: document.getElementById('closeSettings') as HTMLButtonElement,
  outputDirBtn: document.getElementById('outputDirBtn') as HTMLButtonElement,
  outputDirResetBtn: document.getElementById('outputDirResetBtn') as HTMLButtonElement,
  outputPath: document.getElementById('outputPath') as HTMLSpanElement,
  themeSelect: document.getElementById('themeSelect') as HTMLSelectElement,
  themeSwitcher: document.getElementById('themeSwitcher') as HTMLDivElement,
  resetSettingsBtn: document.getElementById('resetSettingsBtn') as HTMLButtonElement,
  checkUpdateBtn: document.getElementById('checkUpdateBtn') as HTMLButtonElement,
  updateBadge: document.getElementById('updateBadge') as HTMLSpanElement,
  autoCheckUpdatesCheck: document.getElementById('autoCheckUpdatesCheck') as HTMLInputElement,
  updateChannelSelect: document.getElementById('updateChannelSelect') as HTMLSelectElement,
  versionInfo: document.getElementById('versionInfo') as HTMLSpanElement,
  versionLink: document.getElementById('versionLink') as HTMLAnchorElement,
  ffmpegWarning: document.getElementById('ffmpegWarning') as HTMLDivElement,
  dynamicModal: document.getElementById('dynamicModal') as HTMLDivElement,
  viewCreditsBtn: document.getElementById('viewCreditsBtn') as HTMLButtonElement,
  creditsModal: document.getElementById('creditsModal') as HTMLDivElement,
  closeCredits: document.getElementById('closeCredits') as HTMLButtonElement,
  licensesList: document.getElementById('licensesList') as HTMLDivElement,
  debugOutputCheck: document.getElementById('debugOutputCheck') as HTMLInputElement,
  advancedPresetsCheck: document.getElementById('advancedPresetsCheck') as HTMLInputElement,
  removeSpacesCheck: document.getElementById('removeSpacesCheck') as HTMLInputElement,
  useSystemFFmpegCheck: document.getElementById('useSystemFFmpegCheck') as HTMLInputElement,
  useCpuDecodingWhenGpuCheck: document.getElementById(
    'useCpuDecodingWhenGpuCheck'
  ) as HTMLInputElement,
  moveOriginalToTrashOnSuccessCheck: document.getElementById(
    'moveOriginalToTrashOnSuccessCheck'
  ) as HTMLInputElement,
  showLogsBtn: document.getElementById('showLogsBtn') as HTMLButtonElement,
  logsModal: document.getElementById('logsModal') as HTMLDivElement,
  closeLogs: document.getElementById('closeLogs') as HTMLButtonElement,
  logsContent: document.getElementById('logsContent') as HTMLPreElement,
  clearLogsBtn: document.getElementById('clearLogsBtn') as HTMLButtonElement,
  copyLogsBtn: document.getElementById('copyLogsBtn') as HTMLButtonElement,
};

const createFallbackPresetPickerModel = (): PresetPickerModelApi => {
  const normalizeQueryTokens = (query: string): string[] => {
    return query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0);
  };

  const matchesQuery = (preset: PresetPickerModelPreset, queryTokens: string[]): boolean => {
    if (queryTokens.length === 0) {
      return true;
    }
    return queryTokens.every((token) => preset.searchText.includes(token));
  };

  return {
    buildPresetParentBuckets: ({ presets, recentPresetIds, categoryOrder }) => {
      const grouped = new Map<string, PresetPickerModelPreset[]>();
      presets.forEach((preset) => {
        if (!grouped.has(preset.category)) {
          grouped.set(preset.category, []);
        }
        grouped.get(preset.category)?.push(preset);
      });

      const buckets: PresetParentBucket[] = [];
      const byId = new Map(presets.map((preset) => [preset.id, preset] as const));
      const recents = recentPresetIds
        .map((id) => byId.get(id))
        .filter((preset): preset is PresetPickerModelPreset => !!preset);
      if (recents.length > 0) {
        buckets.push({ key: 'recent', label: 'Recent', presets: recents });
      }

      Array.from(grouped.keys())
        .sort((left, right) => {
          const leftIndex = categoryOrder.indexOf(left);
          const rightIndex = categoryOrder.indexOf(right);
          const normalizedLeft = leftIndex >= 0 ? leftIndex : categoryOrder.length + 1;
          const normalizedRight = rightIndex >= 0 ? rightIndex : categoryOrder.length + 1;
          return normalizedLeft - normalizedRight;
        })
        .forEach((category) => {
          const categoryPresets = grouped.get(category) || [];
          if (categoryPresets.length > 0) {
            buckets.push({
              key: category,
              label: categoryPresets[0].categoryLabel,
              presets: categoryPresets,
            });
          }
        });
      return buckets;
    },
    resolveActiveParentKey: (requestedKey, buckets) => {
      if (buckets.length === 0) return '';
      return buckets.some((bucket) => bucket.key === requestedKey) ? requestedKey : buckets[0].key;
    },
    pickPresetIdForParent: (currentSelectedId, parentPresets) => {
      if (parentPresets.length === 0) return '';
      if (parentPresets.some((preset) => preset.id === currentSelectedId)) {
        return currentSelectedId;
      }
      const balanced = parentPresets.find((preset) =>
        preset.displayName.toLowerCase().includes('balanced')
      );
      return balanced?.id || parentPresets[0].id;
    },
    buildPresetPaneState: ({ buckets, activeParentKey, query, searchAllFormats }) => {
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
      return {
        groups: activeBucket
          ? [{ key: activeBucket.key, label: activeBucket.label, presets: activeMatches }]
          : [],
        totalVisible: activeMatches.length,
        hasMatchesOutsideActive,
      };
    },
    isPresetVisibleInGroups: (presetId, groups) => {
      return groups.some((group) => group.presets.some((preset) => preset.id === presetId));
    },
  };
};

const pickerModel =
  (window as Window & { presetPickerModel?: PresetPickerModelApi }).presetPickerModel ||
  createFallbackPresetPickerModel();

const normalizeRecentPresetIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  ).slice(0, MAX_RECENT_PRESET_IDS);
};

const getGpuVendorLabel = (vendor: GPUVendor): string => {
  if (vendor === 'nvidia') return 'NVIDIA';
  if (vendor === 'amd') return 'AMD';
  if (vendor === 'intel') return 'Intel';
  if (vendor === 'apple') return 'Apple';
  return 'CPU';
};

const getCodecLabel = (codec: GPUCodec): string => {
  if (codec === 'h264') return 'H.264';
  if (codec === 'h265') return 'H.265/HEVC';
  return 'AV1';
};

const getPresetDisplayName = (preset: Preset): string => {
  if (preset.category === 'remux') {
    return preset.name.replace(/^Remux to\s+/i, '');
  }
  if (preset.category === 'audio') {
    return preset.name.replace(/^Extract Audio\s*\(/i, '').replace(/\)\s*$/i, '');
  }
  const prefix = `${preset.categoryLabel} - `;
  if (preset.name.startsWith(prefix)) {
    return preset.name.slice(prefix.length);
  }
  return preset.name;
};

type PresetIntentKey =
  | 'fast'
  | 'balanced'
  | 'quality'
  | 'best-quality'
  | 'best-compression'
  | 'small-file'
  | 'remux'
  | 'audio'
  | 'other';

const getPresetIntentKey = (preset: Preset): PresetIntentKey => {
  if (preset.category === 'remux') return 'remux';
  if (preset.category === 'audio') return 'audio';
  const text = `${preset.name} ${preset.description}`.toLowerCase();
  if (text.includes('best quality')) return 'best-quality';
  if (text.includes('best compression')) return 'best-compression';
  if (text.includes('small file')) return 'small-file';
  if (text.includes('balanced')) return 'balanced';
  if (text.includes('quality')) return 'quality';
  if (text.includes('fast')) return 'fast';
  return 'other';
};

const getPresetIntentTone = (intent: PresetIntentKey): 'quality' | 'speed' | 'size' | 'default' => {
  if (intent === 'best-quality' || intent === 'quality') return 'quality';
  if (intent === 'fast') return 'speed';
  if (intent === 'best-compression' || intent === 'small-file') return 'size';
  return 'default';
};

const getPresetIntentLabel = (intent: PresetIntentKey): string => {
  if (intent === 'best-quality') return 'Best Quality';
  if (intent === 'best-compression') return 'Best Compression';
  if (intent === 'small-file') return 'Small File';
  if (intent === 'balanced') return 'Balanced';
  if (intent === 'quality') return 'Quality';
  if (intent === 'fast') return 'Fast';
  if (intent === 'remux') return 'Remux';
  if (intent === 'audio') return 'Audio Extract';
  return 'General';
};

const getPresetIntentWeight = (intent: PresetIntentKey): number => {
  if (intent === 'fast') return 0;
  if (intent === 'balanced') return 1;
  if (intent === 'quality') return 2;
  if (intent === 'best-quality') return 3;
  if (intent === 'best-compression') return 4;
  if (intent === 'small-file') return 5;
  if (intent === 'remux') return 6;
  if (intent === 'audio') return 7;
  return 8;
};

const getPresetCodec = (preset: Preset): GPUCodec | null => {
  if (preset.category === 'av1' || preset.category === 'h264' || preset.category === 'h265') {
    return preset.category;
  }
  if (preset.category === 'avi' && preset.aviTier) {
    const tierKey = preset.aviTier as AviTierKey;
    const tier = settings.advancedFormatSettings?.avi?.tiers?.[tierKey];
    if (tier?.codec === 'h264' || tier?.codec === 'h265') {
      return tier.codec;
    }
  }
  return null;
};

const getVisiblePresets = (): Preset[] => {
  return presets.filter((preset) => settings.showAdvancedPresets || !preset.isAdvanced);
};

const sortPresets = (left: Preset, right: Preset): number => {
  const leftIntent = getPresetIntentKey(left);
  const rightIntent = getPresetIntentKey(right);
  const byIntent = getPresetIntentWeight(leftIntent) - getPresetIntentWeight(rightIntent);
  if (byIntent !== 0) {
    return byIntent;
  }
  return getPresetDisplayName(left).localeCompare(getPresetDisplayName(right));
};

const getPresetSearchText = (preset: Preset): string => {
  const codec = getPresetCodec(preset);
  const intent = getPresetIntentLabel(getPresetIntentKey(preset));
  return [
    preset.name,
    getPresetDisplayName(preset),
    preset.description,
    preset.categoryLabel,
    preset.extension,
    codec ? getCodecLabel(codec) : '',
    intent,
  ]
    .join(' ')
    .toLowerCase();
};

const updatePresetPanelSummary = (totalVisible: number): void => {
  if (totalVisible === 0) {
    elements.presetPanelSummary.textContent = 'No matches';
    return;
  }

  const selectedPreset = getSelectedPreset();
  if (!selectedPreset) {
    elements.presetPanelSummary.textContent = `${totalVisible} shown`;
    return;
  }

  elements.presetPanelSummary.textContent = `${getPresetDisplayName(selectedPreset)} · ${totalVisible} shown`;
};

const renderPresetSelectionPreview = (preset: Preset | undefined): void => {
  elements.presetSelectionPreview.innerHTML = '';
  if (!preset) {
    const empty = document.createElement('div');
    empty.className = 'preset-preview-empty';
    empty.textContent = 'Select preset to see details.';
    elements.presetSelectionPreview.appendChild(empty);
    return;
  }

  const codec = getPresetCodec(preset);
  const intent = getPresetIntentLabel(getPresetIntentKey(preset));
  const title = document.createElement('div');
  title.className = 'preset-preview-title';
  title.textContent = getPresetDisplayName(preset);

  const meta = document.createElement('div');
  meta.className = 'preset-preview-meta';
  meta.textContent = `${preset.categoryLabel} · ${codec ? getCodecLabel(codec) : 'No GPU codec'} · ${preset.extension.toUpperCase()} · ${intent}`;

  const description = document.createElement('div');
  description.className = 'preset-preview-description';
  description.textContent = preset.description;

  elements.presetSelectionPreview.append(title, meta, description);
};

const renderPresetParentList = (buckets: PresetParentBucket[]): void => {
  elements.presetParentList.innerHTML = '';
  buckets.forEach((bucket) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `preset-parent-btn${bucket.key === activePresetParentKey ? ' is-active' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', bucket.key === activePresetParentKey ? 'true' : 'false');

    const label = document.createElement('span');
    label.className = 'preset-parent-label';
    label.textContent = bucket.label;

    const count = document.createElement('span');
    count.className = 'preset-parent-count';
    count.textContent = String(bucket.presets.length);

    button.append(label, count);
    button.addEventListener('click', () => {
      activePresetParentKey = bucket.key as PresetParentKey;
      selectedPresetId = pickerModel.pickPresetIdForParent(selectedPresetId, bucket.presets);
      renderPresetPicker();
    });
    elements.presetParentList.appendChild(button);
  });
};

const renderPresetPaneGroups = (
  paneState: PresetPaneState,
  visiblePresetById: Map<string, Preset>
): void => {
  elements.presetCardList.innerHTML = '';
  const totalVisible = paneState.totalVisible;
  elements.presetCountLabel.textContent = `${totalVisible} preset${totalVisible === 1 ? '' : 's'}`;
  updatePresetPanelSummary(totalVisible);

  if (totalVisible === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent =
      presetSearchAllFormats || !elements.presetSearch.value.trim()
        ? 'No presets match your filters.'
        : 'No matches in this format.';
    if (!presetSearchAllFormats && paneState.hasMatchesOutsideActive) {
      const widenBtn = document.createElement('button');
      widenBtn.type = 'button';
      widenBtn.className = 'btn btn-secondary btn-xs preset-empty-action';
      widenBtn.textContent = 'Search all formats';
      widenBtn.addEventListener('click', () => {
        presetSearchAllFormats = true;
        elements.presetSearchAllCheck.checked = true;
        renderPresetPicker();
      });
      empty.appendChild(document.createElement('br'));
      empty.appendChild(widenBtn);
    }
    elements.presetCardList.appendChild(empty);
    return;
  }

  const showGroupHeadings = presetSearchAllFormats && paneState.groups.length > 1;
  paneState.groups.forEach((group) => {
    const block = document.createElement('div');
    block.className = 'preset-result-group';

    if (showGroupHeadings) {
      const heading = document.createElement('h3');
      heading.className = 'preset-result-group-heading';
      heading.textContent = group.label;
      block.appendChild(heading);
    }

    group.presets.forEach((pickerPreset) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `preset-card${pickerPreset.id === selectedPresetId ? ' is-selected' : ''}`;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', pickerPreset.id === selectedPresetId ? 'true' : 'false');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'preset-card-name';
      nameSpan.textContent = pickerPreset.displayName;
      card.appendChild(nameSpan);
      if (group.key === 'recent' && pickerPreset.categoryLabel) {
        const codecSpan = document.createElement('span');
        codecSpan.className = 'preset-card-codec';
        codecSpan.textContent = pickerPreset.categoryLabel;
        card.appendChild(codecSpan);
      }
      const fullPreset = visiblePresetById.get(pickerPreset.id);
      if (fullPreset) {
        card.title = fullPreset.description;
      }
      card.addEventListener('click', () => {
        selectedPresetId = pickerPreset.id;
        if (group.key !== 'recent') {
          activePresetParentKey = group.key as PresetParentKey;
        }
        renderPresetPicker();
      });
      block.appendChild(card);
    });

    elements.presetCardList.appendChild(block);
  });
};

const renderPresetPicker = (): void => {
  try {
    const visibleSorted = [...getVisiblePresets()].sort((left, right) => {
      const leftCategoryWeight = PRESET_CATEGORY_ORDER.indexOf(left.category);
      const rightCategoryWeight = PRESET_CATEGORY_ORDER.indexOf(right.category);
      const normalizedLeft =
        leftCategoryWeight >= 0 ? leftCategoryWeight : PRESET_CATEGORY_ORDER.length + 1;
      const normalizedRight =
        rightCategoryWeight >= 0 ? rightCategoryWeight : PRESET_CATEGORY_ORDER.length + 1;
      if (normalizedLeft !== normalizedRight) {
        return normalizedLeft - normalizedRight;
      }
      return sortPresets(left, right);
    });

    const visiblePickerPresets: PresetPickerModelPreset[] = visibleSorted.map((preset) => ({
      id: preset.id,
      category: preset.category,
      categoryLabel: preset.categoryLabel,
      displayName: getPresetDisplayName(preset),
      searchText: getPresetSearchText(preset),
    }));

    const buckets = pickerModel.buildPresetParentBuckets({
      presets: visiblePickerPresets,
      recentPresetIds: normalizeRecentPresetIds(settings.recentPresetIds),
      categoryOrder: [...PRESET_CATEGORY_ORDER],
    });

    activePresetParentKey = pickerModel.resolveActiveParentKey(activePresetParentKey, buckets) as
      | PresetParentKey
      | '';
    renderPresetParentList(buckets);

    const activeBucket = buckets.find((bucket) => bucket.key === activePresetParentKey);
    selectedPresetId = pickerModel.pickPresetIdForParent(
      selectedPresetId,
      activeBucket?.presets || []
    );

    const paneState = pickerModel.buildPresetPaneState({
      buckets,
      activeParentKey: activePresetParentKey,
      query: elements.presetSearch.value,
      searchAllFormats: presetSearchAllFormats,
    });

    if (!pickerModel.isPresetVisibleInGroups(selectedPresetId, paneState.groups)) {
      selectedPresetId = paneState.groups[0]?.presets[0]?.id || '';
    }

    const visiblePresetById = new Map(visibleSorted.map((preset) => [preset.id, preset] as const));
    renderPresetPaneGroups(paneState, visiblePresetById);
    renderPresetSelectionPreview(visiblePresetById.get(selectedPresetId));

    void refreshGpuPanel(false);
  } catch (err) {
    console.error('Preset picker render failed:', err);
    elements.presetCountLabel.textContent = 'Unavailable';
    elements.presetPanelSummary.textContent = 'Preset UI error';
    elements.presetParentList.innerHTML = '';
    elements.presetSelectionPreview.innerHTML =
      '<div class="preset-preview-empty">Preset UI failed to load.</div>';
    elements.presetCardList.innerHTML =
      '<div class="preset-empty">Reload app or open Settings.</div>';
  }
};

const rememberRecentPreset = async (presetId: string): Promise<void> => {
  const nextRecent = normalizeRecentPresetIds([presetId, ...(settings.recentPresetIds || [])]);
  if (JSON.stringify(nextRecent) === JSON.stringify(settings.recentPresetIds || [])) {
    return;
  }
  settings.recentPresetIds = nextRecent;
  await window.electronAPI.saveSettings({ recentPresetIds: nextRecent });
};

const getSelectedPreset = (): Preset | undefined => {
  return presets.find((preset) => preset.id === selectedPresetId);
};

const getSelectedPresetCodec = (): GPUCodec | null => {
  const selectedPreset = getSelectedPreset();
  if (!selectedPreset) {
    return null;
  }
  return getPresetCodec(selectedPreset);
};

const getGpuCapabilitiesCacheKey = (requestedCodec: GPUCodec | null): string => {
  return requestedCodec ?? 'all';
};

const getGpuCapabilities = async (
  requestedCodec: GPUCodec | null,
  forceRefresh = false
): Promise<GPUCapabilitiesPayload> => {
  const key = getGpuCapabilitiesCacheKey(requestedCodec);
  if (forceRefresh) {
    gpuCapabilitiesCache.delete(key);
  }
  const cached = gpuCapabilitiesCache.get(key);
  if (cached) {
    return cached;
  }
  const payload = await window.electronAPI.getGpuCapabilities(requestedCodec);
  gpuCapabilitiesCache.set(key, payload);
  return payload;
};

const clearGpuCapabilitiesCache = (): void => {
  gpuCapabilitiesCache.clear();
};

const renderGpuCapabilityMatrix = (
  payload: GPUCapabilitiesPayload,
  codecsToRender: GPUCodec[]
): void => {
  elements.gpuCapabilityMatrix.innerHTML = '';

  if (codecsToRender.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent = 'Selected preset does not use video encoding.';
    elements.gpuCapabilityMatrix.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'gpu-capability-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const vendorHeader = document.createElement('th');
  vendorHeader.textContent = 'Vendor';
  headerRow.appendChild(vendorHeader);

  if (codecsToRender.length === 1) {
    const statusHeader = document.createElement('th');
    statusHeader.textContent = `${getCodecLabel(codecsToRender[0])} Status`;
    headerRow.appendChild(statusHeader);
  } else {
    codecsToRender.forEach((codec) => {
      const codecHeader = document.createElement('th');
      codecHeader.textContent = getCodecLabel(codec);
      headerRow.appendChild(codecHeader);
    });
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const vendorSource = lastGpuPayload || payload;
  const vendorsToRender = settings.showAllGpuVendors
    ? GPU_VENDORS
    : getAvailableVendors(vendorSource);
  vendorsToRender.forEach((vendor) => {
    const row = document.createElement('tr');

    if (codecsToRender.length === 1) {
      const entry = payload.matrix[codecsToRender[0]]?.[vendor];
      if (!entry?.available && vendor !== 'cpu') {
        row.classList.add('gpu-vendor-dimmed');
      }
    }

    const vendorCell = document.createElement('td');
    vendorCell.className = 'vendor';
    vendorCell.textContent = getGpuVendorLabel(vendor);
    row.appendChild(vendorCell);

    const appendStatusCell = (codec: GPUCodec) => {
      const cell = document.createElement('td');
      const entry = payload.matrix[codec]?.[vendor];
      const status = document.createElement('span');
      status.className = `gpu-status ${entry?.available ? 'available' : 'unavailable'}`;
      status.textContent = entry?.available ? 'Available' : 'Unavailable';
      cell.appendChild(status);

      const reason = document.createElement('div');
      reason.className = 'gpu-reason';
      const reasonText = entry?.reason || 'Not checked.';
      reason.textContent = reasonText.length > 120 ? `${reasonText.slice(0, 117)}...` : reasonText;
      cell.appendChild(reason);
      row.appendChild(cell);
    };

    if (codecsToRender.length === 1) {
      appendStatusCell(codecsToRender[0]);
    } else {
      codecsToRender.forEach((codec) => appendStatusCell(codec));
    }

    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  elements.gpuCapabilityMatrix.appendChild(table);
};

const GPU_VENDOR_DROPDOWN_LABELS: Record<GPUVendor, string> = {
  cpu: 'CPU (Software)',
  apple: 'Apple (VideoToolbox)',
  nvidia: 'NVIDIA (NVENC)',
  amd: 'AMD (AMF)',
  intel: 'Intel (Quick Sync)',
};

const updateManualVendorDropdown = (
  payload: GPUCapabilitiesPayload,
  currentCodec: GPUCodec | null
): void => {
  const select = elements.gpuManualVendorSelect;
  const previousValue = select.value as GPUVendor;
  select.innerHTML = '';

  const availableVendors = getAvailableVendors(payload);
  const vendorsToShow = settings.showAllGpuVendors ? GPU_VENDORS : availableVendors;

  vendorsToShow.forEach((vendor) => {
    const option = document.createElement('option');
    option.value = vendor;
    const label = GPU_VENDOR_DROPDOWN_LABELS[vendor] || getGpuVendorLabel(vendor);
    const isAvailableOverall = availableVendors.includes(vendor);
    const supportsCurrentCodec =
      vendor === 'cpu' ||
      currentCodec === null ||
      payload.matrix[currentCodec]?.[vendor]?.available === true;

    if (settings.showAllGpuVendors && !isAvailableOverall) {
      option.textContent = `${label} (Unavailable)`;
    } else if (!supportsCurrentCodec) {
      option.textContent = `${label} (Not supported for this format)`;
      option.disabled = true;
    } else {
      option.textContent = label;
    }
    select.appendChild(option);
  });

  if (
    vendorsToShow.includes(previousValue) &&
    !select.querySelector<HTMLOptionElement>(`option[value="${previousValue}"]`)?.disabled
  ) {
    select.value = previousValue;
  } else {
    // Fall back to the first enabled option
    const firstEnabled =
      vendorsToShow.find(
        (v) => !select.querySelector<HTMLOptionElement>(`option[value="${v}"]`)?.disabled
      ) ?? 'cpu';
    select.value = firstEnabled;
    if (firstEnabled !== settings.gpuManualVendor) {
      settings.gpuManualVendor = firstEnabled;
      settings.gpu = firstEnabled;
      void window.electronAPI.saveSettings({ gpuManualVendor: firstEnabled });
    }
  }
};

const applyPanelCollapseUi = (): void => {
  const presetExpanded = settings.uiPanels.presetExpanded;
  const gpuExpanded = settings.uiPanels.gpuExpanded;

  elements.presetPanelBody.hidden = !presetExpanded;
  elements.presetPanelToggle.setAttribute('aria-expanded', presetExpanded ? 'true' : 'false');
  elements.presetPanelSection.classList.toggle('is-expanded', presetExpanded);

  elements.gpuPanelBody.hidden = !gpuExpanded;
  elements.gpuPanelToggle.setAttribute('aria-expanded', gpuExpanded ? 'true' : 'false');
  elements.gpuPanelSection.classList.toggle('is-expanded', gpuExpanded);
};

const persistUiPanelState = async (panel: UIPanelKey, expanded: boolean): Promise<void> => {
  if (settings.uiPanels[panel] === expanded) {
    return;
  }

  const previousPanels = settings.uiPanels;
  settings.uiPanels = { ...settings.uiPanels, [panel]: expanded };
  applyPanelCollapseUi();

  try {
    const panelUpdate: Partial<UIPanelSettings> =
      panel === 'presetExpanded' ? { presetExpanded: expanded } : { gpuExpanded: expanded };
    await window.electronAPI.saveSettings({ uiPanels: panelUpdate });
  } catch (err) {
    settings.uiPanels = previousPanels;
    applyPanelCollapseUi();
    showStatus(
      'error',
      `Failed to save panel layout: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

const applyGpuModeUi = (): void => {
  elements.gpuManualRow.hidden = settings.gpuMode !== 'manual';
  elements.gpuModeAuto.checked = settings.gpuMode !== 'manual';
  elements.gpuModeManual.checked = settings.gpuMode === 'manual';
};

const refreshGpuPanel = async (forceRefresh: boolean): Promise<void> => {
  const token = ++gpuPanelRenderToken;
  const selectedPreset = getSelectedPreset();
  const selectedCodec = getSelectedPresetCodec();

  try {
    const summaryPayload = await getGpuCapabilities(selectedCodec, forceRefresh);
    if (token !== gpuPanelRenderToken) {
      return;
    }

    const allCodecsPayload = await getGpuCapabilities(null, forceRefresh);
    if (token !== gpuPanelRenderToken) {
      return;
    }

    lastGpuPayload = allCodecsPayload;
    updateManualVendorDropdown(allCodecsPayload, selectedCodec);

    if (token !== gpuPanelRenderToken) {
      return;
    }

    if (!selectedPreset || !selectedCodec) {
      renderGpuCapabilityMatrix(summaryPayload, []);
      return;
    }

    renderGpuCapabilityMatrix(summaryPayload, [selectedCodec]);
  } catch (err) {
    if (token !== gpuPanelRenderToken) {
      return;
    }
    elements.gpuCapabilityMatrix.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent = err instanceof Error ? err.message : String(err);
    elements.gpuCapabilityMatrix.appendChild(empty);
  }
};

const gifTierInputs: Record<
  GifTierKey,
  {
    fps: HTMLInputElement;
    maxDimension: HTMLInputElement;
    maxColors: HTMLInputElement;
    dither: HTMLSelectElement;
  }
> = {
  bestQuality: {
    fps: elements.gifBestQualityFps,
    maxDimension: elements.gifBestQualityMaxDimension,
    maxColors: elements.gifBestQualityMaxColors,
    dither: elements.gifBestQualityDither,
  },
  quality: {
    fps: elements.gifQualityFps,
    maxDimension: elements.gifQualityMaxDimension,
    maxColors: elements.gifQualityMaxColors,
    dither: elements.gifQualityDither,
  },
  balanced: {
    fps: elements.gifBalancedFps,
    maxDimension: elements.gifBalancedMaxDimension,
    maxColors: elements.gifBalancedMaxColors,
    dither: elements.gifBalancedDither,
  },
  bestCompression: {
    fps: elements.gifBestCompressionFps,
    maxDimension: elements.gifBestCompressionMaxDimension,
    maxColors: elements.gifBestCompressionMaxColors,
    dither: elements.gifBestCompressionDither,
  },
};

const av1TierInputs: Record<
  Av1TierKey,
  {
    quality: HTMLInputElement;
    cpuPreset: HTMLInputElement;
    audioBitrateKbps: HTMLInputElement;
  }
> = {
  bestQuality: {
    quality: getRequiredElement<HTMLInputElement>('av1BestQualityQuality'),
    cpuPreset: getRequiredElement<HTMLInputElement>('av1BestQualityCpuPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('av1BestQualityAudioBitrateKbps'),
  },
  quality: {
    quality: getRequiredElement<HTMLInputElement>('av1QualityQuality'),
    cpuPreset: getRequiredElement<HTMLInputElement>('av1QualityCpuPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('av1QualityAudioBitrateKbps'),
  },
  balanced: {
    quality: getRequiredElement<HTMLInputElement>('av1BalancedQuality'),
    cpuPreset: getRequiredElement<HTMLInputElement>('av1BalancedCpuPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('av1BalancedAudioBitrateKbps'),
  },
  bestCompression: {
    quality: getRequiredElement<HTMLInputElement>('av1BestCompressionQuality'),
    cpuPreset: getRequiredElement<HTMLInputElement>('av1BestCompressionCpuPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('av1BestCompressionAudioBitrateKbps'),
  },
  compression: {
    quality: getRequiredElement<HTMLInputElement>('av1CompressionQuality'),
    cpuPreset: getRequiredElement<HTMLInputElement>('av1CompressionCpuPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('av1CompressionAudioBitrateKbps'),
  },
};

const h264TierInputs: Record<
  H264TierKey,
  {
    quality: HTMLInputElement;
    preset: HTMLSelectElement;
    audioBitrateKbps: HTMLInputElement;
  }
> = {
  fast: {
    quality: getRequiredElement<HTMLInputElement>('h264FastQuality'),
    preset: getRequiredElement<HTMLSelectElement>('h264FastPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('h264FastAudioBitrateKbps'),
  },
  quality: {
    quality: getRequiredElement<HTMLInputElement>('h264QualityQuality'),
    preset: getRequiredElement<HTMLSelectElement>('h264QualityPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('h264QualityAudioBitrateKbps'),
  },
};

const h265TierInputs: Record<
  H265TierKey,
  {
    quality: HTMLInputElement;
    preset: HTMLSelectElement;
    audioBitrateKbps: HTMLInputElement;
    useAdvancedParams: HTMLInputElement;
  }
> = {
  bestQuality: {
    quality: getRequiredElement<HTMLInputElement>('h265BestQualityQuality'),
    preset: getRequiredElement<HTMLSelectElement>('h265BestQualityPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('h265BestQualityAudioBitrateKbps'),
    useAdvancedParams: getRequiredElement<HTMLInputElement>('h265BestQualityUseAdvancedParams'),
  },
  quality: {
    quality: getRequiredElement<HTMLInputElement>('h265QualityQuality'),
    preset: getRequiredElement<HTMLSelectElement>('h265QualityPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('h265QualityAudioBitrateKbps'),
    useAdvancedParams: getRequiredElement<HTMLInputElement>('h265QualityUseAdvancedParams'),
  },
  balanced: {
    quality: getRequiredElement<HTMLInputElement>('h265BalancedQuality'),
    preset: getRequiredElement<HTMLSelectElement>('h265BalancedPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('h265BalancedAudioBitrateKbps'),
    useAdvancedParams: getRequiredElement<HTMLInputElement>('h265BalancedUseAdvancedParams'),
  },
  bestCompression: {
    quality: getRequiredElement<HTMLInputElement>('h265BestCompressionQuality'),
    preset: getRequiredElement<HTMLSelectElement>('h265BestCompressionPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('h265BestCompressionAudioBitrateKbps'),
    useAdvancedParams: getRequiredElement<HTMLInputElement>('h265BestCompressionUseAdvancedParams'),
  },
};

const aviTierInputs: Record<
  AviTierKey,
  {
    codec: HTMLSelectElement;
    quality: HTMLInputElement;
    preset: HTMLSelectElement;
    audioBitrateKbps: HTMLInputElement;
    useAdvancedParams: HTMLInputElement;
  }
> = {
  bestQuality: {
    codec: getRequiredElement<HTMLSelectElement>('aviBestQualityCodec'),
    quality: getRequiredElement<HTMLInputElement>('aviBestQualityQuality'),
    preset: getRequiredElement<HTMLSelectElement>('aviBestQualityPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('aviBestQualityAudioBitrateKbps'),
    useAdvancedParams: getRequiredElement<HTMLInputElement>('aviBestQualityUseAdvancedParams'),
  },
  bestCompression: {
    codec: getRequiredElement<HTMLSelectElement>('aviBestCompressionCodec'),
    quality: getRequiredElement<HTMLInputElement>('aviBestCompressionQuality'),
    preset: getRequiredElement<HTMLSelectElement>('aviBestCompressionPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('aviBestCompressionAudioBitrateKbps'),
    useAdvancedParams: getRequiredElement<HTMLInputElement>('aviBestCompressionUseAdvancedParams'),
  },
  balanced: {
    codec: getRequiredElement<HTMLSelectElement>('aviBalancedCodec'),
    quality: getRequiredElement<HTMLInputElement>('aviBalancedQuality'),
    preset: getRequiredElement<HTMLSelectElement>('aviBalancedPreset'),
    audioBitrateKbps: getRequiredElement<HTMLInputElement>('aviBalancedAudioBitrateKbps'),
    useAdvancedParams: getRequiredElement<HTMLInputElement>('aviBalancedUseAdvancedParams'),
  },
};

const settingsTabButtons = [
  elements.settingsGeneralTab,
  elements.settingsAdvancedFormatsTab,
  elements.settingsDebugTab,
];
const settingsPanels = [
  elements.settingsGeneralPanel,
  elements.settingsAdvancedFormatsPanel,
  elements.settingsDebugPanel,
];

const formatTabs = [
  elements.formatTabGif,
  elements.formatTabAv1,
  elements.formatTabH264,
  elements.formatTabH265,
  elements.formatTabAvi,
];
const formatPanels = [
  elements.formatPanelGif,
  elements.formatPanelAv1,
  elements.formatPanelH264,
  elements.formatPanelH265,
  elements.formatPanelAvi,
];

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const setSettingsPanel = (
  panelId: 'settingsGeneralPanel' | 'settingsAdvancedFormatsPanel' | 'settingsDebugPanel'
): void => {
  settingsPanels.forEach((panel) => {
    const isActive = panel.id === panelId;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  });

  settingsTabButtons.forEach((tab) => {
    const isActive = tab.dataset.settingsPanel === panelId;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.setAttribute('tabindex', isActive ? '0' : '-1');
  });
};

type FormatPanelId =
  | 'formatPanelGif'
  | 'formatPanelAv1'
  | 'formatPanelH264'
  | 'formatPanelH265'
  | 'formatPanelAvi';

const setFormatPanel = (panelId: FormatPanelId): void => {
  formatPanels.forEach((panel) => {
    const isActive = panel.id === panelId;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  });

  formatTabs.forEach((tab) => {
    const isActive = tab.dataset.formatPanel === panelId;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.setAttribute('tabindex', isActive ? '0' : '-1');
  });
};

const getFocusableElements = (container: HTMLElement): HTMLElement[] => {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.offsetParent !== null);
};

const focusFirstInteractiveElement = (container: HTMLElement): void => {
  const focusables = getFocusableElements(container);
  if (focusables.length > 0) {
    focusables[0].focus();
  }
};

const getTopVisibleModal = (): HTMLDivElement | null => {
  if (elements.dynamicModal.classList.contains('visible')) {
    return elements.dynamicModal;
  }
  if (elements.settingsModal.classList.contains('visible')) {
    return elements.settingsModal;
  }
  if (elements.logsModal.classList.contains('visible')) {
    return elements.logsModal;
  }
  if (elements.creditsModal.classList.contains('visible')) {
    return elements.creditsModal;
  }
  return null;
};

const trapFocusInModal = (event: KeyboardEvent, modalOverlay: HTMLDivElement): void => {
  const modal = modalOverlay.querySelector<HTMLElement>('.modal');
  if (!modal) {
    return;
  }
  const focusables = getFocusableElements(modal);
  if (focusables.length === 0) {
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (active === first || !active || !modal.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last || !active || !modal.contains(active)) {
    event.preventDefault();
    first.focus();
  }
};

const handleTabKeyboardNavigation = (
  event: KeyboardEvent,
  tabs: HTMLButtonElement[],
  onSelect: (tab: HTMLButtonElement) => void
): void => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return;
  }

  event.preventDefault();

  const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
  if (currentIndex < 0) {
    return;
  }

  let nextIndex = currentIndex;
  if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1;
  } else if (event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  }

  const nextTab = tabs[nextIndex];
  nextTab.focus();
  onSelect(nextTab);
};

const setGifControlValues = (gif: GifAdvancedSettings): void => {
  elements.gifLoopModeSelect.value = gif.loopMode;
  (Object.keys(gifTierInputs) as GifTierKey[]).forEach((tier) => {
    const tierInputs = gifTierInputs[tier];
    const tierSettings = gif.tiers[tier];
    tierInputs.fps.value = String(tierSettings.fps);
    tierInputs.maxDimension.value = String(tierSettings.maxDimension);
    tierInputs.maxColors.value = String(tierSettings.maxColors);
    tierInputs.dither.value = tierSettings.dither;
  });
};

const setAv1ControlValues = (av1: Av1AdvancedSettings): void => {
  (Object.keys(av1TierInputs) as Av1TierKey[]).forEach((tier) => {
    const tierInputs = av1TierInputs[tier];
    const tierSettings = av1.tiers[tier];
    tierInputs.quality.value = String(tierSettings.quality);
    tierInputs.cpuPreset.value = String(tierSettings.cpuPreset);
    tierInputs.audioBitrateKbps.value = String(tierSettings.audioBitrateKbps);
  });
};

const setH264ControlValues = (h264: H264AdvancedSettings): void => {
  (Object.keys(h264TierInputs) as H264TierKey[]).forEach((tier) => {
    const tierInputs = h264TierInputs[tier];
    const tierSettings = h264.tiers[tier];
    tierInputs.quality.value = String(tierSettings.quality);
    tierInputs.preset.value = tierSettings.preset;
    tierInputs.audioBitrateKbps.value = String(tierSettings.audioBitrateKbps);
  });
};

const setH265ControlValues = (h265: H265AdvancedSettings): void => {
  (Object.keys(h265TierInputs) as H265TierKey[]).forEach((tier) => {
    const tierInputs = h265TierInputs[tier];
    const tierSettings = h265.tiers[tier];
    tierInputs.quality.value = String(tierSettings.quality);
    tierInputs.preset.value = tierSettings.preset;
    tierInputs.audioBitrateKbps.value = String(tierSettings.audioBitrateKbps);
    tierInputs.useAdvancedParams.checked = tierSettings.useAdvancedParams;
  });
};

const setAviControlValues = (avi: AviAdvancedSettings): void => {
  (Object.keys(aviTierInputs) as AviTierKey[]).forEach((tier) => {
    const tierInputs = aviTierInputs[tier];
    const tierSettings = avi.tiers[tier];
    tierInputs.codec.value = tierSettings.codec;
    tierInputs.quality.value = String(tierSettings.quality);
    tierInputs.preset.value = tierSettings.preset;
    tierInputs.audioBitrateKbps.value = String(tierSettings.audioBitrateKbps);
    tierInputs.useAdvancedParams.checked = tierSettings.useAdvancedParams;
  });
};

const setAdvancedFormatControlValues = (advanced: AdvancedFormatSettings): void => {
  setGifControlValues(advanced.gif);
  setAv1ControlValues(advanced.av1);
  setH264ControlValues(advanced.h264);
  setH265ControlValues(advanced.h265);
  setAviControlValues(advanced.avi);
};

const parseNumericInput = (value: string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readGifControls = (): GifAdvancedSettings => {
  return {
    loopMode: elements.gifLoopModeSelect.value as GifLoopMode,
    tiers: {
      bestQuality: {
        fps: parseNumericInput(elements.gifBestQualityFps.value),
        maxDimension: parseNumericInput(elements.gifBestQualityMaxDimension.value),
        maxColors: parseNumericInput(elements.gifBestQualityMaxColors.value),
        dither: elements.gifBestQualityDither.value as GifDither,
      },
      quality: {
        fps: parseNumericInput(elements.gifQualityFps.value),
        maxDimension: parseNumericInput(elements.gifQualityMaxDimension.value),
        maxColors: parseNumericInput(elements.gifQualityMaxColors.value),
        dither: elements.gifQualityDither.value as GifDither,
      },
      balanced: {
        fps: parseNumericInput(elements.gifBalancedFps.value),
        maxDimension: parseNumericInput(elements.gifBalancedMaxDimension.value),
        maxColors: parseNumericInput(elements.gifBalancedMaxColors.value),
        dither: elements.gifBalancedDither.value as GifDither,
      },
      bestCompression: {
        fps: parseNumericInput(elements.gifBestCompressionFps.value),
        maxDimension: parseNumericInput(elements.gifBestCompressionMaxDimension.value),
        maxColors: parseNumericInput(elements.gifBestCompressionMaxColors.value),
        dither: elements.gifBestCompressionDither.value as GifDither,
      },
    },
  };
};

const readAv1Controls = (): Av1AdvancedSettings => {
  return {
    tiers: {
      bestQuality: {
        quality: parseNumericInput(av1TierInputs.bestQuality.quality.value),
        cpuPreset: parseNumericInput(av1TierInputs.bestQuality.cpuPreset.value),
        audioBitrateKbps: parseNumericInput(av1TierInputs.bestQuality.audioBitrateKbps.value),
      },
      quality: {
        quality: parseNumericInput(av1TierInputs.quality.quality.value),
        cpuPreset: parseNumericInput(av1TierInputs.quality.cpuPreset.value),
        audioBitrateKbps: parseNumericInput(av1TierInputs.quality.audioBitrateKbps.value),
      },
      balanced: {
        quality: parseNumericInput(av1TierInputs.balanced.quality.value),
        cpuPreset: parseNumericInput(av1TierInputs.balanced.cpuPreset.value),
        audioBitrateKbps: parseNumericInput(av1TierInputs.balanced.audioBitrateKbps.value),
      },
      bestCompression: {
        quality: parseNumericInput(av1TierInputs.bestCompression.quality.value),
        cpuPreset: parseNumericInput(av1TierInputs.bestCompression.cpuPreset.value),
        audioBitrateKbps: parseNumericInput(av1TierInputs.bestCompression.audioBitrateKbps.value),
      },
      compression: {
        quality: parseNumericInput(av1TierInputs.compression.quality.value),
        cpuPreset: parseNumericInput(av1TierInputs.compression.cpuPreset.value),
        audioBitrateKbps: parseNumericInput(av1TierInputs.compression.audioBitrateKbps.value),
      },
    },
  };
};

const readH264Controls = (): H264AdvancedSettings => {
  return {
    tiers: {
      fast: {
        quality: parseNumericInput(h264TierInputs.fast.quality.value),
        preset: h264TierInputs.fast.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(h264TierInputs.fast.audioBitrateKbps.value),
      },
      quality: {
        quality: parseNumericInput(h264TierInputs.quality.quality.value),
        preset: h264TierInputs.quality.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(h264TierInputs.quality.audioBitrateKbps.value),
      },
    },
  };
};

const readH265Controls = (): H265AdvancedSettings => {
  return {
    tiers: {
      bestQuality: {
        quality: parseNumericInput(h265TierInputs.bestQuality.quality.value),
        preset: h265TierInputs.bestQuality.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(h265TierInputs.bestQuality.audioBitrateKbps.value),
        useAdvancedParams: h265TierInputs.bestQuality.useAdvancedParams.checked,
      },
      quality: {
        quality: parseNumericInput(h265TierInputs.quality.quality.value),
        preset: h265TierInputs.quality.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(h265TierInputs.quality.audioBitrateKbps.value),
        useAdvancedParams: h265TierInputs.quality.useAdvancedParams.checked,
      },
      balanced: {
        quality: parseNumericInput(h265TierInputs.balanced.quality.value),
        preset: h265TierInputs.balanced.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(h265TierInputs.balanced.audioBitrateKbps.value),
        useAdvancedParams: h265TierInputs.balanced.useAdvancedParams.checked,
      },
      bestCompression: {
        quality: parseNumericInput(h265TierInputs.bestCompression.quality.value),
        preset: h265TierInputs.bestCompression.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(h265TierInputs.bestCompression.audioBitrateKbps.value),
        useAdvancedParams: h265TierInputs.bestCompression.useAdvancedParams.checked,
      },
    },
  };
};

const readAviControls = (): AviAdvancedSettings => {
  return {
    tiers: {
      bestQuality: {
        codec: aviTierInputs.bestQuality.codec.value as AviCodec,
        quality: parseNumericInput(aviTierInputs.bestQuality.quality.value),
        preset: aviTierInputs.bestQuality.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(aviTierInputs.bestQuality.audioBitrateKbps.value),
        useAdvancedParams: aviTierInputs.bestQuality.useAdvancedParams.checked,
      },
      bestCompression: {
        codec: aviTierInputs.bestCompression.codec.value as AviCodec,
        quality: parseNumericInput(aviTierInputs.bestCompression.quality.value),
        preset: aviTierInputs.bestCompression.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(aviTierInputs.bestCompression.audioBitrateKbps.value),
        useAdvancedParams: aviTierInputs.bestCompression.useAdvancedParams.checked,
      },
      balanced: {
        codec: aviTierInputs.balanced.codec.value as AviCodec,
        quality: parseNumericInput(aviTierInputs.balanced.quality.value),
        preset: aviTierInputs.balanced.preset.value as VideoPreset,
        audioBitrateKbps: parseNumericInput(aviTierInputs.balanced.audioBitrateKbps.value),
        useAdvancedParams: aviTierInputs.balanced.useAdvancedParams.checked,
      },
    },
  };
};

const readAdvancedFormatControls = (): AdvancedFormatSettings => {
  return {
    gif: readGifControls(),
    av1: readAv1Controls(),
    h264: readH264Controls(),
    h265: readH265Controls(),
    avi: readAviControls(),
  };
};

const areAdvancedSettingsEqual = (
  left: AdvancedFormatSettings,
  right: AdvancedFormatSettings
): boolean => {
  return JSON.stringify(left) === JSON.stringify(right);
};

const enqueueAdvancedSettingsTask = (task: () => Promise<void>): Promise<void> => {
  const nextTask = advancedSettingsSaveQueue.then(task);
  advancedSettingsSaveQueue = nextTask.catch(() => undefined);
  return nextTask;
};

const persistAdvancedFormatSettings = async (
  nextAdvancedSettings: AdvancedFormatSettings
): Promise<void> => {
  const previousSettings = settings.advancedFormatSettings;

  try {
    await window.electronAPI.saveSettings({
      advancedFormatSettings: nextAdvancedSettings,
    });
    const refreshed = await window.electronAPI.getSettings();
    settings = refreshed;
    if (!areAdvancedSettingsEqual(refreshed.advancedFormatSettings, nextAdvancedSettings)) {
      setAdvancedFormatControlValues(refreshed.advancedFormatSettings);
    }
  } catch (err) {
    settings.advancedFormatSettings = previousSettings;
    setAdvancedFormatControlValues(previousSettings);
    showStatus(
      'error',
      `Failed to save advanced format settings: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

const queueAdvancedSettingsSaveFromControls = (): void => {
  const nextAdvancedSettings = readAdvancedFormatControls();
  void enqueueAdvancedSettingsTask(() => persistAdvancedFormatSettings(nextAdvancedSettings));
};

type AdvancedFormatKey = keyof AdvancedFormatSettings;

const resetFormatSettingsToDefaults = async (
  format: AdvancedFormatKey,
  label: string
): Promise<void> => {
  if (advancedSaveDebounceTimer) {
    clearTimeout(advancedSaveDebounceTimer);
    advancedSaveDebounceTimer = null;
  }

  await enqueueAdvancedSettingsTask(async () => {
    const previousSettings = settings.advancedFormatSettings;

    try {
      const defaults = await window.electronAPI.getDefaultAdvancedFormatSettings();
      await window.electronAPI.saveSettings({
        advancedFormatSettings: {
          [format]: defaults[format],
        } as unknown as AdvancedFormatSettings,
      });
      settings = await window.electronAPI.getSettings();
      setAdvancedFormatControlValues(settings.advancedFormatSettings);
    } catch (err) {
      settings.advancedFormatSettings = previousSettings;
      setAdvancedFormatControlValues(previousSettings);
      showStatus(
        'error',
        `Failed to reset ${label} settings: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
};

const scheduleAdvancedSettingsSave = (): void => {
  if (advancedSaveDebounceTimer) {
    clearTimeout(advancedSaveDebounceTimer);
  }
  advancedSaveDebounceTimer = setTimeout(() => {
    advancedSaveDebounceTimer = null;
    queueAdvancedSettingsSaveFromControls();
  }, 220);
};

const flushPendingAdvancedSettingsSave = (): void => {
  if (!advancedSaveDebounceTimer) {
    return;
  }
  clearTimeout(advancedSaveDebounceTimer);
  advancedSaveDebounceTimer = null;
  queueAdvancedSettingsSaveFromControls();
};

const waitForAdvancedSettingsIdle = async (): Promise<void> => {
  flushPendingAdvancedSettingsSave();
  await advancedSettingsSaveQueue.catch(() => undefined);
};

const openSettingsModal = (): void => {
  if (elements.settingsModal.classList.contains('visible')) {
    return;
  }
  setSettingsPanel('settingsGeneralPanel');
  setAdvancedFormatControlValues(settings.advancedFormatSettings);
  elements.settingsModal.classList.add('visible');
  focusFirstInteractiveElement(elements.settingsModal);
};

const closeSettingsModal = async (): Promise<void> => {
  await waitForAdvancedSettingsIdle();
  elements.settingsModal.classList.remove('visible');
};

const flushLogBuffer = (): void => {
  if (pendingLogBuffer.length === 0) {
    return;
  }
  const existingLogText = elements.logsContent.textContent || '';
  const combined = existingLogText + pendingLogBuffer;
  elements.logsContent.textContent =
    combined.length <= MAX_LOG_CHARS ? combined : combined.slice(combined.length - MAX_LOG_CHARS);
  pendingLogBuffer = '';
  elements.logsContent.scrollTop = elements.logsContent.scrollHeight;
};

const appendLogMessage = (message: string): void => {
  if (!message) {
    return;
  }
  const nextPending = pendingLogBuffer + message;
  pendingLogBuffer =
    nextPending.length <= MAX_LOG_CHARS
      ? nextPending
      : nextPending.slice(nextPending.length - MAX_LOG_CHARS);
  if (logFlushScheduled) {
    return;
  }
  logFlushScheduled = true;
  requestAnimationFrame(() => {
    logFlushScheduled = false;
    flushLogBuffer();
  });
};

const getCheckingUpdateButtonHTML = (): string =>
  '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Checking...';

const getDownloadingUpdateButtonHTML = (percent?: number): string => {
  const suffix = typeof percent === 'number' ? ` ${Math.round(percent)}%` : '';
  return `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="12 5 12 19"/><polyline points="19 12 12 19 5 12"/></svg>Downloading...${suffix}`;
};

const getUpdateAvailableButtonHTML = (): string =>
  '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Update Available!';

const setCheckUpdateButtonState = (
  html: string,
  disabled: boolean,
  highlightAvailable = false
): void => {
  elements.checkUpdateBtn.innerHTML = html;
  elements.checkUpdateBtn.disabled = disabled;
  elements.checkUpdateBtn.classList.toggle('btn-update-available', highlightAvailable);
};

const showModal = (options: ModalOptions): void => {
  const modal = elements.dynamicModal;
  const titleEl = modal.querySelector('.modal-header h2') as HTMLElement;
  const bodyEl = modal.querySelector('.modal-body p') as HTMLElement;
  const confirmBtn = modal.querySelector('#modalConfirm') as HTMLButtonElement;
  const cancelBtn = modal.querySelector('#modalCancel') as HTMLButtonElement;

  titleEl.textContent = options.title;
  bodyEl.textContent = options.message;
  confirmBtn.textContent = options.confirmText || 'Confirm';
  cancelBtn.textContent = options.cancelText || 'Cancel';
  confirmBtn.className = `btn btn-sm ${options.confirmClass || 'btn-primary'}`;

  const overlayListener = (e: Event) => {
    if (e.target === modal) {
      cleanup();
      options.onCancel?.();
    }
  };

  const cleanup = () => {
    modal.classList.remove('visible');
    modal.removeEventListener('click', overlayListener);
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    if (closeDynamicModal === closeByEscape) {
      closeDynamicModal = null;
    }
  };

  const closeByEscape = () => {
    cleanup();
    options.onCancel?.();
  };

  const newConfirmBtn = modal.querySelector('#modalConfirm') as HTMLButtonElement;
  const newCancelBtn = modal.querySelector('#modalCancel') as HTMLButtonElement;

  newConfirmBtn.addEventListener('click', () => {
    cleanup();
    options.onConfirm?.();
  });

  newCancelBtn.addEventListener('click', () => {
    cleanup();
    options.onCancel?.();
  });

  modal.addEventListener('click', overlayListener);
  modal.classList.add('visible');
  focusFirstInteractiveElement(modal);
  closeDynamicModal = closeByEscape;
};

const buildLicenseEntries = (
  data: Record<string, LicenseCrawlerEntry> | null
): LicenseDisplayEntry[] => {
  const entries: LicenseDisplayEntry[] = [
    {
      name: 'FFmpeg',
      license: 'GPL-2.0-or-later',
      link: 'https://ffmpeg.org/',
      note: 'Bundled GPL static builds include x264, x265, lame, libass, fribidi, freetype, fontconfig, libiconv, enca, and expat. License text: ffmpeg/LICENSE.txt. Source offer: ffmpeg/SOURCE_OFFER.txt.',
      isSpecial: true,
    },
    {
      name: 'FFmpeg license text',
      license: 'GPL-2.0-or-later',
      note: 'Included with this app at ffmpeg/LICENSE.txt.',
      isSpecial: true,
    },
    {
      name: 'FFmpeg source offer',
      license: 'GPLv2 Section 3(b)',
      note: 'Written offer included with this app at ffmpeg/SOURCE_OFFER.txt.',
      isSpecial: true,
    },
    {
      name: 'FFmpeg binaries',
      license: 'GPL-2.0-or-later',
      link: 'https://github.com/BurntToasters/ffmpeg-static-builds',
      note: 'Pre-built FFmpeg 8.0 static binaries for all platforms. Source code available at the linked repository.',
      isSpecial: true,
    },
    {
      name: 'Twemoji assets',
      license: 'CC-BY 4.0',
      link: 'https://github.com/jdecked/twemoji',
      note: 'Emoji artwork by Twitter and other contributors (used under CC-BY 4.0).',
      isSpecial: true,
    },
  ];

  if (!data || typeof data !== 'object') {
    return entries;
  }

  const packageEntries = Object.entries(data)
    .filter(([pkg]) => typeof pkg === 'string')
    .map(([pkg, info]) => {
      const entryInfo =
        typeof info === 'object' && info !== null
          ? (info as LicenseCrawlerEntry)
          : { licenses: String(info) as string };

      const licenses = Array.isArray(entryInfo.licenses)
        ? entryInfo.licenses.join(', ')
        : entryInfo.licenses || entryInfo.license || 'Unknown';

      const link = entryInfo.repository || entryInfo.licenseUrl || entryInfo.url;

      return {
        name: pkg,
        license: licenses,
        link,
      } as LicenseDisplayEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...entries, ...packageEntries];
};

const renderLicenses = (entries: LicenseDisplayEntry[]): void => {
  if (!elements.licensesList) return;

  elements.licensesList.innerHTML = '';

  entries.forEach((entry) => {
    const item = document.createElement('div');
    item.className = `license-item${entry.isSpecial ? ' license-highlight' : ''}`;

    const header = document.createElement('div');
    header.className = 'license-header';

    const nameEl = document.createElement('div');
    nameEl.className = 'license-name';
    nameEl.textContent = entry.name;

    const badge = document.createElement('span');
    badge.className = 'license-badge';
    badge.textContent = entry.license;

    header.appendChild(nameEl);
    header.appendChild(badge);
    item.appendChild(header);

    if (entry.note || entry.link) {
      const meta = document.createElement('div');
      meta.className = 'license-meta';

      if (entry.link && /^https?:\/\//i.test(entry.link)) {
        const linkBtn = document.createElement('button');
        linkBtn.className = 'btn btn-xs license-link';
        linkBtn.textContent = 'View source';
        linkBtn.addEventListener('click', () => window.electronAPI.openExternal(entry.link!));
        meta.appendChild(linkBtn);
      }

      if (entry.note) {
        const note = document.createElement('span');
        note.className = 'license-note';
        note.textContent = entry.note;
        meta.prepend(note);
      }

      item.appendChild(meta);
    }

    elements.licensesList.appendChild(item);
  });
};

const openCreditsModal = async (): Promise<void> => {
  if (elements.settingsModal.classList.contains('visible')) {
    await closeSettingsModal();
  }
  elements.creditsModal.classList.add('visible');
  focusFirstInteractiveElement(elements.creditsModal);
  elements.licensesList.innerHTML = '<div class="license-item">Loading credits...</div>';

  try {
    const data = await window.electronAPI.getLicenses();
    const hasLicenses =
      !!data && typeof data === 'object' && Object.keys(data as Record<string, unknown>).length > 0;
    const entries = buildLicenseEntries(data as Record<string, LicenseCrawlerEntry> | null);
    renderLicenses(entries);

    if (!hasLicenses) {
      const warning = document.createElement('div');
      warning.className = 'license-item license-error';
      warning.textContent =
        'licenses.json is missing or empty. Run "npm run licenses" before packaging to include dependency credits.';
      elements.licensesList.appendChild(warning);
    }
  } catch {
    elements.licensesList.innerHTML =
      '<div class="license-item license-error">Unable to load licenses.json. Run "npm run licenses" to generate it.</div>';
  }
};

const closeCreditsModal = (): void => {
  elements.creditsModal.classList.remove('visible');
};

const TIER_LABEL_TO_KEY: Record<string, string> = {
  'best quality': 'bestQuality',
  quality: 'quality',
  balanced: 'balanced',
  'best compression': 'bestCompression',
  'small file': 'smallFile',
  compression: 'compression',
  fast: 'fast',
};

const tagAdvancedTierCards = (): void => {
  const cards = document.querySelectorAll<HTMLElement>('.advanced-tier-card, .gif-tier-card');
  cards.forEach((card) => {
    if (card.dataset.tier) return;
    const heading = card.querySelector('h4');
    const label = heading?.textContent?.trim().toLowerCase() ?? '';
    const key = TIER_LABEL_TO_KEY[label];
    if (key) card.dataset.tier = key;
  });
};

const init = async () => {
  convertBtnOriginalHTML = elements.convertBtn.innerHTML;
  checkUpdateDefaultHTML = elements.checkUpdateBtn.innerHTML;
  tagAdvancedTierCards();
  await checkFFmpeg();
  await checkPlatform();
  await loadSettings();
  setupEventListeners();
  setupKeyboardShortcuts();
  await loadPresets();
  await loadVersion();
  await applyTheme();
  await applyUpdateVisibility();
};

const checkPlatform = async () => {
  currentPlatform = await window.electronAPI.getPlatform();
  const appleOption =
    elements.gpuManualVendorSelect.querySelector<HTMLOptionElement>('option[value="apple"]');
  if (appleOption) {
    const allowApple = currentPlatform === 'darwin';
    appleOption.hidden = !allowApple;
    appleOption.disabled = !allowApple;
  }
};

const checkFFmpeg = async () => {
  const installed = await window.electronAPI.checkFFmpeg();
  ffmpegInstalled = installed;
  if (!installed) {
    elements.ffmpegWarning.style.display = 'block';
    if (!isConverting) {
      elements.convertBtn.disabled = true;
    }
    return;
  }

  elements.ffmpegWarning.style.display = 'none';
  if (!isConverting && selectedFiles.length > 0) {
    elements.convertBtn.disabled = false;
  }
};

const loadSettings = async () => {
  settings = await window.electronAPI.getSettings();
  settings.recentPresetIds = normalizeRecentPresetIds(settings.recentPresetIds);
  if (
    !settings.advancedFormatSettings ||
    !settings.advancedFormatSettings.gif ||
    !settings.advancedFormatSettings.av1 ||
    !settings.advancedFormatSettings.h264 ||
    !settings.advancedFormatSettings.h265 ||
    !settings.advancedFormatSettings.avi
  ) {
    settings.advancedFormatSettings = await window.electronAPI.getDefaultAdvancedFormatSettings();
  }
  settings.gpuMode = settings.gpuMode === 'manual' ? 'manual' : 'auto';
  if (!GPU_VENDORS.includes(settings.gpuManualVendor)) {
    settings.gpuManualVendor = 'cpu';
  }
  if (currentPlatform !== 'darwin' && settings.gpuManualVendor === 'apple') {
    settings.gpuManualVendor = 'cpu';
  }
  settings.uiPanels = normalizeUiPanels(settings.uiPanels);
  settings.gpu = settings.gpuManualVendor;
  applyGpuModeUi();
  applyPanelCollapseUi();
  elements.gpuManualVendorSelect.value = settings.gpuManualVendor;
  elements.presetPanelSummary.textContent = 'No preset selected';
  presetSearchAllFormats = false;
  elements.presetSearchAllCheck.checked = false;
  elements.themeSelect.value = settings.theme;
  elements.debugOutputCheck.checked = settings.showDebugOutput;
  elements.advancedPresetsCheck.checked = settings.showAdvancedPresets;
  elements.removeSpacesCheck.checked = settings.removeSpacesFromFilenames;
  elements.autoCheckUpdatesCheck.checked = settings.autoCheckUpdates;
  elements.useSystemFFmpegCheck.checked = settings.useSystemFFmpeg;
  elements.useCpuDecodingWhenGpuCheck.checked = settings.useCpuDecodingWhenGpu;
  elements.moveOriginalToTrashOnSuccessCheck.checked = settings.moveOriginalToTrashOnSuccess;
  elements.showAllGpuVendorsCheck.checked = settings.showAllGpuVendors;
  elements.updateChannelSelect.value = settings.updateChannel;
  setSettingsPanel('settingsGeneralPanel');
  setFormatPanel('formatPanelGif');
  setAdvancedFormatControlValues(settings.advancedFormatSettings);

  if (settings.showDebugOutput) {
    elements.showLogsBtn.style.display = 'inline-block';
  } else {
    elements.showLogsBtn.style.display = 'none';
  }

  if (settings.outputDirectory) {
    elements.outputPath.textContent = settings.outputDirectory;
    elements.outputDirResetBtn.hidden = false;
  } else {
    elements.outputPath.textContent = 'Same as input file';
    elements.outputDirResetBtn.hidden = true;
  }
};

const loadPresets = async () => {
  try {
    presets = await window.electronAPI.getPresets();
    const visiblePresetIds = new Set(getVisiblePresets().map((preset) => preset.id));
    if (!selectedPresetId || !visiblePresetIds.has(selectedPresetId)) {
      const firstRecent = normalizeRecentPresetIds(settings.recentPresetIds).find((id) =>
        visiblePresetIds.has(id)
      );
      selectedPresetId = firstRecent || getVisiblePresets()[0]?.id || '';
    }
    renderPresetPicker();
  } catch (err) {
    showStatus(
      'error',
      `Failed to load presets: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

const loadVersion = async () => {
  const version = await window.electronAPI.getVersion();
  const tagUrl = `https://github.com/BurntToasters/CONV2/releases/tag/v${version}`;
  elements.versionInfo.textContent = `CONV2 v${version}`;
  elements.versionLink.href = tagUrl;
  elements.versionLink.title = `View release v${version}`;
};

const applyUpdateVisibility = async () => {
  const updatesDisabled = await window.electronAPI.isUpdatesDisabled();
  const updateChannelSetting = document.getElementById('updateChannelSetting');
  if (updatesDisabled) {
    elements.checkUpdateBtn.style.display = 'none';
    elements.updateBadge.style.display = 'none';
    elements.autoCheckUpdatesCheck.disabled = true;
    if (updateChannelSetting) {
      updateChannelSetting.style.display = 'none';
    }
  }
};

const updateThemeSwitcher = () => {
  const switcher = document.getElementById('themeSwitcher');
  if (!switcher) return;

  switcher.querySelectorAll('.theme-option').forEach((btn) => {
    const btnTheme = (btn as HTMLElement).dataset.theme;
    btn.classList.toggle('active', btnTheme === settings.theme);
  });
};

const applyTheme = async () => {
  if (settings.theme === 'system') {
    const systemTheme = await window.electronAPI.getSystemTheme();
    document.documentElement.setAttribute('data-theme', systemTheme);
  } else {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }

  updateThemeSwitcher();

  if (!themeListenerRegistered) {
    window.electronAPI.onThemeChange((theme) => {
      if (settings.theme === 'system') {
        document.documentElement.setAttribute('data-theme', theme);
      }
    });
    themeListenerRegistered = true;
  }
};

const setupKeyboardShortcuts = () => {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const topModal = getTopVisibleModal();
      if (topModal) {
        trapFocusInModal(e, topModal);
      }
    }

    if (e.key === 'Escape') {
      const topModal = getTopVisibleModal();
      if (!topModal) {
        return;
      }
      e.preventDefault();
      if (topModal === elements.dynamicModal) {
        if (closeDynamicModal) {
          closeDynamicModal();
        } else {
          elements.dynamicModal.classList.remove('visible');
        }
        return;
      }
      if (topModal === elements.settingsModal) {
        void closeSettingsModal();
        return;
      }
      if (topModal === elements.logsModal) {
        elements.logsModal.classList.remove('visible');
        return;
      }
      if (topModal === elements.creditsModal) {
        closeCreditsModal();
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      if (getTopVisibleModal()) {
        return;
      }
      elements.fileInput.click();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === ',' || e.code === 'Comma')) {
      e.preventDefault();
      const hasBlockingModal =
        elements.settingsModal.classList.contains('visible') ||
        elements.dynamicModal.classList.contains('visible') ||
        elements.logsModal.classList.contains('visible') ||
        elements.creditsModal.classList.contains('visible');
      if (!hasBlockingModal) {
        openSettingsModal();
      }
      return;
    }

    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.closest('button, input, select, textarea, a, [role="button"]') ||
          target.isContentEditable)
      ) {
        return;
      }
      const isModalOpen =
        elements.settingsModal.classList.contains('visible') ||
        elements.dynamicModal.classList.contains('visible') ||
        elements.logsModal.classList.contains('visible') ||
        elements.creditsModal.classList.contains('visible');
      if (
        !isModalOpen &&
        selectedFiles.length > 0 &&
        !isConverting &&
        !elements.convertBtn.disabled
      ) {
        e.preventDefault();
        startConversion();
      }
    }
  });
};

const setupEventListeners = () => {
  settingsTabButtons.forEach((tab) => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.settingsPanel;
      if (
        panelId === 'settingsGeneralPanel' ||
        panelId === 'settingsAdvancedFormatsPanel' ||
        panelId === 'settingsDebugPanel'
      ) {
        setSettingsPanel(panelId);
      }
    });
    tab.addEventListener('keydown', (event) => {
      handleTabKeyboardNavigation(event, settingsTabButtons, (nextTab) => {
        const panelId = nextTab.dataset.settingsPanel;
        if (
          panelId === 'settingsGeneralPanel' ||
          panelId === 'settingsAdvancedFormatsPanel' ||
          panelId === 'settingsDebugPanel'
        ) {
          setSettingsPanel(panelId);
        }
      });
    });
  });

  formatTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.formatPanel;
      if (
        panelId === 'formatPanelGif' ||
        panelId === 'formatPanelAv1' ||
        panelId === 'formatPanelH264' ||
        panelId === 'formatPanelH265' ||
        panelId === 'formatPanelAvi'
      ) {
        setFormatPanel(panelId);
      }
    });
    tab.addEventListener('keydown', (event) => {
      handleTabKeyboardNavigation(event, formatTabs, (nextTab) => {
        const panelId = nextTab.dataset.formatPanel;
        if (
          panelId === 'formatPanelGif' ||
          panelId === 'formatPanelAv1' ||
          panelId === 'formatPanelH264' ||
          panelId === 'formatPanelH265' ||
          panelId === 'formatPanelAvi'
        ) {
          setFormatPanel(panelId);
        }
      });
    });
  });

  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>('.advanced-control')
    .forEach((control) => {
      if (control instanceof HTMLInputElement && control.type === 'number') {
        control.addEventListener('input', () => {
          scheduleAdvancedSettingsSave();
        });
      }

      control.addEventListener('change', () => {
        if (control instanceof HTMLInputElement && control.type === 'number') {
          flushPendingAdvancedSettingsSave();
          return;
        }
        queueAdvancedSettingsSaveFromControls();
      });
    });

  elements.resetGifDefaultsBtn.addEventListener('click', async () => {
    await resetFormatSettingsToDefaults('gif', 'GIF');
  });

  elements.resetAv1DefaultsBtn.addEventListener('click', async () => {
    await resetFormatSettingsToDefaults('av1', 'AV1');
  });

  elements.resetH264DefaultsBtn.addEventListener('click', async () => {
    await resetFormatSettingsToDefaults('h264', 'H.264');
  });

  elements.resetH265DefaultsBtn.addEventListener('click', async () => {
    await resetFormatSettingsToDefaults('h265', 'H.265');
  });

  elements.resetAviDefaultsBtn.addEventListener('click', async () => {
    await resetFormatSettingsToDefaults('avi', 'AVI');
  });

  document.getElementById('support-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://rosie.run/support');
  });

  elements.supportBtn.addEventListener('click', () => {
    window.electronAPI.openExternal('https://rosie.run/support');
  });

  elements.versionLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (elements.versionLink.href) {
      window.electronAPI.openExternal(elements.versionLink.href);
    }
  });

  document.getElementById('help-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://help.rosie.run/conv2/en-us/faq');
  });

  document.getElementById('about-privacy')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://help.rosie.run/conv2/en-us/privacy-policy');
  });

  document.getElementById('rosie-run')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://rosie.run');
  });

  elements.dropZone.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('button')) {
      elements.fileInput.click();
    }
  });

  elements.dropZone.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      elements.fileInput.click();
    }
  });

  const browseBtn = elements.dropZone.querySelector('button');
  browseBtn?.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    elements.fileInput.click();
  });

  elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
  });

  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('dragover');
  });

  elements.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const filePaths = Array.from(files)
        .map((file) => window.electronAPI.getPathForFile(file))
        .filter((filePath) => filePath && filePath.length > 0);
      handleFileSelect(filePaths);
    }
  });

  elements.fileInput.addEventListener('change', () => {
    const files = elements.fileInput.files;
    if (files && files.length > 0) {
      const filePaths = Array.from(files)
        .map((file) => window.electronAPI.getPathForFile(file))
        .filter((filePath) => filePath && filePath.length > 0);
      handleFileSelect(filePaths);
    }
    elements.fileInput.value = '';
  });

  elements.presetPanelToggle.addEventListener('click', () => {
    void persistUiPanelState('presetExpanded', !settings.uiPanels.presetExpanded);
  });

  elements.gpuPanelToggle.addEventListener('click', () => {
    void persistUiPanelState('gpuExpanded', !settings.uiPanels.gpuExpanded);
  });

  elements.presetSearch.addEventListener('input', () => {
    renderPresetPicker();
  });

  elements.presetSearchAllCheck.addEventListener('change', () => {
    presetSearchAllFormats = elements.presetSearchAllCheck.checked;
    renderPresetPicker();
  });

  elements.refreshGpuCapsBtn.addEventListener('click', () => {
    clearGpuCapabilitiesCache();
    void refreshGpuPanel(true);
  });

  const persistGpuMode = async (nextMode: GPUMode): Promise<void> => {
    try {
      settings.gpuMode = nextMode;
      settings.gpu = settings.gpuManualVendor;
      applyGpuModeUi();
      await window.electronAPI.saveSettings({
        gpuMode: settings.gpuMode,
        gpuManualVendor: settings.gpuManualVendor,
        gpu: settings.gpuManualVendor,
      });
      void refreshGpuPanel(false);
    } catch (err) {
      showStatus(
        'error',
        `Failed to save GPU mode: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  elements.gpuModeAuto.addEventListener('change', () => {
    if (elements.gpuModeAuto.checked) {
      void persistGpuMode('auto');
    }
  });

  elements.gpuModeManual.addEventListener('change', () => {
    if (elements.gpuModeManual.checked) {
      void persistGpuMode('manual');
    }
  });

  elements.gpuManualVendorSelect.addEventListener('change', async () => {
    try {
      settings.gpuManualVendor = elements.gpuManualVendorSelect.value as GPUVendor;
      settings.gpu = settings.gpuManualVendor;
      await window.electronAPI.saveSettings({
        gpuManualVendor: settings.gpuManualVendor,
        gpu: settings.gpuManualVendor,
      });
      void refreshGpuPanel(false);
    } catch (err) {
      showStatus(
        'error',
        `Failed to save GPU vendor: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  elements.themeSelect.addEventListener('change', async () => {
    settings.theme = elements.themeSelect.value as AppSettings['theme'];
    await window.electronAPI.saveSettings({ theme: settings.theme });
    await applyTheme();
    updateThemeSwitcher();
  });

  elements.themeSwitcher?.querySelectorAll('.theme-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const theme = (btn as HTMLElement).dataset.theme as AppSettings['theme'];
      if (theme) {
        settings.theme = theme;
        elements.themeSelect.value = theme;
        await window.electronAPI.saveSettings({ theme });
        await applyTheme();
        updateThemeSwitcher();
      }
    });
  });

  elements.debugOutputCheck.addEventListener('change', async () => {
    settings.showDebugOutput = elements.debugOutputCheck.checked;
    await window.electronAPI.saveSettings({ showDebugOutput: settings.showDebugOutput });
    elements.showLogsBtn.style.display = settings.showDebugOutput ? 'inline-block' : 'none';
  });

  elements.advancedPresetsCheck.addEventListener('change', async () => {
    settings.showAdvancedPresets = elements.advancedPresetsCheck.checked;
    await window.electronAPI.saveSettings({ showAdvancedPresets: settings.showAdvancedPresets });
    await loadPresets();
  });

  elements.removeSpacesCheck.addEventListener('change', async () => {
    settings.removeSpacesFromFilenames = elements.removeSpacesCheck.checked;
    await window.electronAPI.saveSettings({
      removeSpacesFromFilenames: settings.removeSpacesFromFilenames,
    });
  });

  elements.autoCheckUpdatesCheck.addEventListener('change', async () => {
    settings.autoCheckUpdates = elements.autoCheckUpdatesCheck.checked;
    await window.electronAPI.saveSettings({ autoCheckUpdates: settings.autoCheckUpdates });
  });

  elements.updateChannelSelect.addEventListener('change', async () => {
    settings.updateChannel = elements.updateChannelSelect.value as AppSettings['updateChannel'];
    await window.electronAPI.saveSettings({ updateChannel: settings.updateChannel });
  });

  elements.useSystemFFmpegCheck.addEventListener('change', async () => {
    settings.useSystemFFmpeg = elements.useSystemFFmpegCheck.checked;
    await window.electronAPI.saveSettings({ useSystemFFmpeg: settings.useSystemFFmpeg });
    clearGpuCapabilitiesCache();
    await checkFFmpeg();
    void refreshGpuPanel(true);
  });

  elements.useCpuDecodingWhenGpuCheck.addEventListener('change', async () => {
    settings.useCpuDecodingWhenGpu = elements.useCpuDecodingWhenGpuCheck.checked;
    await window.electronAPI.saveSettings({
      useCpuDecodingWhenGpu: settings.useCpuDecodingWhenGpu,
    });
  });

  elements.moveOriginalToTrashOnSuccessCheck.addEventListener('change', async () => {
    settings.moveOriginalToTrashOnSuccess = elements.moveOriginalToTrashOnSuccessCheck.checked;
    await window.electronAPI.saveSettings({
      moveOriginalToTrashOnSuccess: settings.moveOriginalToTrashOnSuccess,
    });
  });

  elements.showAllGpuVendorsCheck.addEventListener('change', async () => {
    settings.showAllGpuVendors = elements.showAllGpuVendorsCheck.checked;
    await window.electronAPI.saveSettings({ showAllGpuVendors: settings.showAllGpuVendors });
    void refreshGpuPanel(false);
  });

  elements.convertBtn.addEventListener('click', () => {
    if (isConverting) {
      showModal({
        title: 'Cancel Conversion',
        message:
          'Are you sure you want to cancel the conversion? The partial file will be deleted.',
        confirmText: 'Yes, Cancel',
        cancelText: 'No, Continue',
        confirmClass: 'btn-danger',
        onConfirm: cancelConversion,
      });
    } else {
      startConversion();
    }
  });

  elements.cancelBtn.addEventListener('click', () => {
    if (isConverting) {
      cancelConversion();
    }
  });

  elements.showInFolderBtn?.addEventListener('click', () => {
    if (lastOutputPath) {
      window.electronAPI.openPath(lastOutputPath);
    }
  });

  elements.settingsBtn.addEventListener('click', () => {
    openSettingsModal();
  });

  elements.closeSettings.addEventListener('click', () => {
    void closeSettingsModal();
  });

  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) {
      void closeSettingsModal();
    }
  });

  elements.showLogsBtn.addEventListener('click', () => {
    flushLogBuffer();
    elements.logsModal.classList.add('visible');
    focusFirstInteractiveElement(elements.logsModal);
  });

  elements.closeLogs.addEventListener('click', () => {
    elements.logsModal.classList.remove('visible');
  });

  elements.logsModal.addEventListener('click', (e) => {
    if (e.target === elements.logsModal) {
      elements.logsModal.classList.remove('visible');
    }
  });

  elements.clearLogsBtn.addEventListener('click', () => {
    pendingLogBuffer = '';
    elements.logsContent.textContent = '';
  });

  elements.copyLogsBtn.addEventListener('click', () => {
    flushLogBuffer();
    navigator.clipboard.writeText(elements.logsContent.textContent || '');
    const originalHTML = elements.copyLogsBtn.innerHTML;
    elements.copyLogsBtn.innerHTML =
      '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Copied!';
    setTimeout(() => {
      elements.copyLogsBtn.innerHTML = originalHTML;
    }, 2000);
  });

  elements.viewCreditsBtn.addEventListener('click', () => {
    openCreditsModal();
  });

  elements.closeCredits.addEventListener('click', () => {
    closeCreditsModal();
  });

  elements.creditsModal.addEventListener('click', (e) => {
    if (e.target === elements.creditsModal) {
      closeCreditsModal();
    }
  });

  elements.outputDirBtn.addEventListener('click', async () => {
    const dir = await window.electronAPI.selectOutputDirectory();
    if (dir) {
      settings.outputDirectory = dir;
      elements.outputPath.textContent = dir;
      elements.outputDirResetBtn.hidden = false;
      await window.electronAPI.saveSettings({ outputDirectory: dir });
    }
  });

  elements.outputDirResetBtn.addEventListener('click', async () => {
    settings.outputDirectory = '';
    elements.outputPath.textContent = 'Same as input file';
    elements.outputDirResetBtn.hidden = true;
    await window.electronAPI.saveSettings({ outputDirectory: '' });
  });

  elements.resetSettingsBtn.addEventListener('click', () => {
    showModal({
      title: 'Reset Settings',
      message: 'Are you sure you want to reset all settings to defaults? The app will restart.',
      confirmText: 'Reset & Restart',
      cancelText: 'Cancel',
      confirmClass: 'btn-danger',
      onConfirm: async () => {
        await window.electronAPI.resetSettings();
        await window.electronAPI.restartApp();
      },
    });
  });

  elements.checkUpdateBtn.addEventListener('click', () => {
    manualUpdateCheckInProgress = true;
    updateDownloadInProgress = false;
    setCheckUpdateButtonState(getCheckingUpdateButtonHTML(), true);
    window.electronAPI.checkForUpdates();
  });

  window.electronAPI.onUpdateStatus((message) => {
    const isDownloadStartMessage = message === 'Downloading update...';
    if (!manualUpdateCheckInProgress && !updateDownloadInProgress && !isDownloadStartMessage) {
      return;
    }

    if (message === 'Checking for updates...') {
      setCheckUpdateButtonState(getCheckingUpdateButtonHTML(), true);
      return;
    }

    if (message === 'Downloading update...') {
      updateDownloadInProgress = true;
      setCheckUpdateButtonState(getDownloadingUpdateButtonHTML(), true);
      return;
    }

    if (message.startsWith('Update error:')) {
      manualUpdateCheckInProgress = false;
      updateDownloadInProgress = false;
      setCheckUpdateButtonState(checkUpdateDefaultHTML, false);
      return;
    }

    if (message === 'You have the latest version.') {
      manualUpdateCheckInProgress = false;
      updateDownloadInProgress = false;
      setCheckUpdateButtonState(checkUpdateDefaultHTML, false);
    }
  });

  window.electronAPI.onUpdateProgress((percent) => {
    if (!Number.isFinite(percent)) {
      return;
    }

    updateDownloadInProgress = true;
    setCheckUpdateButtonState(getDownloadingUpdateButtonHTML(percent), true);
  });

  window.electronAPI.onConversionProgress((progress) => {
    pendingProgressUpdate = progress;
    if (progressUpdateScheduled) {
      return;
    }

    progressUpdateScheduled = true;
    requestAnimationFrame(() => {
      progressUpdateScheduled = false;
      const latestProgress = pendingProgressUpdate;
      pendingProgressUpdate = null;
      if (!latestProgress) {
        return;
      }

      elements.progressFill.style.width = `${latestProgress.percent}%`;
      elements.progressFill.setAttribute(
        'aria-valuenow',
        String(Math.floor(latestProgress.percent))
      );
      elements.progressPercent.textContent = `${Math.floor(latestProgress.percent)}%`;
      elements.progressTime.textContent = latestProgress.time;

      if (latestProgress.percent > 0 && conversionStartTime > 0) {
        const elapsed = (Date.now() - conversionStartTime) / 1000;
        const estimatedTotal = elapsed / (latestProgress.percent / 100);
        const remaining = estimatedTotal - elapsed;
        if (remaining > 0 && remaining < 86400) {
          elements.progressEta.textContent = `ETA: ${formatDuration(remaining)}`;
        }
      }

      if (latestProgress.fps > 0) {
        elements.progressSpeed.textContent = `${latestProgress.fps.toFixed(1)} fps`;
      } else if (latestProgress.speed !== 'N/A') {
        elements.progressSpeed.textContent = latestProgress.speed;
      }
    });
  });

  window.electronAPI.onConversionLog((message) => {
    appendLogMessage(message);
  });

  window.electronAPI.onGPUEncoderError((error: GPUEncoderError) => {
    showGPUErrorStatus(error);
  });

  window.electronAPI.onUpdateAvailable((available: boolean) => {
    if (available) {
      elements.updateBadge.style.display = 'flex';
      setCheckUpdateButtonState(getUpdateAvailableButtonHTML(), false, true);
    } else {
      elements.updateBadge.style.display = 'none';
      setCheckUpdateButtonState(checkUpdateDefaultHTML, false);
    }

    manualUpdateCheckInProgress = false;
    updateDownloadInProgress = false;
  });
};

const showGPUErrorStatus = (error: GPUEncoderError): void => {
  appendLogMessage(`[GPU] ${error.message}\n${error.details}\n`);
  showStatus('warning', `${error.message}. ${error.suggestion}`);
};

const getFileName = (filePath: string): string => filePath.split(/[/\\]/).pop() || filePath;

const handleFileSelect = async (filePaths: string[]) => {
  const selectionToken = ++fileSelectionToken;
  const normalizedPaths = Array.from(new Set(filePaths.filter((path) => path && path.length > 0)));
  selectedFiles = normalizedPaths;

  if (selectedFiles.length === 0) {
    elements.fileInfo.classList.remove('visible');
    elements.convertBtn.disabled = true;
    return;
  }

  if (selectedFiles.length === 1) {
    const [filePath] = selectedFiles;
    elements.fileName.textContent = getFileName(filePath);

    const info = await window.electronAPI.getFileInfo(filePath);
    if (
      selectionToken !== fileSelectionToken ||
      selectedFiles.length !== 1 ||
      selectedFiles[0] !== filePath
    ) {
      return;
    }

    if (info) {
      const details: string[] = [];
      details.push(formatFileSize(info.size));
      if (info.width && info.height) {
        details.push(`${info.width}x${info.height}`);
      }
      if (info.codec && info.codec !== 'unknown') {
        details.push(info.codec.toUpperCase());
      }
      if (info.duration > 0) {
        details.push(formatDuration(info.duration));
      }
      elements.fileDetails.textContent = details.join(' \u2022 ');
    } else {
      elements.fileDetails.textContent = '';
    }
  } else {
    const previewCount = Math.min(3, selectedFiles.length);
    const previewNames = selectedFiles.slice(0, previewCount).map(getFileName);
    const remaining = selectedFiles.length - previewCount;
    elements.fileName.textContent = `${selectedFiles.length} files selected`;
    elements.fileDetails.textContent =
      remaining > 0
        ? `${previewNames.join(' \u2022 ')} \u2022 +${remaining} more`
        : previewNames.join(' \u2022 ');
  }

  elements.fileInfo.classList.add('visible');
  elements.convertBtn.disabled = !ffmpegInstalled;
  elements.showInFolderBtn.style.display = 'none';
  hideStatus();
};

const resolvePreferredGpuVendor = async (
  preset: Preset
): Promise<{ gpu: GPUVendor; codec: GPUCodec | null; reason: string }> => {
  const codec = getPresetCodec(preset);
  if (!codec) {
    return {
      gpu: 'cpu',
      codec: null,
      reason: 'Selected preset does not use video encoding.',
    };
  }

  const payload = await getGpuCapabilities(codec, false);
  if (settings.gpuMode === 'manual') {
    return {
      gpu: settings.gpuManualVendor,
      codec,
      reason: `Manual override: ${getGpuVendorLabel(settings.gpuManualVendor)}`,
    };
  }

  return {
    gpu: payload.recommendedVendor,
    codec,
    reason: payload.recommendationReason,
  };
};

const shouldRetryWithCpu = (
  result: ConversionResult,
  attemptedGpu: GPUVendor,
  codec: GPUCodec | null
): boolean => {
  if (attemptedGpu === 'cpu' || codec === null || result.success) {
    return false;
  }
  if (result.error === 'Conversion cancelled') {
    return false;
  }
  const message = (result.error || '').toLowerCase();
  const inputErrorMarkers = [
    'error opening input',
    'no such file or directory',
    'invalid data found when processing input',
    'moov atom not found',
    'permission denied',
  ];
  if (inputErrorMarkers.some((marker) => message.includes(marker))) {
    return false;
  }
  if (result.retryWithCpuSuggested === true) {
    return true;
  }
  const gpuMarkers = [
    'nvenc',
    'amf init',
    'amf failed',
    'amf error',
    'amf encoder',
    'qsv',
    'videotoolbox',
    'no capable devices found',
    'cannot load nvencode',
    'hardware acceleration',
    'gpu',
  ];
  return gpuMarkers.some((marker) => message.includes(marker));
};

const runSingleConversion = async (
  inputPath: string,
  presetId: string,
  fileIndex: number,
  totalFiles: number,
  batchOptions: BatchConversionOptions,
  codec: GPUCodec | null
): Promise<ConversionResult & { usedCpuFallback?: boolean }> => {
  conversionStartTime = Date.now();
  elements.progressFill.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  elements.progressTime.textContent = '00:00:00';
  elements.progressEta.textContent = '';
  elements.progressSpeed.textContent = '';

  const fileName = getFileName(inputPath);
  if (totalFiles > 1) {
    showStatus('warning', `Converting ${fileIndex + 1}/${totalFiles}: ${fileName}`);
  }

  if (batchOptions.showDebugOutput && totalFiles > 1) {
    appendLogMessage(`\n=== [${fileIndex + 1}/${totalFiles}] ${fileName} ===\n`);
  }

  const firstAttempt = await window.electronAPI.startConversion(
    inputPath,
    presetId,
    batchOptions.gpu,
    {
      suppressGpuErrorEvent: true,
      removeSpacesFromFilenames: batchOptions.removeSpacesFromFilenames,
      outputDirectory: batchOptions.outputDirectory,
      showDebugOutput: batchOptions.showDebugOutput,
    }
  );

  if (!cancelRequested && shouldRetryWithCpu(firstAttempt, batchOptions.gpu, codec)) {
    const fileNameForStatus = getFileName(inputPath);
    showStatus('warning', `GPU path failed for ${fileNameForStatus}. Retrying with CPU...`);
    if (batchOptions.showDebugOutput) {
      appendLogMessage(`[GPU fallback] Retry with CPU for ${fileNameForStatus}\n`);
    }
    const retryResult = await window.electronAPI.startConversion(inputPath, presetId, 'cpu', {
      suppressGpuErrorEvent: true,
      removeSpacesFromFilenames: batchOptions.removeSpacesFromFilenames,
      outputDirectory: batchOptions.outputDirectory,
      showDebugOutput: batchOptions.showDebugOutput,
    });
    return {
      ...retryResult,
      usedCpuFallback: true,
    };
  }

  return firstAttempt;
};

const finishConversionUi = () => {
  isConverting = false;
  cancelRequested = false;
  elements.progressContainer.classList.remove('visible');
  elements.convertBtn.innerHTML = convertBtnOriginalHTML;
  elements.convertBtn.classList.remove('converting');
  elements.convertBtn.disabled = !ffmpegInstalled || selectedFiles.length === 0;
  elements.cancelBtn.style.display = 'none';
};

const startConversion = async () => {
  await waitForAdvancedSettingsIdle();

  if (selectedFiles.length === 0) return;

  const presetId = selectedPresetId;
  if (!presetId) {
    showStatus('error', 'Select a conversion preset first');
    return;
  }
  const preset = presets.find((entry) => entry.id === presetId);
  if (!preset) {
    showStatus('error', 'Selected preset is no longer available');
    return;
  }

  try {
    await rememberRecentPreset(presetId);
  } catch {}

  let resolvedGpuVendor: GPUVendor = 'cpu';
  let codecForRetry: GPUCodec | null = null;
  try {
    const resolvedGpu = await resolvePreferredGpuVendor(preset);
    resolvedGpuVendor = resolvedGpu.gpu;
    codecForRetry = resolvedGpu.codec;
  } catch {
    resolvedGpuVendor = 'cpu';
    codecForRetry = null;
  }

  isConverting = true;
  cancelRequested = false;
  elements.convertBtn.classList.add('converting');
  elements.cancelBtn.style.display = 'inline-flex';
  elements.progressContainer.classList.add('visible');
  elements.showInFolderBtn.style.display = 'none';
  pendingProgressUpdate = null;
  progressUpdateScheduled = false;
  pendingLogBuffer = '';
  elements.logsContent.textContent = '';
  hideStatus();

  const batchOptions: BatchConversionOptions = {
    gpu: resolvedGpuVendor,
    removeSpacesFromFilenames: settings.removeSpacesFromFilenames,
    outputDirectory: settings.outputDirectory,
    showDebugOutput: settings.showDebugOutput,
  };

  const filesToConvert = [...selectedFiles];
  const totalFiles = filesToConvert.length;
  const results: Array<ConversionResult & { inputPath: string; usedCpuFallback?: boolean }> = [];
  let unexpectedError: string | null = null;

  try {
    for (let fileIndex = 0; fileIndex < totalFiles; fileIndex += 1) {
      if (cancelRequested) {
        break;
      }

      const inputPath = filesToConvert[fileIndex];
      const result = await runSingleConversion(
        inputPath,
        presetId,
        fileIndex,
        totalFiles,
        batchOptions,
        codecForRetry
      );
      results.push({ inputPath, ...result });

      if (result.usedCpuFallback && batchOptions.gpu !== 'cpu') {
        batchOptions.gpu = 'cpu';
      }

      if (result.success) {
        lastOutputPath = result.outputPath;
      }

      if (!result.success && result.error === 'Conversion cancelled') {
        cancelRequested = true;
        break;
      }
    }
  } catch (err) {
    unexpectedError = err instanceof Error ? err.message : String(err);
  }

  const wasCancelled = cancelRequested;
  finishConversionUi();
  if (unexpectedError) {
    showStatus('error', `Conversion failed: ${unexpectedError}`);
    elements.showInFolderBtn.style.display = 'none';
    return;
  }

  if (totalFiles === 1) {
    const [result] = results;
    if (result?.success && result.usedCpuFallback) {
      showStatus('warning', 'Conversion complete. GPU unavailable; retried with CPU.');
      elements.showInFolderBtn.style.display = 'inline-flex';
    } else if (result?.success) {
      showStatus('success', 'Conversion complete!');
      elements.showInFolderBtn.style.display = 'inline-flex';
    } else if (result?.error === 'Conversion cancelled' || wasCancelled) {
      showStatus('warning', 'Conversion cancelled');
    } else {
      showStatus('error', `Conversion failed: ${result?.error || 'Unknown error'}`);
    }
    return;
  }

  const successCount = results.filter((result) => result.success).length;
  const failedCount = results.length - successCount;
  const fallbackCount = results.filter((result) => result.usedCpuFallback).length;

  if (wasCancelled) {
    showStatus('warning', `Batch cancelled. ${successCount}/${totalFiles} converted.`);
  } else if (failedCount === 0) {
    if (fallbackCount > 0) {
      showStatus(
        'warning',
        `Batch complete. ${successCount}/${totalFiles} converted (${fallbackCount} CPU fallback).`
      );
    } else {
      showStatus('success', `Batch complete. ${successCount}/${totalFiles} converted.`);
    }
  } else if (successCount === 0) {
    showStatus('error', `Batch failed. 0/${totalFiles} converted.`);
  } else {
    showStatus(
      'warning',
      `Batch complete with errors. ${successCount}/${totalFiles} converted${fallbackCount > 0 ? ` (${fallbackCount} CPU fallback).` : '.'}`
    );
  }

  if (successCount > 0) {
    elements.showInFolderBtn.style.display = 'inline-flex';
  } else {
    elements.showInFolderBtn.style.display = 'none';
  }
};

const cancelConversion = async () => {
  if (!isConverting) return;
  cancelRequested = true;
  try {
    await window.electronAPI.cancelConversion(true);
    showStatus('warning', 'Cancelling conversion...');
  } catch (err) {
    showStatus(
      'error',
      `Failed to cancel conversion: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

const showStatus = (type: 'success' | 'error' | 'warning', message: string) => {
  elements.statusMessage.className = `status-message visible ${type}`;
  const textEl = elements.statusMessage.querySelector('.status-text');
  if (textEl) {
    textEl.textContent = message;
  } else {
    elements.statusMessage.textContent = message;
  }
};

const hideStatus = () => {
  elements.statusMessage.classList.remove('visible');
};

document.addEventListener('DOMContentLoaded', init);
