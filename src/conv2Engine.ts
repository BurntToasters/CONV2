import { api, fetchLicenses, listenConversionQueueUpdated } from './api';
import type * as Ipc from './generated/ipc-types';
import * as fileSelection from './fileSelection.js';
import type { FileSelectionMode } from './fileSelection.js';
import { summarizeQueueForUiStatus } from './queueSummary.js';
import * as pickerModel from './presetPickerModel.js';
import type { PresetPaneState, PresetParentBucket, PresetPickerItem } from './presetPickerModel.js';
import * as setupWizard from './setupWizard.js';
import { elements, getRequiredElement } from './dom.js';
import { copyText } from './clipboard.js';
import { closeErrorDetails } from './errorDetails.js';
import {
  formatDuration,
  formatFileSize,
  getFileName,
  hasAcceptedVideoExtension,
} from './format.js';
import { buildLicenseEntries, renderLicenses, type LicenseCrawlerEntry } from './licenses.js';
import {
  focusFirstInteractiveElement,
  getTopVisibleModal,
  handleTabKeyboardNavigation,
  trapFocusInModal,
} from './modals.js';
import {
  configureQueueView,
  getLastQueueDisplaySnapshot,
  renderConversionQueue,
} from './queueView.js';
import {
  drainSettingsSaves,
  enqueueSettingsTask,
  getCommittedSetting,
  queueSettingsSave,
  seedCommittedSettings,
  type SettingsSaveHandle,
} from './settingsStore';
import { hideStatus, showStatus } from './status.js';

// Backend falls back to a forced close at 1500 ms; ack before that.
const CLOSE_FLUSH_TIMEOUT_MS = 1000;
const RESTART_FLUSH_TIMEOUT_MS = 4000;

// IPC shapes come from the Rust types (src/generated/ipc-types.ts).
type AppSettings = Ipc.AppSettings;
type ConversionProgressPayload = Ipc.ConversionProgress;
type GPUCodec = Ipc.GpuCodec;
type GPUMode = Ipc.GpuMode;
type GPUVendor = Ipc.GpuVendor;
type QueueSnapshot = Ipc.QueueSnapshot;
type FFmpegStatus = Ipc.FFmpegStatus;
type GPUCapabilitiesPayload = Ipc.GPUCapabilitiesPayload;
type GPUEncoderError = Ipc.GPUEncoderError;
type RendererPreset = Ipc.RendererPreset;
type UpdateStatePayload = Ipc.UpdateStatePayload;
type UIPanelSettings = Ipc.UIPanelSettings;
type AdvancedFormatSettings = Ipc.AdvancedFormatSettings;
type AviAdvancedSettings = Ipc.AviAdvancedSettings;
type AviCodec = Ipc.AviCodec;
type AviTierCollection = Ipc.AviTierCollection;
type Av1AdvancedSettings = Ipc.Av1AdvancedSettings;
type Av1TierCollection = Ipc.Av1TierCollection;
type GifAdvancedSettings = Ipc.GifAdvancedSettings;
type GifDither = Ipc.GifDither;
type GifLoopMode = Ipc.GifLoopMode;
type GifTierCollection = Ipc.GifTierCollection;
type H264AdvancedSettings = Ipc.H264AdvancedSettings;
type H264TierCollection = Ipc.H264TierCollection;
type H265AdvancedSettings = Ipc.H265AdvancedSettings;
type H265TierCollection = Ipc.H265TierCollection;
type VideoPreset = Ipc.VideoPreset;
type WebpAdvancedSettings = Ipc.WebpAdvancedSettings;
type WebpTierCollection = Ipc.WebpTierCollection;

type Preset = RendererPreset;
type GifTierKey = keyof GifTierCollection;
type WebpTierKey = keyof WebpTierCollection;
type Av1TierKey = keyof Av1TierCollection;
type H264TierKey = keyof H264TierCollection;
type H265TierKey = keyof H265TierCollection;
type AviTierKey = keyof AviTierCollection;
type PresetPickerModelPreset = PresetPickerItem;

// Resolved by init() so src/main.ts can hold the window hidden until startup
// finishes, then report readiness to Rust.
let resolveRendererStartupReady!: () => void;
const rendererStartupReady = new Promise<void>((resolve) => {
  resolveRendererStartupReady = resolve;
});
window.__CONV2_RENDERER_STARTUP_READY__ = rendererStartupReady;

interface ModalOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmClass?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

let selectedFiles: string[] = [];
let isConverting = false;
let conversionStarting = false;
let settings: AppSettings;
let presets: Preset[] = [];
// Per-file ETA baseline: first progress sample of the current file (or after a retry).
let etaIndex = -1;
let etaT0 = 0;
let etaP0 = 0;
let etaLastPct = 0;
let lastOutputPath = '';
let themeListenerRegistered = false;
let convertBtnOriginalHTML = '';
let checkUpdateDefaultHTML = '';
let updateDownloadInProgress = false;
let updateAvailablePending = false;
let updateReadyToInstall = false;
let ffmpegInstalled = true;
let cancelRequested = false;
let closeDynamicModal: (() => void) | null = null;
let modalReturnFocus: HTMLElement | null = null;
let fileSelectionToken = 0;
let advancedSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLogBuffer = '';
let logFlushScheduled = false;
let pendingProgressUpdate: ConversionProgressPayload | null = null;
let progressUpdateScheduled = false;
const MAX_LOG_CHARS = 512 * 1024;
const MAX_RECENT_PRESET_IDS = 8;
const GPU_VENDORS: GPUVendor[] = ['nvidia', 'amd', 'intel', 'qualcomm', 'apple', 'cpu'];
const GPU_CODECS: GPUCodec[] = ['h264', 'h265', 'av1'];
type UIPanelKey = keyof UIPanelSettings;
const PRESET_CATEGORY_ORDER = ['av1', 'h265', 'h264', 'remux', 'audio', 'avi', 'gif', 'webp'];
type PresetParentKey = 'recent' | (typeof PRESET_CATEGORY_ORDER)[number];
let selectedPresetId = '';
let activePresetParentKey: PresetParentKey | '' = '';
let presetSearchAllFormats = false;
let currentPlatform = '';
let currentArch = '';
let lastGpuPayload: GPUCapabilitiesPayload | null = null;
const gpuCapabilitiesCache = new Map<string, GPUCapabilitiesPayload>();
let gpuPanelRenderToken = 0;

type QueueRunContext = {
  presetId: string;
  gpu: GPUVendor;
  removeSpacesFromFilenames: boolean;
  outputDirectory: string;
  showDebugOutput: boolean;
};

let lastQueueRunContext: QueueRunContext | null = null;

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

// Extensions accepted by the file-open dialog and via drag-drop

const getSetupWizard = (): typeof setupWizard => setupWizard;

const isSetupWizardBlockingUi = (): boolean => setupWizard.isSetupWizardVisible();

const conv2QueueUiStatus = summarizeQueueForUiStatus;

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
  if (vendor === 'qualcomm') return 'Qualcomm';
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

const updateGpuPanelSummary = (payload: GPUCapabilitiesPayload, codec: GPUCodec | null): void => {
  const modeLabel = settings.gpuMode === 'manual' ? 'Manual' : 'Auto';
  const vendorLabel = getGpuVendorLabel(payload.recommendedVendor);
  const codecLabel = codec ? getCodecLabel(codec) : 'this preset';

  if (settings.gpuMode === 'manual') {
    elements.gpuPanelSummary.textContent = `${modeLabel} · ${getGpuVendorLabel(settings.gpuManualVendor)}`;
    return;
  }

  if (payload.recommendedVendor === 'cpu' && payload.recommendationReason) {
    elements.gpuPanelSummary.textContent = `Auto · CPU · ${payload.recommendationReason}`;
    return;
  }

  elements.gpuPanelSummary.textContent = `Auto · ${vendorLabel} for ${codecLabel}`;
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
    empty.className = 'preset-empty preset-empty-state';
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
      card.dataset.presetId = pickerPreset.id;

      const detailsDiv = document.createElement('div');
      detailsDiv.className = 'preset-card-details';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'preset-card-name';
      nameSpan.textContent = pickerPreset.displayName;
      detailsDiv.appendChild(nameSpan);

      if (group.key === 'recent' && pickerPreset.categoryLabel) {
        const codecSpan = document.createElement('span');
        codecSpan.className = 'preset-card-codec';
        codecSpan.textContent = pickerPreset.categoryLabel;
        detailsDiv.appendChild(codecSpan);
      }
      card.appendChild(detailsDiv);

      const fullPreset = visiblePresetById.get(pickerPreset.id);
      if (fullPreset) {
        card.title = fullPreset.description;

        // Add visual intent badge
        const intentKey = getPresetIntentKey(fullPreset);
        const tone = getPresetIntentTone(intentKey);
        const label = getPresetIntentLabel(intentKey);

        const badgeSpan = document.createElement('span');
        badgeSpan.className = `preset-intent-badge ${tone}`;
        badgeSpan.textContent = label;
        card.appendChild(badgeSpan);
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

    if (visibleSorted.length === 0) {
      elements.presetCountLabel.textContent = '0 presets';
      updatePresetPanelSummary(0);
      elements.presetParentList.innerHTML = '';
      elements.presetCardList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'preset-empty preset-empty-state';
      const hasHiddenAdvanced =
        !settings.showAdvancedPresets && presets.some((preset) => preset.isAdvanced);
      empty.textContent = hasHiddenAdvanced
        ? 'No presets visible. Turn on Advanced presets in Settings to see more formats.'
        : 'No presets available.';
      elements.presetCardList.appendChild(empty);
      elements.presetSelectionPreview.innerHTML = '';
      return;
    }

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
      PresetParentKey | '';
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
  const handle = queueSettingsSave({ recentPresetIds: nextRecent });
  try {
    await handle.done;
  } catch (err) {
    restoreCommittedSettings(handle.liveKeys());
    throw err;
  }
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
  const payload = await api.getGpuCapabilities(requestedCodec);
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

  const [singleCodec] = codecsToRender;
  if (singleCodec) {
    const statusHeader = document.createElement('th');
    statusHeader.textContent = `${getCodecLabel(singleCodec)} Status`;
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

    if (singleCodec) {
      const entry = payload.matrix[singleCodec]?.[vendor];
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
      const available = !!entry?.available;
      status.className = `gpu-status ${available ? 'available' : 'unavailable'}`;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-label', available ? 'Available' : 'Unavailable');
      const icon = document.createElement('span');
      icon.className = 'gpu-status-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = available ? '✓' : '✕';
      const label = document.createElement('span');
      label.textContent = available ? 'Available' : 'Unavailable';
      status.append(icon, label);
      cell.appendChild(status);

      const reason = document.createElement('div');
      reason.className = 'gpu-reason';
      const reasonText = entry?.reason || 'Not checked.';
      reason.textContent = reasonText.length > 120 ? `${reasonText.slice(0, 117)}...` : reasonText;
      cell.appendChild(reason);
      row.appendChild(cell);
    };

    if (singleCodec) {
      appendStatusCell(singleCodec);
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
  qualcomm: 'Qualcomm (Media Foundation)',
};

/** Qualcomm's Media Foundation encoders exist only on Windows on Arm. */
const isQualcommHost = (): boolean => currentPlatform === 'win32' && currentArch === 'arm64';

/** Linux Intel and AMD encode through VAAPI, so the dropdown names that path. */
const getVendorDropdownLabel = (vendor: GPUVendor): string => {
  if (currentPlatform === 'linux' && (vendor === 'intel' || vendor === 'amd')) {
    return `${getGpuVendorLabel(vendor)} (VAAPI)`;
  }
  return GPU_VENDOR_DROPDOWN_LABELS[vendor] || getGpuVendorLabel(vendor);
};

const updateManualVendorDropdown = (
  payload: GPUCapabilitiesPayload,
  currentCodec: GPUCodec | null
): void => {
  const select = elements.gpuManualVendorSelect;
  const previousValue = select.value as GPUVendor;
  select.innerHTML = '';

  const availableVendors = getAvailableVendors(payload);
  const vendorsToShow = (settings.showAllGpuVendors ? GPU_VENDORS : availableVendors).filter(
    (vendor) => vendor !== 'qualcomm' || isQualcommHost()
  );

  vendorsToShow.forEach((vendor) => {
    const option = document.createElement('option');
    option.value = vendor;
    const label = getVendorDropdownLabel(vendor);
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
      const handle = queueSettingsSave({ gpuManualVendor: firstEnabled });
      void handle.done.catch((err: unknown) => {
        showStatus('error', `Failed to save GPU vendor: ${getErrorMessage(err)}`);
      });
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

  settings.uiPanels = { ...settings.uiPanels, [panel]: expanded };
  applyPanelCollapseUi();

  const panelUpdate: Partial<UIPanelSettings> =
    panel === 'presetExpanded' ? { presetExpanded: expanded } : { gpuExpanded: expanded };
  const handle = queueSettingsSave({ uiPanels: panelUpdate });
  try {
    await handle.done;
  } catch (err) {
    if (handle.liveKeys().length > 0) {
      restoreCommittedSettings(handle.liveKeys());
      applyPanelCollapseUi();
    }
    showStatus('error', `Failed to save panel layout: ${getErrorMessage(err)}`);
  }
};

const getErrorMessage = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err);
};

/** Puts the backend's last accepted values back into memory for `keys`. */
const restoreCommittedSettings = (keys: readonly string[]): void => {
  const target = settings as unknown as Record<string, unknown>;
  for (const key of keys) {
    const [top = '', sub] = key.split('.');
    const value = getCommittedSetting(key);
    target[top] =
      sub === undefined ? value : { ...(target[top] as Record<string, unknown>), [sub]: value };
  }
};

const persistSettingsChange = async (
  apply: () => void,
  /** Runs after memory is restored from committed values; resync the UI only. */
  rollback: () => void,
  payload: Record<string, unknown>,
  failurePrefix: string,
  onSuccess?: () => Promise<void> | void
): Promise<void> => {
  apply();
  const handle = queueSettingsSave(payload);
  try {
    await handle.done;
  } catch (err) {
    // Keys a newer change owns are left to it.
    const liveKeys = handle.liveKeys();
    if (liveKeys.length > 0) {
      restoreCommittedSettings(liveKeys);
      rollback();
    }
    showStatus('error', `${failurePrefix}: ${getErrorMessage(err)}`);
    return;
  }
  if (!onSuccess) {
    return;
  }
  // The save succeeded, so a follow-up failure must not revert it.
  try {
    await onSuccess();
  } catch (err) {
    showStatus('error', `Setting saved, but applying it failed: ${getErrorMessage(err)}`);
  }
};

/** Keeps the destructive-action reminder next to Convert in sync with settings. */
const updateTrashOriginalNotice = (): void => {
  elements.trashOriginalNotice.classList.toggle(
    'u-hidden',
    settings.moveOriginalToTrashOnSuccess !== true
  );
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
    updateGpuPanelSummary(summaryPayload, selectedCodec);

    if (token !== gpuPanelRenderToken) {
      return;
    }

    if (!selectedPreset || !selectedCodec) {
      renderGpuCapabilityMatrix(summaryPayload, []);
      updateGpuPanelSummary(summaryPayload, null);
      return;
    }

    renderGpuCapabilityMatrix(summaryPayload, [selectedCodec]);
  } catch (err) {
    if (token !== gpuPanelRenderToken) {
      return;
    }
    elements.gpuPanelSummary.textContent = 'Unavailable';
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

const webpTierInputs: Record<
  WebpTierKey,
  {
    fps: HTMLInputElement;
    maxDimension: HTMLInputElement;
    quality: HTMLInputElement;
  }
> = {
  bestQuality: {
    fps: elements.webpBestQualityFps,
    maxDimension: elements.webpBestQualityMaxDimension,
    quality: elements.webpBestQualityQuality,
  },
  quality: {
    fps: elements.webpQualityFps,
    maxDimension: elements.webpQualityMaxDimension,
    quality: elements.webpQualityQuality,
  },
  balanced: {
    fps: elements.webpBalancedFps,
    maxDimension: elements.webpBalancedMaxDimension,
    quality: elements.webpBalancedQuality,
  },
  bestCompression: {
    fps: elements.webpBestCompressionFps,
    maxDimension: elements.webpBestCompressionMaxDimension,
    quality: elements.webpBestCompressionQuality,
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
  elements.formatTabWebp,
  elements.formatTabAv1,
  elements.formatTabH264,
  elements.formatTabH265,
  elements.formatTabAvi,
];
const formatPanels = [
  elements.formatPanelGif,
  elements.formatPanelWebp,
  elements.formatPanelAv1,
  elements.formatPanelH264,
  elements.formatPanelH265,
  elements.formatPanelAvi,
];

const setSettingsPanel = (
  panelId: 'settingsGeneralPanel' | 'settingsAdvancedFormatsPanel' | 'settingsDebugPanel'
): void => {
  settingsPanels.forEach((panel) => {
    const isActive = panel.id === panelId;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
    if (isActive) {
      panel.scrollTop = 0;
    }
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
  | 'formatPanelWebp'
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

const setWebpControlValues = (webp: WebpAdvancedSettings): void => {
  elements.webpLoopModeSelect.value = webp.loopMode;
  (Object.keys(webpTierInputs) as WebpTierKey[]).forEach((tier) => {
    const tierInputs = webpTierInputs[tier];
    const tierSettings = webp.tiers[tier];
    tierInputs.fps.value = String(tierSettings.fps);
    tierInputs.maxDimension.value = String(tierSettings.maxDimension);
    tierInputs.quality.value = String(tierSettings.quality);
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
  setWebpControlValues(advanced.webp);
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

const readWebpControls = (): WebpAdvancedSettings => {
  return {
    loopMode: elements.webpLoopModeSelect.value as GifLoopMode,
    tiers: {
      bestQuality: {
        fps: parseNumericInput(elements.webpBestQualityFps.value),
        maxDimension: parseNumericInput(elements.webpBestQualityMaxDimension.value),
        quality: parseNumericInput(elements.webpBestQualityQuality.value),
      },
      quality: {
        fps: parseNumericInput(elements.webpQualityFps.value),
        maxDimension: parseNumericInput(elements.webpQualityMaxDimension.value),
        quality: parseNumericInput(elements.webpQualityQuality.value),
      },
      balanced: {
        fps: parseNumericInput(elements.webpBalancedFps.value),
        maxDimension: parseNumericInput(elements.webpBalancedMaxDimension.value),
        quality: parseNumericInput(elements.webpBalancedQuality.value),
      },
      bestCompression: {
        fps: parseNumericInput(elements.webpBestCompressionFps.value),
        maxDimension: parseNumericInput(elements.webpBestCompressionMaxDimension.value),
        quality: parseNumericInput(elements.webpBestCompressionQuality.value),
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
    webp: readWebpControls(),
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

// Half-typed numbers (empty or invalid) must never reach the backend.
const hasIncompleteAdvancedInput = (): boolean => {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input.advanced-control')).some(
    (control) =>
      control.type === 'number' &&
      (control.value.trim() === '' || !Number.isFinite(Number(control.value)))
  );
};

/** Queues an advanced-format task; `canSyncControls` says if rewriting the inputs is safe. */
const enqueueAdvancedSettingsTask = (
  run: (canSyncControls: () => boolean) => Promise<void>
): Promise<void> => {
  let handle: SettingsSaveHandle | null = null;
  handle = enqueueSettingsTask(['advancedFormatSettings'], () =>
    // Not while the user is typing, or after a newer save was queued.
    run(() => handle?.isStale() !== true && advancedSaveDebounceTimer === null)
  );
  return handle.done;
};

const persistAdvancedFormatSettings = async (
  nextAdvancedSettings: AdvancedFormatSettings,
  normalize: boolean,
  canSyncControls: () => boolean
): Promise<void> => {
  const previousSettings = settings.advancedFormatSettings;

  try {
    await api.saveSettings({
      advancedFormatSettings: nextAdvancedSettings,
    });
    const refreshed = await api.getSettings();
    settings.advancedFormatSettings = refreshed.advancedFormatSettings;
    // The backend clamps values; show that only once editing has finished.
    if (
      normalize &&
      canSyncControls() &&
      !areAdvancedSettingsEqual(refreshed.advancedFormatSettings, nextAdvancedSettings)
    ) {
      setAdvancedFormatControlValues(refreshed.advancedFormatSettings);
    }
  } catch (err) {
    settings.advancedFormatSettings = previousSettings;
    if (canSyncControls()) {
      setAdvancedFormatControlValues(previousSettings);
    }
    showStatus('error', `Failed to save advanced format settings: ${getErrorMessage(err)}`);
  }
};

const queueAdvancedSettingsSaveFromControls = (normalize: boolean): void => {
  if (hasIncompleteAdvancedInput()) {
    if (normalize) {
      // Runs after earlier saves, so memory holds the latest saved values.
      void enqueueAdvancedSettingsTask(async (canSyncControls) => {
        if (canSyncControls()) {
          setAdvancedFormatControlValues(settings.advancedFormatSettings);
        }
      });
    }
    return;
  }
  const nextAdvancedSettings = readAdvancedFormatControls();
  void enqueueAdvancedSettingsTask((canSyncControls) =>
    persistAdvancedFormatSettings(nextAdvancedSettings, normalize, canSyncControls)
  );
};

type AdvancedFormatKey = keyof AdvancedFormatSettings;

const cancelAdvancedSettingsDebounce = (): void => {
  if (advancedSaveDebounceTimer) {
    clearTimeout(advancedSaveDebounceTimer);
    advancedSaveDebounceTimer = null;
  }
};

const resetFormatSettingsToDefaults = async (
  format: AdvancedFormatKey,
  label: string
): Promise<void> => {
  cancelAdvancedSettingsDebounce();

  await enqueueAdvancedSettingsTask(async (canSyncControls) => {
    const previousSettings = settings.advancedFormatSettings;

    try {
      const defaults = (await api.getDefaultSettings()).advancedFormatSettings;
      await api.saveSettings({
        advancedFormatSettings: {
          [format]: defaults[format],
        } as unknown as AdvancedFormatSettings,
      });
      settings.advancedFormatSettings = (await api.getSettings()).advancedFormatSettings;
      if (canSyncControls()) {
        setAdvancedFormatControlValues(settings.advancedFormatSettings);
      }
    } catch (err) {
      settings.advancedFormatSettings = previousSettings;
      if (canSyncControls()) {
        setAdvancedFormatControlValues(previousSettings);
      }
      showStatus('error', `Failed to reset ${label} settings: ${getErrorMessage(err)}`);
    }
  });
};

const scheduleAdvancedSettingsSave = (): void => {
  cancelAdvancedSettingsDebounce();
  advancedSaveDebounceTimer = setTimeout(() => {
    advancedSaveDebounceTimer = null;
    queueAdvancedSettingsSaveFromControls(false);
  }, 220);
};

const flushPendingAdvancedSettingsSave = (): void => {
  if (!advancedSaveDebounceTimer) {
    return;
  }
  cancelAdvancedSettingsDebounce();
  queueAdvancedSettingsSaveFromControls(true);
};

/** Sends any debounced edit, then waits (bounded) for every queued save. */
const flushSettingsSaves = async (timeoutMs: number): Promise<boolean> => {
  flushPendingAdvancedSettingsSave();
  return drainSettingsSaves(timeoutMs);
};

const waitForAdvancedSettingsIdle = async (): Promise<void> => {
  await flushSettingsSaves(RESTART_FLUSH_TIMEOUT_MS);
};

const openSettingsModal = (): void => {
  if (isSetupWizardBlockingUi()) {
    return;
  }
  if (elements.settingsModal.classList.contains('visible')) {
    return;
  }
  modalReturnFocus = document.activeElement as HTMLElement | null;
  setSettingsPanel('settingsGeneralPanel');
  syncSettingsControls();
  elements.settingsModal.classList.add('visible');
  focusFirstInteractiveElement(elements.settingsModal);
};

const closeSettingsModal = async (): Promise<void> => {
  await waitForAdvancedSettingsIdle();
  elements.settingsModal.classList.remove('visible');
  if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
    modalReturnFocus.focus();
    modalReturnFocus = null;
  }
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

const getInstallUpdateButtonHTML = (): string =>
  '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>Restart Now';

const getInstallingUpdateButtonHTML = (): string =>
  '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>Restarting...';

const getUpdateAvailableButtonHTML = (): string =>
  '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Update Available!';

const setCheckUpdateButtonState = (
  html: string,
  disabled: boolean,
  highlightAvailable = false
): void => {
  // eslint-disable-next-line no-unsanitized/property -- the module's own constant SVG labels; no user input.
  elements.checkUpdateBtn.innerHTML = html;
  elements.checkUpdateBtn.disabled = disabled;
  elements.checkUpdateBtn.classList.toggle('btn-update-available', highlightAvailable);
};

const showModal = (options: ModalOptions): void => {
  // A modal still open is cancelled first so its confirm cannot fire later.
  closeDynamicModal?.();
  const modal = elements.dynamicModal;
  const returnFocus = document.activeElement as HTMLElement | null;
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
    if (returnFocus && typeof returnFocus.focus === 'function') {
      returnFocus.focus();
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

const openCreditsModal = async (): Promise<void> => {
  if (isSetupWizardBlockingUi()) {
    return;
  }
  if (elements.settingsModal.classList.contains('visible')) {
    await closeSettingsModal();
  }
  modalReturnFocus = document.activeElement as HTMLElement | null;
  elements.creditsModal.classList.add('visible');
  focusFirstInteractiveElement(elements.creditsModal);
  elements.licensesList.innerHTML = '<div class="license-item">Loading credits...</div>';

  try {
    const { npm, cargo } = await fetchLicenses();
    const isPopulated = (data: Record<string, unknown> | null): boolean =>
      !!data && typeof data === 'object' && Object.keys(data).length > 0;
    renderLicenses(
      buildLicenseEntries(
        npm as Record<string, LicenseCrawlerEntry> | null,
        cargo as Record<string, LicenseCrawlerEntry> | null
      )
    );

    const missing: string[] = [];
    if (!isPopulated(npm)) {
      missing.push(
        'licenses.json is missing or empty. Run "npm run licenses" before packaging to include dependency credits.'
      );
    }
    if (!isPopulated(cargo)) {
      missing.push(
        'licenses-cargo.json is missing or empty. Run "npm run licenses" before packaging to include Rust crate credits.'
      );
    }
    for (const text of missing) {
      const warning = document.createElement('div');
      warning.className = 'license-item license-error';
      warning.textContent = text;
      elements.licensesList.appendChild(warning);
    }
  } catch {
    elements.licensesList.innerHTML =
      '<div class="license-item license-error">Unable to load licenses.json. Run "npm run licenses" to generate it.</div>';
  }
};

const closeCreditsModal = (): void => {
  elements.creditsModal.classList.remove('visible');
  if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
    modalReturnFocus.focus();
    modalReturnFocus = null;
  }
};

let conversionMenuStateTimer: ReturnType<typeof setTimeout> | null = null;

const syncConversionMenuState = (): void => {
  if (conversionMenuStateTimer) {
    clearTimeout(conversionMenuStateTimer);
  }
  conversionMenuStateTimer = setTimeout(() => {
    conversionMenuStateTimer = null;
    // Menu enablement is best-effort; a miss only delays the next sync.
    void api
      .setConversionMenuState({
        converting: isConverting || conversionStarting,
        hasOutput: Boolean(lastOutputPath),
      })
      .catch(() => undefined);
  }, 0);
};

const hasBlockingModalForShortcuts = (): boolean => {
  return (
    isSetupWizardBlockingUi() ||
    elements.settingsModal.classList.contains('visible') ||
    elements.dynamicModal.classList.contains('visible') ||
    elements.logsModal.classList.contains('visible') ||
    elements.creditsModal.classList.contains('visible')
  );
};

const openLogsModal = (): void => {
  if (isSetupWizardBlockingUi()) {
    return;
  }
  if (!settings.showDebugOutput) {
    showStatus(
      'warning',
      'Debug logging is off. Enable “Show debug output” in Settings → Debug to view logs.'
    );
    return;
  }
  flushLogBuffer();
  modalReturnFocus = document.activeElement as HTMLElement | null;
  elements.logsModal.classList.add('visible');
  focusFirstInteractiveElement(elements.logsModal);
};

const handleAppMenuAction = (event: { action: string; payload?: { paths?: string[] } }): void => {
  switch (event.action) {
    case 'open-settings':
      if (!hasBlockingModalForShortcuts()) {
        openSettingsModal();
      }
      break;
    case 'open-files':
      if (getTopVisibleModal()) {
        return;
      }
      if (event.payload?.paths && event.payload.paths.length > 0) {
        void handleFileSelect(event.payload.paths);
      }
      break;
    case 'start-conversion':
      if (
        !hasBlockingModalForShortcuts() &&
        selectedFiles.length > 0 &&
        !isConverting &&
        !elements.convertBtn.disabled
      ) {
        startConversion();
      }
      break;
    case 'cancel-conversion':
      // Skipped while another modal is on top, so it cannot stack over it.
      if (isConverting && !getTopVisibleModal()) {
        showModal({
          title: 'Cancel Conversion',
          message:
            'Are you sure you want to cancel the conversion? The partial file will be deleted.',
          confirmText: 'Yes, Cancel',
          cancelText: 'No, Continue',
          confirmClass: 'btn-danger',
          onConfirm: () => {
            void cancelConversion();
          },
        });
      }
      break;
    case 'show-logs':
      openLogsModal();
      break;
    case 'open-credits':
      void openCreditsModal();
      break;
    case 'show-in-folder':
      if (lastOutputPath) {
        void api.revealPath(lastOutputPath);
      }
      break;
    default:
      break;
  }
};

const setupAppMenuActions = (): void => {
  api.onAppMenuAction(handleAppMenuAction);
};

// Native asks for a flush before closing; it force-closes if we are late.
const setupCloseFlush = (): void => {
  api.onPrepareForClose((generation) => {
    void (async () => {
      try {
        await flushSettingsSaves(CLOSE_FLUSH_TIMEOUT_MS);
      } catch {
        // close anyway; failed saves were already reported
      }
      try {
        await api.notifySettingsFlushed(generation);
      } catch {
        // stale generation: native already closed or retried
      }
    })();
  });
};

const updateWindowMaximizeUi = (maximized: boolean): void => {
  const maxIcon = elements.windowMaximizeBtn.querySelector('.window-control-icon-maximize');
  const restoreIcon = elements.windowMaximizeBtn.querySelector('.window-control-icon-restore');
  maxIcon?.classList.toggle('u-hidden', maximized);
  restoreIcon?.classList.toggle('u-hidden', !maximized);
  elements.windowMaximizeBtn.setAttribute(
    'aria-label',
    maximized ? 'Restore window' : 'Maximize window'
  );
};

const applyWindowChromeStyle = (payload: { platform: string; customTitleBar: boolean }): void => {
  const root = document.documentElement;
  root.dataset.platform = payload.platform;
  if (payload.customTitleBar) {
    root.dataset.customTitlebar = 'true';
    elements.titlebar.dataset.customTitlebar = 'true';
  } else {
    delete root.dataset.customTitlebar;
    elements.titlebar.dataset.customTitlebar = 'false';
  }

  const showWinControls = payload.platform === 'win32' && payload.customTitleBar;
  elements.windowControls.classList.toggle('u-hidden', !showWinControls);
  if (showWinControls) {
    void api.isWindowMaximized().then(updateWindowMaximizeUi);
  }
};

const setupWindowChrome = (): void => {
  api.onWindowMaximizedChanged(updateWindowMaximizeUi);

  elements.windowMinimizeBtn.addEventListener('click', () => {
    void api.minimizeWindow();
  });
  elements.windowMaximizeBtn.addEventListener('click', () => {
    void api.toggleMaximizeWindow();
  });
  // close() raises CloseRequested, so native runs its flush handshake first.
  elements.windowCloseBtn.addEventListener('click', () => {
    void api.closeWindow().catch((err: unknown) => {
      showStatus('error', `Could not close the window: ${getErrorMessage(err)}`);
    });
  });

  // Frameless windows drag through Tauri rather than -webkit-app-region,
  // which WKWebView ignores.
  elements.titlebar.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || document.documentElement.dataset.platform === 'linux') {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, select, textarea')) {
      return;
    }
    void api.startDragging();
  });

  elements.titlebar.addEventListener('dblclick', (event) => {
    if (document.documentElement.dataset.platform !== 'win32') {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('button')) {
      return;
    }
    void api.toggleMaximizeWindow();
  });
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

/** Non-critical startup step: a failure is logged and the UI carries on. */
const runBestEffort = async (label: string, step: () => Promise<void>): Promise<void> => {
  try {
    await step();
  } catch (error) {
    api.logError(`Startup step "${label}" failed: ${getErrorMessage(error)}`);
  }
};

/** Critical startup failure: say why and offer a restart instead of a dead window. */
const showStartupFailure = (error: unknown): void => {
  const detail = getErrorMessage(error);
  console.error('[conv2] renderer startup failed', error);
  api.logError(`Renderer startup failed: ${detail}`);
  showModal({
    title: 'CONV2 Could Not Start',
    message: `Startup did not finish, so parts of the app will not respond. Restart CONV2 to try again.

${detail}`,
    confirmText: 'Restart',
    cancelText: 'Dismiss',
    confirmClass: 'btn-danger',
    onConfirm: () => {
      void api.restartApp().catch((restartError: unknown) => {
        showStatus('error', `Could not restart: ${getErrorMessage(restartError)}`);
      });
    },
  });
};

const init = async () => {
  configureQueueView({
    isConverting: () => isConverting,
    hasRunContext: () => lastQueueRunContext !== null,
    retry: (inputPath) => {
      if (isConverting || conversionStarting) return;
      void runConversionWorkflow([inputPath]);
    },
  });
  convertBtnOriginalHTML = elements.convertBtn.innerHTML;
  checkUpdateDefaultHTML = elements.checkUpdateBtn.innerHTML;
  tagAdvancedTierCards();
  setupWindowChrome();
  setupCloseFlush();
  try {
    await runBestEffort('FFmpeg check', checkFFmpeg);
    await checkPlatform();
    await loadSettings();
    setupEventListeners();
    setupKeyboardShortcuts();
    setupAppMenuActions();
    await loadPresets();
  } catch (error) {
    showStartupFailure(error);
    return;
  }
  await runBestEffort('version', loadVersion);
  await runBestEffort('theme', applyTheme);
  await runBestEffort('update visibility', applyUpdateVisibility);
  await runBestEffort('queue restore', rehydrateRunningBatch);
  syncConversionMenuState();
  getSetupWizard()?.maybeOpenSetupWizard();
  document.documentElement.dataset.appReady = 'true';
};

const checkPlatform = async () => {
  currentPlatform = await api.getPlatform();
  currentArch = await api.getArch();
  // v1 sent this from the main process; the platform answer drives it here.
  applyWindowChromeStyle({
    platform: currentPlatform,
    customTitleBar: currentPlatform === 'darwin' || currentPlatform === 'win32',
  });
  const appleOption =
    elements.gpuManualVendorSelect.querySelector<HTMLOptionElement>('option[value="apple"]');
  if (appleOption) {
    const allowApple = currentPlatform === 'darwin';
    appleOption.hidden = !allowApple;
    appleOption.disabled = !allowApple;
  }
  const qualcommOption = elements.gpuManualVendorSelect.querySelector<HTMLOptionElement>(
    'option[value="qualcomm"]'
  );
  if (qualcommOption) {
    const allowQualcomm = isQualcommHost();
    qualcommOption.hidden = !allowQualcomm;
    qualcommOption.disabled = !allowQualcomm;
  }
};

const ffmpegWarningMessage = (status: FFmpegStatus): string => {
  if (!status.usingBundled) {
    return 'FFmpeg was not found on your system PATH. Install FFmpeg, or turn off System FFmpeg in Settings.';
  }
  if (status.reason === 'verification-failed') {
    return "CONV2's bundled FFmpeg failed its integrity check. Reinstall CONV2, or enable System FFmpeg in Settings.";
  }
  if (status.reason === 'not-runnable') {
    return "CONV2's bundled FFmpeg could not start. Reinstall CONV2.";
  }
  return "CONV2's bundled FFmpeg is missing. Reinstall CONV2, or enable System FFmpeg in Settings.";
};

const checkFFmpeg = async () => {
  const status = await api.checkFFmpeg();
  const installed = status.ok;
  ffmpegInstalled = installed;
  if (!installed) {
    // textContent only: the message is composed from status fields, never from HTML.
    const heading = elements.ffmpegWarning.querySelector('h3');
    const message = elements.ffmpegWarning.querySelector('p');
    const isMissing = status.reason === 'missing';
    if (heading) {
      heading.textContent = isMissing ? 'FFmpeg Not Found' : 'FFmpeg Unavailable';
    }
    if (message) {
      message.textContent = ffmpegWarningMessage(status);
    }
    elements.ffmpegWarning.classList.remove('u-hidden');
    if (!isConverting) {
      elements.convertBtn.disabled = true;
    }
    return;
  }

  elements.ffmpegWarning.classList.add('u-hidden');
  if (!isConverting && selectedFiles.length > 0) {
    elements.convertBtn.disabled = false;
  }
};

const loadSettings = async () => {
  settings = await api.getSettings();
  settings.recentPresetIds = normalizeRecentPresetIds(settings.recentPresetIds);
  if (
    !settings.advancedFormatSettings ||
    !settings.advancedFormatSettings.gif ||
    !settings.advancedFormatSettings.webp ||
    !settings.advancedFormatSettings.av1 ||
    !settings.advancedFormatSettings.h264 ||
    !settings.advancedFormatSettings.h265 ||
    !settings.advancedFormatSettings.avi
  ) {
    settings.advancedFormatSettings = (await api.getDefaultSettings()).advancedFormatSettings;
  }
  settings.gpuMode = settings.gpuMode === 'manual' ? 'manual' : 'auto';
  if (!GPU_VENDORS.includes(settings.gpuManualVendor)) {
    settings.gpuManualVendor = 'cpu';
  }
  if (currentPlatform !== 'darwin' && settings.gpuManualVendor === 'apple') {
    settings.gpuManualVendor = 'cpu';
  }
  if (!isQualcommHost() && settings.gpuManualVendor === 'qualcomm') {
    settings.gpuManualVendor = 'cpu';
  }
  settings.uiPanels = normalizeUiPanels(settings.uiPanels);
  settings.gpu = settings.gpuManualVendor;
  if (!settings.customTheme) {
    settings.customTheme = 'midnight-blue';
  }
  seedCommittedSettings(settings);
  applyGpuModeUi();
  applyPanelCollapseUi();
  elements.gpuManualVendorSelect.value = settings.gpuManualVendor;
  elements.presetPanelSummary.textContent = 'No preset selected';
  presetSearchAllFormats = false;
  elements.presetSearchAllCheck.checked = false;
  setSettingsPanel('settingsGeneralPanel');
  setFormatPanel('formatPanelGif');
  syncSettingsControls();
};

/** Pushes in-memory settings into the Settings controls and main-window output label. */
const syncSettingsControls = (): void => {
  elements.themeSelect.value = settings.theme;
  updateThemeSwitcher();
  updateUiStyleSwitcher();
  elements.debugOutputCheck.checked = settings.showDebugOutput;
  elements.advancedPresetsCheck.checked = settings.showAdvancedPresets;
  elements.removeSpacesCheck.checked = settings.removeSpacesFromFilenames;
  elements.autoCheckUpdatesCheck.checked = settings.autoCheckUpdates;
  elements.useSystemFFmpegCheck.checked = settings.useSystemFfmpeg;
  elements.useCpuDecodingWhenGpuCheck.checked = settings.useCpuDecodingWhenGpu;
  elements.moveOriginalToTrashOnSuccessCheck.checked = settings.moveOriginalToTrashOnSuccess;
  updateTrashOriginalNotice();
  elements.notifyOnConversionCompleteCheck.checked = settings.notifyOnConversionComplete !== false;
  elements.preventSleepWhileConvertingCheck.checked = settings.preventSleepWhileConverting === true;
  elements.showAllGpuVendorsCheck.checked = settings.showAllGpuVendors;
  elements.updateChannelSelect.value = settings.updateChannel;
  if (advancedSaveDebounceTimer === null) {
    setAdvancedFormatControlValues(settings.advancedFormatSettings);
  }

  if (settings.showDebugOutput) {
    elements.showLogsBtn.classList.remove('u-hidden');
  } else {
    elements.showLogsBtn.classList.add('u-hidden');
  }

  syncOutputDirectoryUi();
};

const syncOutputDirectoryUi = (): void => {
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
    presets = await api.getPresets();
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
  const version = await api.getVersion();
  const tagUrl = `https://github.com/BurntToasters/CONV2/releases/tag/v${version}`;
  elements.versionInfo.textContent = `CONV2 v${version}`;
  elements.versionLink.href = tagUrl;
  elements.versionLink.title = `View release v${version}`;
  const isBeta = /-(beta|alpha|rc)/i.test(version);
  elements.betaLabel.classList.toggle('u-hidden', !isBeta);
};

const applyUpdateVisibility = async () => {
  // Store builds update outside the app and hide the UI. Flatpak keeps it: the backend
  // answers a manual check with a notice and refuses download/install.
  const distributionChannel = await api.getDistributionChannel();
  const updatesDisabled = distributionChannel === 'msstore';
  const updateChannelSetting = document.getElementById('updateChannelSetting');
  if (updatesDisabled) {
    elements.checkUpdateBtn.classList.add('u-hidden');
    elements.updateBadge.classList.add('u-hidden');
    elements.autoCheckUpdatesCheck.disabled = true;
    if (updateChannelSetting) {
      updateChannelSetting.classList.add('u-hidden');
    }
  }
};

const resolveActiveThemeAttribute = async (): Promise<string> => {
  if (settings.theme === 'custom') {
    return settings.customTheme || 'midnight-blue';
  }
  if (settings.theme === 'system') {
    return api.getSystemTheme();
  }
  return settings.theme;
};

const updateCustomThemeUi = () => {
  const isCustom = settings.theme === 'custom';
  elements.customThemeRow.hidden = !isCustom;
  elements.customThemeGallery.querySelectorAll('.theme-swatch').forEach((btn) => {
    const id = (btn as HTMLElement).dataset.customTheme;
    const active = isCustom && id === settings.customTheme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
};

const updateThemeSwitcher = () => {
  const switcher = document.getElementById('themeSwitcher');
  if (!switcher) return;

  switcher.querySelectorAll('.theme-option').forEach((btn) => {
    const btnTheme = (btn as HTMLElement).dataset.theme;
    const active = btnTheme === settings.theme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  updateCustomThemeUi();
};

const updateUiStyleSwitcher = () => {
  const switcher = document.getElementById('uiStyleSwitcher');
  if (!switcher) return;

  switcher.querySelectorAll('.theme-option').forEach((btn) => {
    const btnStyle = (btn as HTMLElement).dataset.style;
    const active = btnStyle === settings.interfaceStyle;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
};

const applyTheme = async () => {
  const themeAttr = await resolveActiveThemeAttribute();
  document.documentElement.setAttribute('data-theme', themeAttr);

  const style = settings.interfaceStyle === 'flat' ? 'flat' : 'glass';
  document.documentElement.setAttribute('data-ui-style', style);

  // Pre-paint theme for the next launch; public/theme-init.js reads these.
  try {
    localStorage.setItem('theme', settings.theme);
    localStorage.setItem('customTheme', settings.customTheme || 'midnight-blue');
    localStorage.setItem('interfaceStyle', style);
  } catch {
    // storage can be unavailable; the in-page attributes above still apply
  }

  updateThemeSwitcher();
  updateUiStyleSwitcher();

  if (!themeListenerRegistered) {
    api.onThemeChange(async (theme) => {
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
      const wizardOverlay = getSetupWizard()?.getSetupWizardOverlay() ?? null;
      if (topModal === wizardOverlay) {
        getSetupWizard()?.skipSetupWizardFromEscape();
        return;
      }
      if (topModal === elements.errorDetailsModal) {
        closeErrorDetails();
        return;
      }
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
        if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
          modalReturnFocus.focus();
          modalReturnFocus = null;
        }
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
      void openFilePicker();
      return;
    }

    if (
      e.key === '/' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLTextAreaElement) &&
      !(e.target instanceof HTMLSelectElement)
    ) {
      const isModalOpen = hasBlockingModalForShortcuts();
      if (!isModalOpen) {
        e.preventDefault();
        elements.presetSearch.focus();
        elements.presetSearch.select();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === ',' || e.code === 'Comma')) {
      e.preventDefault();
      if (!hasBlockingModalForShortcuts()) {
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
      const isModalOpen = hasBlockingModalForShortcuts();
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
        panelId === 'formatPanelWebp' ||
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
          panelId === 'formatPanelWebp' ||
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

      // Change fires on blur or commit, so the saved value may be normalized here.
      control.addEventListener('change', () => {
        cancelAdvancedSettingsDebounce();
        queueAdvancedSettingsSaveFromControls(true);
      });
    });

  elements.resetGifDefaultsBtn.addEventListener('click', async () => {
    await resetFormatSettingsToDefaults('gif', 'GIF');
  });

  elements.resetWebpDefaultsBtn.addEventListener('click', async () => {
    await resetFormatSettingsToDefaults('webp', 'WebP');
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
    void api.openExternal('https://rosie.run/support');
  });

  elements.supportBtn.addEventListener('click', () => {
    void api.openExternal('https://rosie.run/support');
  });

  elements.versionLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (elements.versionLink.href) {
      void api.openExternal(elements.versionLink.href);
    }
  });

  document.getElementById('help-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    void api.openExternal('https://help.rosie.run/conv2/en-us/faq');
  });

  document.getElementById('about-privacy')?.addEventListener('click', (e) => {
    e.preventDefault();
    void api.openExternal('https://help.rosie.run/conv2/en-us/privacy-policy');
  });

  document.getElementById('rosie-run')?.addEventListener('click', (e) => {
    e.preventDefault();
    void api.openExternal('https://rosie.run');
  });

  elements.dropZone.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('button')) {
      void openFilePicker();
    }
  });

  elements.dropZone.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openFilePicker();
    }
  });

  elements.browseFilesBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    void openFilePicker();
  });
  elements.clearSelectedFilesBtn.addEventListener('click', () => {
    void handleFileSelect([], 'replace');
  });

  // Tauri's drag-drop overlay owns the whole window and delivers real file
  // paths; the HTML5 dragover/drop handlers from v1 are gone with it.
  api.onDragDropEvent((event) => {
    if (isSetupWizardBlockingUi()) {
      elements.dropZone.classList.remove('dragover');
      return;
    }
    if (event.type === 'enter' || event.type === 'over') {
      elements.dropZone.classList.add('dragover');
      return;
    }
    elements.dropZone.classList.remove('dragover');
    if (event.type !== 'drop') {
      return;
    }
    const filePaths = event.paths.filter(
      (filePath) => filePath.length > 0 && hasAcceptedVideoExtension(filePath)
    );
    if (event.paths.length > 0 && filePaths.length === 0) {
      showStatus('error', 'Unsupported file type. Drop a video file (MP4, MKV, MOV, …).');
      return;
    }
    if (filePaths.length > 0) {
      void handleFileSelect(filePaths);
    }
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
    void api
      .refreshGpuCapabilities()
      .catch(() => undefined)
      .then(() => {
        clearGpuCapabilitiesCache();
        return refreshGpuPanel(true);
      });
  });

  const persistGpuMode = async (nextMode: GPUMode): Promise<void> => {
    settings.gpuMode = nextMode;
    settings.gpu = settings.gpuManualVendor;
    applyGpuModeUi();
    const handle = queueSettingsSave({
      gpuMode: settings.gpuMode,
      gpuManualVendor: settings.gpuManualVendor,
      gpu: settings.gpuManualVendor,
    });
    try {
      await handle.done;
    } catch (err) {
      if (handle.liveKeys().length > 0) {
        restoreCommittedSettings(handle.liveKeys());
        applyGpuModeUi();
      }
      showStatus('error', `Failed to save GPU mode: ${getErrorMessage(err)}`);
      return;
    }
    void refreshGpuPanel(false);
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
    settings.gpuManualVendor = elements.gpuManualVendorSelect.value as GPUVendor;
    settings.gpu = settings.gpuManualVendor;
    const handle = queueSettingsSave({
      gpuManualVendor: settings.gpuManualVendor,
      gpu: settings.gpuManualVendor,
    });
    try {
      await handle.done;
    } catch (err) {
      if (handle.liveKeys().length > 0) {
        restoreCommittedSettings(handle.liveKeys());
        elements.gpuManualVendorSelect.value = settings.gpuManualVendor;
      }
      showStatus('error', `Failed to save GPU vendor: ${getErrorMessage(err)}`);
      return;
    }
    void refreshGpuPanel(false);
  });

  elements.themeSelect.addEventListener('change', async () => {
    const nextTheme = elements.themeSelect.value as AppSettings['theme'];
    await persistSettingsChange(
      () => {
        settings.theme = nextTheme;
      },
      () => {
        elements.themeSelect.value = settings.theme;
      },
      { theme: nextTheme },
      'Failed to save theme',
      async () => {
        await applyTheme();
        updateThemeSwitcher();
      }
    );
  });

  elements.themeSwitcher?.querySelectorAll('.theme-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const theme = (btn as HTMLElement).dataset.theme as AppSettings['theme'];
      if (theme) {
        await persistSettingsChange(
          () => {
            settings.theme = theme;
            elements.themeSelect.value = theme;
          },
          () => {
            elements.themeSelect.value = settings.theme;
          },
          { theme },
          'Failed to save theme',
          async () => {
            await applyTheme();
            updateThemeSwitcher();
          }
        );
      }
    });
  });

  elements.customThemeGallery?.querySelectorAll('.theme-swatch').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const customTheme = (btn as HTMLElement).dataset.customTheme as AppSettings['customTheme'];
      if (!customTheme) return;
      await persistSettingsChange(
        () => {
          settings.theme = 'custom';
          settings.customTheme = customTheme;
          elements.themeSelect.value = 'custom';
        },
        () => {
          elements.themeSelect.value = settings.theme;
        },
        { theme: 'custom', customTheme },
        'Failed to save custom theme',
        async () => {
          await applyTheme();
          updateThemeSwitcher();
        }
      );
    });
  });

  elements.uiStyleSwitcher?.querySelectorAll('.theme-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uiStyle = (btn as HTMLElement).dataset.style as AppSettings['interfaceStyle'];
      if (uiStyle) {
        await persistSettingsChange(
          () => {
            settings.interfaceStyle = uiStyle;
          },
          () => {},
          { interfaceStyle: uiStyle },
          'Failed to save interface style',
          async () => {
            await applyTheme();
          }
        );
      }
    });
  });

  elements.debugOutputCheck.addEventListener('change', async () => {
    const nextValue = elements.debugOutputCheck.checked;
    await persistSettingsChange(
      () => {
        settings.showDebugOutput = nextValue;
      },
      () => {
        elements.debugOutputCheck.checked = settings.showDebugOutput;
      },
      { showDebugOutput: nextValue },
      'Failed to save debug output setting',
      () => {
        elements.showLogsBtn.classList.toggle('u-hidden', !settings.showDebugOutput);
      }
    );
  });

  elements.advancedPresetsCheck.addEventListener('change', async () => {
    const nextValue = elements.advancedPresetsCheck.checked;
    await persistSettingsChange(
      () => {
        settings.showAdvancedPresets = nextValue;
      },
      () => {
        elements.advancedPresetsCheck.checked = settings.showAdvancedPresets;
      },
      { showAdvancedPresets: nextValue },
      'Failed to save advanced presets setting',
      async () => {
        await loadPresets();
      }
    );
  });

  elements.removeSpacesCheck.addEventListener('change', async () => {
    const nextValue = elements.removeSpacesCheck.checked;
    await persistSettingsChange(
      () => {
        settings.removeSpacesFromFilenames = nextValue;
      },
      () => {
        elements.removeSpacesCheck.checked = settings.removeSpacesFromFilenames;
      },
      { removeSpacesFromFilenames: nextValue },
      'Failed to save filename spacing setting'
    );
  });

  elements.autoCheckUpdatesCheck.addEventListener('change', async () => {
    const nextValue = elements.autoCheckUpdatesCheck.checked;
    await persistSettingsChange(
      () => {
        settings.autoCheckUpdates = nextValue;
      },
      () => {
        elements.autoCheckUpdatesCheck.checked = settings.autoCheckUpdates;
      },
      { autoCheckUpdates: nextValue },
      'Failed to save auto-update setting'
    );
  });

  elements.updateChannelSelect.addEventListener('change', async () => {
    const nextValue = elements.updateChannelSelect.value as AppSettings['updateChannel'];
    settings.updateChannel = nextValue;
    const handle = enqueueSettingsTask(['updateChannel'], () => api.setUpdateChannel(nextValue), {
      updateChannel: nextValue,
    });
    try {
      await handle.done;
    } catch (err) {
      if (handle.liveKeys().length > 0) {
        restoreCommittedSettings(handle.liveKeys());
        elements.updateChannelSelect.value = settings.updateChannel;
      }
      showStatus('error', `Failed to save update channel: ${getErrorMessage(err)}`);
    }
  });

  elements.useSystemFFmpegCheck.addEventListener('change', async () => {
    const nextValue = elements.useSystemFFmpegCheck.checked;
    await persistSettingsChange(
      () => {
        settings.useSystemFfmpeg = nextValue;
      },
      () => {
        elements.useSystemFFmpegCheck.checked = settings.useSystemFfmpeg;
      },
      { useSystemFfmpeg: nextValue },
      'Failed to save FFmpeg source setting',
      async () => {
        clearGpuCapabilitiesCache();
        await checkFFmpeg();
        void refreshGpuPanel(true);
      }
    );
  });

  elements.useCpuDecodingWhenGpuCheck.addEventListener('change', async () => {
    const nextValue = elements.useCpuDecodingWhenGpuCheck.checked;
    await persistSettingsChange(
      () => {
        settings.useCpuDecodingWhenGpu = nextValue;
      },
      () => {
        elements.useCpuDecodingWhenGpuCheck.checked = settings.useCpuDecodingWhenGpu;
      },
      { useCpuDecodingWhenGpu: nextValue },
      'Failed to save CPU decoding setting'
    );
  });

  elements.moveOriginalToTrashOnSuccessCheck.addEventListener('change', async () => {
    const nextValue = elements.moveOriginalToTrashOnSuccessCheck.checked;
    const previousValue = settings.moveOriginalToTrashOnSuccess;

    const persist = () =>
      persistSettingsChange(
        () => {
          settings.moveOriginalToTrashOnSuccess = nextValue;
        },
        () => {
          elements.moveOriginalToTrashOnSuccessCheck.checked =
            settings.moveOriginalToTrashOnSuccess;
          updateTrashOriginalNotice();
        },
        { moveOriginalToTrashOnSuccess: nextValue },
        'Failed to save trash-on-success setting',
        () => {
          updateTrashOriginalNotice();
        }
      );

    // Turning it off is always safe; turning it on deletes source files.
    if (!nextValue) {
      await persist();
      return;
    }

    showModal({
      title: 'Trash originals after conversion?',
      message:
        'Every successful conversion, including each file in a batch, will move the source file to the system trash. Files stay recoverable until the trash is emptied.',
      confirmText: 'Enable',
      cancelText: 'Keep originals',
      confirmClass: 'btn-danger',
      onConfirm: () => {
        void persist();
      },
      onCancel: () => {
        elements.moveOriginalToTrashOnSuccessCheck.checked = previousValue;
      },
    });
  });

  elements.notifyOnConversionCompleteCheck.addEventListener('change', async () => {
    const nextValue = elements.notifyOnConversionCompleteCheck.checked;
    await persistSettingsChange(
      () => {
        settings.notifyOnConversionComplete = nextValue;
      },
      () => {
        elements.notifyOnConversionCompleteCheck.checked = settings.notifyOnConversionComplete;
      },
      { notifyOnConversionComplete: nextValue },
      'Failed to save notification setting'
    );
  });

  elements.preventSleepWhileConvertingCheck.addEventListener('change', async () => {
    const nextValue = elements.preventSleepWhileConvertingCheck.checked;
    await persistSettingsChange(
      () => {
        settings.preventSleepWhileConverting = nextValue;
      },
      () => {
        elements.preventSleepWhileConvertingCheck.checked = settings.preventSleepWhileConverting;
      },
      { preventSleepWhileConverting: nextValue },
      'Failed to save prevent-sleep setting'
    );
  });

  elements.showAllGpuVendorsCheck.addEventListener('change', async () => {
    const nextValue = elements.showAllGpuVendorsCheck.checked;
    await persistSettingsChange(
      () => {
        settings.showAllGpuVendors = nextValue;
      },
      () => {
        elements.showAllGpuVendorsCheck.checked = settings.showAllGpuVendors;
      },
      { showAllGpuVendors: nextValue },
      'Failed to save GPU vendor visibility setting',
      () => {
        void refreshGpuPanel(false);
      }
    );
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
      showModal({
        title: 'Cancel Conversion',
        message:
          'Are you sure you want to cancel the conversion? The partial file will be deleted.',
        confirmText: 'Yes, Cancel',
        cancelText: 'No, Continue',
        confirmClass: 'btn-danger',
        onConfirm: () => {
          void cancelConversion();
        },
      });
    }
  });

  elements.retryFailedQueueBtn.addEventListener('click', () => {
    if (
      isConverting ||
      conversionStarting ||
      !getLastQueueDisplaySnapshot() ||
      !lastQueueRunContext
    ) {
      return;
    }
    const failedPaths = (getLastQueueDisplaySnapshot()?.items ?? [])
      .filter((item) => item.status === 'failed')
      .map((item) => item.inputPath);
    if (failedPaths.length === 0) {
      return;
    }
    void runConversionWorkflow(failedPaths);
  });

  elements.showInFolderBtn?.addEventListener('click', () => {
    if (lastOutputPath) {
      void api.revealPath(lastOutputPath);
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
    openLogsModal();
  });

  elements.closeLogs.addEventListener('click', () => {
    elements.logsModal.classList.remove('visible');
    if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
      modalReturnFocus.focus();
      modalReturnFocus = null;
    }
  });

  elements.logsModal.addEventListener('click', (e) => {
    if (e.target === elements.logsModal) {
      elements.logsModal.classList.remove('visible');
      if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
        modalReturnFocus.focus();
        modalReturnFocus = null;
      }
    }
  });

  elements.clearLogsBtn.addEventListener('click', () => {
    pendingLogBuffer = '';
    elements.logsContent.textContent = '';
  });

  // Captured once so a second click within 2s cannot record "Copied!" as the resting label.
  const copyLogsDefaultHTML = elements.copyLogsBtn.innerHTML;
  let copyLogsResetTimer: ReturnType<typeof setTimeout> | null = null;
  elements.copyLogsBtn.addEventListener('click', () => {
    flushLogBuffer();
    void copyText(elements.logsContent.textContent || '').then((copied) => {
      if (copyLogsResetTimer) clearTimeout(copyLogsResetTimer);
      if (copied) {
        elements.copyLogsBtn.innerHTML =
          '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Copied!';
      } else {
        elements.copyLogsBtn.textContent = 'Copy failed';
        showStatus('error', 'Failed to copy logs: the clipboard is unavailable.');
      }
      copyLogsResetTimer = setTimeout(() => {
        copyLogsResetTimer = null;
        // eslint-disable-next-line no-unsanitized/property -- restores this button's own markup captured at startup.
        elements.copyLogsBtn.innerHTML = copyLogsDefaultHTML;
      }, 2000);
    });
  });

  elements.viewCreditsBtn.addEventListener('click', () => {
    void openCreditsModal();
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
    const dir = await api.selectOutputDirectory();
    if (dir) {
      await persistSettingsChange(
        () => {
          settings.outputDirectory = dir;
          elements.outputPath.textContent = dir;
          elements.outputDirResetBtn.hidden = false;
        },
        syncOutputDirectoryUi,
        { outputDirectory: dir },
        'Failed to save output directory'
      );
    }
  });

  elements.outputDirResetBtn.addEventListener('click', async () => {
    await persistSettingsChange(
      () => {
        settings.outputDirectory = '';
        elements.outputPath.textContent = 'Same as input file';
        elements.outputDirResetBtn.hidden = true;
      },
      syncOutputDirectoryUi,
      { outputDirectory: '' },
      'Failed to reset output directory'
    );
  });

  elements.resetSettingsBtn.addEventListener('click', () => {
    showModal({
      title: 'Reset Settings',
      message:
        isConverting || conversionStarting
          ? 'Are you sure you want to reset all settings to defaults? The running conversion will be cancelled and its partial file deleted, then the app will restart.'
          : 'Are you sure you want to reset all settings to defaults? The app will restart.',
      confirmText: 'Reset & Restart',
      cancelText: 'Cancel',
      confirmClass: 'btn-danger',
      onConfirm: async () => {
        try {
          // Queued saves must land before the reset; unsent edits are discarded by it.
          cancelAdvancedSettingsDebounce();
          await drainSettingsSaves(RESTART_FLUSH_TIMEOUT_MS);
          await api.resetSettings();
          cancelAdvancedSettingsDebounce();
          await drainSettingsSaves(RESTART_FLUSH_TIMEOUT_MS);
          await api.restartApp();
        } catch (err) {
          showStatus('error', `Failed to reset settings: ${getErrorMessage(err)}`);
        }
      },
    });
  });

  elements.checkUpdateBtn.addEventListener('click', () => {
    if (updateReadyToInstall) {
      updateReadyToInstall = false;
      setCheckUpdateButtonState(getInstallingUpdateButtonHTML(), true);
      void flushSettingsSaves(RESTART_FLUSH_TIMEOUT_MS)
        .then(() => api.installUpdate())
        .catch((err: unknown) => {
          updateReadyToInstall = true;
          setCheckUpdateButtonState(getInstallUpdateButtonHTML(), false, true);
          showStatus('error', `Could not install the update: ${getErrorMessage(err)}`);
        });
      return;
    }

    if (updateAvailablePending) {
      updateAvailablePending = false;
      updateDownloadInProgress = true;
      setCheckUpdateButtonState(getDownloadingUpdateButtonHTML(), true);
      void api.downloadUpdate().catch((err: unknown) => {
        updateDownloadInProgress = false;
        updateAvailablePending = true;
        setCheckUpdateButtonState(getUpdateAvailableButtonHTML(), false, true);
        showStatus('error', `Could not download the update: ${getErrorMessage(err)}`);
      });
      return;
    }
    updateDownloadInProgress = false;
    setCheckUpdateButtonState(getCheckingUpdateButtonHTML(), true);
    void api.checkForUpdates().catch((err: unknown) => {
      setCheckUpdateButtonState(checkUpdateDefaultHTML, false);
      showStatus('error', `Could not check for updates: ${getErrorMessage(err)}`);
    });
  });

  api.onUpdateState((payload: UpdateStatePayload) => {
    showUpdateMessage(payload);
    const phase = payload.phase;
    const percent = typeof payload.percent === 'number' ? payload.percent : undefined;
    if (phase === 'checking') {
      updateDownloadInProgress = false;
      if (updateReadyToInstall) {
        return;
      }
      updateAvailablePending = false;
      setCheckUpdateButtonState(getCheckingUpdateButtonHTML(), true);
      return;
    }

    if (phase === 'downloading') {
      updateDownloadInProgress = true;
      updateAvailablePending = false;
      updateReadyToInstall = false;
      setCheckUpdateButtonState(getDownloadingUpdateButtonHTML(percent), true);
      return;
    }

    if (phase === 'available') {
      elements.updateBadge.classList.remove('u-hidden');
      updateAvailablePending = true;
      setCheckUpdateButtonState(getUpdateAvailableButtonHTML(), false, true);
      updateDownloadInProgress = false;
      updateReadyToInstall = false;
      return;
    }

    if (phase === 'installing') {
      updateDownloadInProgress = false;
      updateAvailablePending = false;
      updateReadyToInstall = false;
      setCheckUpdateButtonState(getInstallingUpdateButtonHTML(), true);
      return;
    }

    if (phase === 'downloaded') {
      updateDownloadInProgress = false;
      updateAvailablePending = false;
      updateReadyToInstall = true;
      elements.updateBadge.classList.remove('u-hidden');
      setCheckUpdateButtonState(getInstallUpdateButtonHTML(), false, true);
      return;
    }

    // Main sends a ready update as 'downloaded', so these phases mean nothing is installable.
    if (phase === 'not-available' || phase === 'disabled') {
      updateAvailablePending = false;
      elements.updateBadge.classList.add('u-hidden');
      setCheckUpdateButtonState(checkUpdateDefaultHTML, false);
      updateDownloadInProgress = false;
      updateReadyToInstall = false;
      return;
    }

    if (phase === 'already-checking') {
      if (!updateReadyToInstall) {
        setCheckUpdateButtonState(getCheckingUpdateButtonHTML(), true);
      }
      return;
    }

    if (phase === 'error') {
      const wasDownloading = updateDownloadInProgress;
      updateDownloadInProgress = false;
      if (updateReadyToInstall) {
        updateAvailablePending = false;
        setCheckUpdateButtonState(getInstallUpdateButtonHTML(), false, true);
        elements.updateBadge.classList.remove('u-hidden');
        return;
      }
      if (wasDownloading) {
        updateAvailablePending = true;
        elements.updateBadge.classList.remove('u-hidden');
        setCheckUpdateButtonState(getUpdateAvailableButtonHTML(), false, true);
        return;
      }
      updateAvailablePending = false;
      updateReadyToInstall = false;
      setCheckUpdateButtonState(checkUpdateDefaultHTML, false);
      elements.updateBadge.classList.add('u-hidden');
    }
  });

  api.onConversionProgress((progress) => {
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

      const clampedPercent = Number.isFinite(latestProgress.percent)
        ? Math.max(0, Math.min(100, latestProgress.percent))
        : 0;
      elements.progressFill.style.width = `${clampedPercent}%`;
      elements.progressFill.setAttribute('aria-valuenow', String(Math.floor(clampedPercent)));
      elements.progressPercent.textContent = `${Math.floor(clampedPercent)}%`;
      elements.progressTime.textContent = latestProgress.time;

      // A percent drop of more than 1 point means the same file restarted (GPU->CPU retry).
      if (etaT0 === 0 || clampedPercent < etaLastPct - 1) {
        resetEtaBaseline();
        etaT0 = Date.now();
        etaP0 = clampedPercent;
      }
      etaLastPct = clampedPercent;
      const etaElapsed = (Date.now() - etaT0) / 1000;
      const etaGain = clampedPercent - etaP0;
      let etaText = '';
      if (etaGain > 0 && etaElapsed >= 2) {
        const remaining = (etaElapsed * (100 - clampedPercent)) / etaGain;
        if (remaining > 0 && remaining < 86400) {
          etaText = `ETA: ${formatDuration(remaining)}`;
        }
      }
      elements.progressEta.textContent = etaText;

      if (latestProgress.fps > 0) {
        elements.progressSpeed.textContent = `${latestProgress.fps.toFixed(1)} fps`;
      } else if (latestProgress.speed !== 'N/A') {
        elements.progressSpeed.textContent = latestProgress.speed;
      }
    });
  });

  api.onConversionLog((message) => {
    appendLogMessage(message);
  });

  api.onGPUEncoderError((error: GPUEncoderError) => {
    showGPUErrorStatus(error);
  });

  document.getElementById('replaySetupWizardBtn')?.addEventListener('click', () => {
    void (async () => {
      if (elements.settingsModal.classList.contains('visible')) {
        await closeSettingsModal();
      }
      getSetupWizard()?.openSetupWizard();
    })();
  });

  getSetupWizard()?.initSetupWizard({
    getSettings: () => settings,
    patchSettings: (partial) => {
      Object.assign(settings, partial);
    },
    saveSettings: async (partial) => {
      const { updateChannel, ...patch } = partial;
      const handles: SettingsSaveHandle[] = [];
      if (Object.keys(patch).length > 0) {
        handles.push(queueSettingsSave(patch));
      }
      if (updateChannel) {
        handles.push(
          enqueueSettingsTask(['updateChannel'], () => api.setUpdateChannel(updateChannel), {
            updateChannel,
          })
        );
      }
      try {
        await Promise.all(handles.map((handle) => handle.done));
      } catch (err) {
        // Memory must match disk, except keys a newer change owns.
        await Promise.allSettled(handles.map((handle) => handle.done));
        const keys = handles.flatMap((handle) => handle.liveKeys());
        if (keys.length > 0) {
          restoreCommittedSettings(keys);
          syncSettingsControls();
          if (keys.includes('theme') || keys.includes('interfaceStyle')) {
            void applyTheme();
          }
        }
        throw err;
      }
    },
    setUpdateChannel: async (channel) => {
      await enqueueSettingsTask(['updateChannel'], () => api.setUpdateChannel(channel)).done;
    },
    onClosed: syncSettingsControls,
    reportError: (message) => {
      showStatus('error', message);
    },
    applyTheme,
    applyGpuModeUi,
    persistGpuMode,
    selectOutputDirectory: async () => {
      const dir = await api.selectOutputDirectory();
      return dir || undefined;
    },
    openHelp: () => {
      void api.openExternal('https://help.rosie.run/conv2/en-us/faq');
    },
    focusFirstIn: focusFirstInteractiveElement,
    isFfmpegInstalled: () => ffmpegInstalled,
    prepareAppTourSpotlight: (targetId) => {
      applyPanelCollapseUi();
      if (targetId === 'mainOptionsPanel') {
        elements.presetPanelBody.hidden = false;
        elements.presetPanelToggle.setAttribute('aria-expanded', 'true');
        elements.presetPanelSection.classList.add('is-expanded');
      }
    },
    clearAppTourSpotlight: () => {
      applyPanelCollapseUi();
    },
  });
};

/** Manual update actions explain themselves in the status line (latest version, feed errors, notices). */
const showUpdateMessage = (payload: UpdateStatePayload): void => {
  const message = payload.message?.trim();
  if (!payload.manual || !message) {
    return;
  }
  const type =
    payload.phase === 'error' ? 'error' : payload.phase === 'not-available' ? 'success' : 'warning';
  showStatus(type, message);
};

const showGPUErrorStatus = (error: GPUEncoderError): void => {
  appendLogMessage(`[GPU] ${error.message}\n${error.details}\n`);
  showStatus('warning', `${error.message}. ${error.suggestion}`);
};

const getFileSelection = (): typeof fileSelection => fileSelection;

const renderSelectedFileList = (): void => {
  elements.selectedFileList.replaceChildren();
  selectedFiles.forEach((filePath, index) => {
    const item = document.createElement('li');
    item.className = 'selected-file-item';

    const name = document.createElement('span');
    name.className = 'selected-file-name';
    name.textContent = getFileName(filePath);
    name.title = filePath;

    const actions = document.createElement('div');
    actions.className = 'selected-file-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn btn-secondary btn-xs';
    upBtn.textContent = 'Up';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      selectedFiles = getFileSelection().moveSelectedFile(selectedFiles, index, -1);
      void refreshSelectedFilesUi();
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn btn-secondary btn-xs';
    downBtn.textContent = 'Down';
    downBtn.disabled = index === selectedFiles.length - 1;
    downBtn.addEventListener('click', () => {
      selectedFiles = getFileSelection().moveSelectedFile(selectedFiles, index, 1);
      void refreshSelectedFilesUi();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-secondary btn-xs';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      selectedFiles = getFileSelection().removeSelectedFile(selectedFiles, index);
      void refreshSelectedFilesUi();
    });

    actions.append(upBtn, downBtn, removeBtn);
    item.append(name, actions);
    elements.selectedFileList.append(item);
  });
};

// Edits during a batch only change the list for the next run; the Convert/Cancel
// button, progress status and Show in Folder belong to the running batch.
const isBatchBusy = (): boolean => isConverting || conversionStarting;

const refreshSelectedFilesUi = async (): Promise<void> => {
  const selectionToken = ++fileSelectionToken;
  if (selectedFiles.length === 0) {
    elements.fileInfo.classList.remove('visible');
    elements.fileName.textContent = '';
    elements.fileDetails.textContent = '';
    elements.selectedFileList.replaceChildren();
    if (!isBatchBusy()) {
      elements.convertBtn.disabled = true;
    }
    return;
  }

  if (selectedFiles.length === 1) {
    const [filePath] = selectedFiles;
    if (!filePath) {
      return;
    }
    elements.fileName.textContent = getFileName(filePath);
    const info = await api.getFileInfo(filePath).catch(() => null);
    if (selectionToken !== fileSelectionToken || selectedFiles[0] !== filePath) {
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
    elements.fileName.textContent = `${selectedFiles.length} files selected`;
    elements.fileDetails.textContent = 'Use the list to remove or reorder files';
  }

  renderSelectedFileList();
  elements.fileInfo.classList.add('visible');
  if (isBatchBusy()) {
    return;
  }
  elements.convertBtn.disabled = !ffmpegInstalled;
  elements.showInFolderBtn.classList.add('u-hidden');
  hideStatus();
};

const handleFileSelect = async (
  filePaths: string[],
  mode: FileSelectionMode = 'append'
): Promise<void> => {
  selectedFiles = getFileSelection().mergeSelectedFilePaths(selectedFiles, filePaths, mode);
  await refreshSelectedFilesUi();
};

/** Native file dialog; the webview's input[type=file] cannot yield paths. */
const openFilePicker = async (): Promise<void> => {
  try {
    const selected = await api.selectInputFiles();
    const filePaths = selected.filter(
      (filePath) => filePath.length > 0 && hasAcceptedVideoExtension(filePath)
    );
    if (selected.length > 0 && filePaths.length === 0) {
      showStatus('error', 'Unsupported file type. Pick a video file (MP4, MKV, MOV, …).');
      return;
    }
    if (filePaths.length > 0) {
      await handleFileSelect(filePaths);
    }
  } catch (err) {
    showStatus('error', `Could not open the file picker: ${getErrorMessage(err)}`);
  }
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

const finishConversionUi = () => {
  isConverting = false;
  cancelRequested = false;
  elements.progressContainer.classList.remove('visible');
  // eslint-disable-next-line no-unsanitized/property -- restores this button's own markup captured at startup.
  elements.convertBtn.innerHTML = convertBtnOriginalHTML;
  elements.convertBtn.classList.remove('converting');
  elements.convertBtn.disabled = !ffmpegInstalled || selectedFiles.length === 0;
  elements.cancelBtn.classList.add('u-hidden');
  syncConversionMenuState();
};

const resetEtaBaseline = (): void => {
  etaT0 = 0;
  etaP0 = 0;
  etaLastPct = 0;
  elements.progressEta.textContent = '';
};

const enterConvertingUi = (): void => {
  isConverting = true;
  cancelRequested = false;
  syncConversionMenuState();
  elements.convertBtn.classList.add('converting');
  elements.convertBtn.disabled = true;
  elements.cancelBtn.classList.remove('u-hidden');
  elements.progressContainer.classList.add('visible');
  elements.showInFolderBtn.classList.add('u-hidden');
  pendingProgressUpdate = null;
  progressUpdateScheduled = false;
  pendingLogBuffer = '';
  elements.logsContent.textContent = '';
  hideStatus();
  etaIndex = -1;
  resetEtaBaseline();
  elements.progressFill.style.width = '0%';
  elements.progressFill.setAttribute('aria-valuenow', '0');
  elements.progressPercent.textContent = '0%';
  elements.progressTime.textContent = '00:00:00';
  elements.progressEta.textContent = '';
  elements.progressSpeed.textContent = '';
  elements.progressBatchSummary.textContent = '';
  renderConversionQueue(null);
};

const renderQueueSnapshotUi = (next: QueueSnapshot): void => {
  renderConversionQueue(next);
  if (next.currentIndex !== etaIndex) {
    etaIndex = next.currentIndex;
    resetEtaBaseline();
  }
  const running = next.items.find((item) => item.status === 'running');
  if (running && next.total > 1) {
    elements.progressBatchSummary.textContent = `File ${next.currentIndex + 1} of ${next.total}: ${running.fileName}`;
    showStatus('warning', `Converting ${next.currentIndex + 1}/${next.total}: ${running.fileName}`);
  }
};

/** Leaves the converting UI and shows how the batch ended. */
const presentBatchOutcome = (
  snapshot: QueueSnapshot | null,
  totalFiles: number,
  unexpectedError: string | null
): void => {
  const wasCancelled =
    cancelRequested || snapshot?.items.some((item) => item.status === 'cancelled');
  finishConversionUi();
  renderConversionQueue(null);

  if (unexpectedError) {
    showStatus('error', `Conversion failed: ${unexpectedError}`);
    elements.showInFolderBtn.classList.add('u-hidden');
    return;
  }

  const items = snapshot?.items ?? [];
  const successItems = items.filter((item) => item.status === 'done');
  const lastSuccess = [...successItems].reverse().find((item) => item.outputPath);
  if (lastSuccess?.outputPath) {
    lastOutputPath = lastSuccess.outputPath;
    syncConversionMenuState();
  }

  if (totalFiles === 1) {
    const uiStatus = conv2QueueUiStatus({ total: totalFiles, items }, { wasCancelled });
    const failed = items[0]?.status === 'failed' ? items[0] : undefined;
    showStatus(
      uiStatus.type,
      uiStatus.message,
      failed?.errorDetail
        ? {
            title: `Error details: ${failed.fileName}`,
            summary: failed.error,
            detail: failed.errorDetail,
          }
        : undefined
    );
    if (items[0]?.status === 'done') {
      elements.showInFolderBtn.classList.remove('u-hidden');
    } else {
      elements.showInFolderBtn.classList.add('u-hidden');
    }
    return;
  }

  const uiStatus = conv2QueueUiStatus({ total: totalFiles, items }, { wasCancelled });
  showStatus(uiStatus.type, uiStatus.message);
  if (successItems.length > 0) {
    elements.showInFolderBtn.classList.remove('u-hidden');
  } else {
    elements.showInFolderBtn.classList.add('u-hidden');
  }
};

/** After a renderer reload: pick up a batch the backend is still running. */
const rehydrateRunningBatch = async (): Promise<void> => {
  if (isConverting || conversionStarting) return;
  let attached = false;
  let sawEvent = false;
  let lastActive: QueueSnapshot | null = null;
  let unsubscribe: () => void = () => {};
  const apply = (next: QueueSnapshot): void => {
    if (!attached) {
      if (!next.active || isConverting || conversionStarting) return;
      attached = true;
      enterConvertingUi();
    }
    if (next.active) {
      lastActive = next;
      renderQueueSnapshotUi(next);
      return;
    }
    unsubscribe();
    attached = false;
    presentBatchOutcome(next, next.total, null);
  };
  // Wait for the listener to register so a batch ending during the lookup is not missed.
  unsubscribe = await listenConversionQueueUpdated((next) => {
    sawEvent = true;
    apply(next);
  });
  try {
    const current = await api.getQueueSnapshot();
    // Any live event is newer than this response, so it wins.
    if (current?.active && !sawEvent) apply(current);
    if (attached) {
      // Re-poll once: a batch that ended before attaching must still leave the converting UI.
      const latest = await api.getQueueSnapshot();
      if (attached && !latest?.active) {
        unsubscribe();
        attached = false;
        const final = latest ?? lastActive;
        presentBatchOutcome(final, final?.total ?? 0, null);
      }
    }
  } finally {
    if (!attached) unsubscribe();
  }
};

const runConversionWorkflow = async (inputPathsOverride?: string[]) => {
  if (isConverting || conversionStarting) {
    return;
  }

  conversionStarting = true;
  elements.convertBtn.disabled = true;

  try {
    // Never start on old settings: a stalled save must be retried, not skipped.
    if (!(await flushSettingsSaves(RESTART_FLUSH_TIMEOUT_MS))) {
      showStatus('warning', 'Still saving settings, try again');
      return;
    }

    if (isConverting) {
      return;
    }

    const filesToConvert =
      inputPathsOverride && inputPathsOverride.length > 0
        ? [...inputPathsOverride]
        : [...selectedFiles];

    if (filesToConvert.length === 0) return;

    const presetId = inputPathsOverride
      ? (lastQueueRunContext?.presetId ?? selectedPresetId)
      : selectedPresetId;
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
    if (inputPathsOverride && lastQueueRunContext) {
      resolvedGpuVendor = lastQueueRunContext.gpu;
    } else {
      try {
        const resolvedGpu = await resolvePreferredGpuVendor(preset);
        resolvedGpuVendor = resolvedGpu.gpu;
      } catch {
        resolvedGpuVendor = 'cpu';
      }
    }

    lastQueueRunContext = {
      presetId,
      gpu: resolvedGpuVendor,
      removeSpacesFromFilenames: settings.removeSpacesFromFilenames,
      outputDirectory: settings.outputDirectory,
      showDebugOutput: settings.showDebugOutput,
    };

    enterConvertingUi();
    const totalFiles = filesToConvert.length;
    let unexpectedError: string | null = null;
    let snapshot: QueueSnapshot | null = null;

    const unsubQueue = api.onConversionQueueUpdated((next) => {
      snapshot = next;
      renderQueueSnapshotUi(next);
    });

    try {
      snapshot = await api.startConversionQueue({
        inputPaths: filesToConvert,
        presetId: lastQueueRunContext.presetId,
        gpu: lastQueueRunContext.gpu,
        removeSpacesFromFilenames: lastQueueRunContext.removeSpacesFromFilenames,
        outputDirectory: lastQueueRunContext.outputDirectory,
        showDebugOutput: lastQueueRunContext.showDebugOutput,
      });
      renderConversionQueue(snapshot);
    } catch (err) {
      unexpectedError = err instanceof Error ? err.message : String(err);
    } finally {
      unsubQueue();
    }

    presentBatchOutcome(snapshot, totalFiles, unexpectedError);
  } finally {
    conversionStarting = false;
    syncConversionMenuState();
    if (!isConverting) {
      elements.convertBtn.disabled = !ffmpegInstalled || selectedFiles.length === 0;
    }
  }
};

const startConversion = (): void => {
  void runConversionWorkflow().catch((error) => {
    if (isConverting) {
      finishConversionUi();
    }
    showStatus(
      'error',
      `Conversion failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
    elements.convertBtn.disabled = !ffmpegInstalled || selectedFiles.length === 0;
  });
};

const cancelConversion = async () => {
  if (!isConverting) return;
  cancelRequested = true;
  try {
    await api.cancelConversion(true);
    showStatus('warning', 'Cancelling conversion...');
  } catch (err) {
    showStatus(
      'error',
      `Failed to cancel conversion: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

document.addEventListener('DOMContentLoaded', () => {
  void init()
    .catch((error: unknown) => {
      showStartupFailure(error);
    })
    .finally(() => resolveRendererStartupReady());
});
