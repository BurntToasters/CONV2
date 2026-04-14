interface Preset {
  id: string;
  name: string;
  description: string;
  category: string;
  categoryLabel: string;
  categoryOrder: number;
  isAdvanced: boolean;
}

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

interface AppSettings {
  outputDirectory: string;
  gpu: 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
  theme: 'system' | 'dark' | 'light';
  showDebugOutput: boolean;
  autoCheckUpdates: boolean;
  useSystemFFmpeg: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  showAdvancedPresets: boolean;
  removeSpacesFromFilenames: boolean;
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
}

interface BatchConversionOptions {
  gpu: AppSettings['gpu'];
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
  gpu?: 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
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
  presetSelect: document.getElementById('presetSelect') as HTMLSelectElement,
  gpuSelect: document.getElementById('gpuSelect') as HTMLSelectElement,
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
  settingsGeneralPanel: getRequiredElement<HTMLDivElement>('settingsGeneralPanel'),
  settingsAdvancedFormatsPanel: getRequiredElement<HTMLDivElement>('settingsAdvancedFormatsPanel'),
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
  showLogsBtn: document.getElementById('showLogsBtn') as HTMLButtonElement,
  logsModal: document.getElementById('logsModal') as HTMLDivElement,
  closeLogs: document.getElementById('closeLogs') as HTMLButtonElement,
  logsContent: document.getElementById('logsContent') as HTMLPreElement,
  clearLogsBtn: document.getElementById('clearLogsBtn') as HTMLButtonElement,
  copyLogsBtn: document.getElementById('copyLogsBtn') as HTMLButtonElement,
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

const settingsTabButtons = [elements.settingsGeneralTab, elements.settingsAdvancedFormatsTab];
const settingsPanels = [elements.settingsGeneralPanel, elements.settingsAdvancedFormatsPanel];

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
  panelId: 'settingsGeneralPanel' | 'settingsAdvancedFormatsPanel'
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
    settings = await window.electronAPI.getSettings();
    setAdvancedFormatControlValues(settings.advancedFormatSettings);
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

const flushLogBuffer = (): void => {
  if (pendingLogBuffer.length === 0) {
    return;
  }
  elements.logsContent.textContent += pendingLogBuffer;
  pendingLogBuffer = '';
  elements.logsContent.scrollTop = elements.logsContent.scrollHeight;
};

const appendLogMessage = (message: string): void => {
  if (!message) {
    return;
  }
  pendingLogBuffer += message;
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
    flushPendingAdvancedSettingsSave();
    elements.settingsModal.classList.remove('visible');
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

const init = async () => {
  convertBtnOriginalHTML = elements.convertBtn.innerHTML;
  checkUpdateDefaultHTML = elements.checkUpdateBtn.innerHTML;
  await checkFFmpeg();
  await checkPlatform();
  await loadSettings();
  await loadPresets();
  await loadVersion();
  await applyTheme();
  await applyUpdateVisibility();
  setupEventListeners();
  setupKeyboardShortcuts();
};

const checkPlatform = async () => {
  const platform = await window.electronAPI.getPlatform();
  if (platform === 'darwin') {
    const appleOption =
      elements.gpuSelect.querySelector<HTMLOptionElement>('option[value="apple"]');
    if (appleOption) {
      appleOption.hidden = false;
    }
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
  elements.gpuSelect.value = settings.gpu;
  elements.themeSelect.value = settings.theme;
  elements.debugOutputCheck.checked = settings.showDebugOutput;
  elements.advancedPresetsCheck.checked = settings.showAdvancedPresets;
  elements.removeSpacesCheck.checked = settings.removeSpacesFromFilenames;
  elements.autoCheckUpdatesCheck.checked = settings.autoCheckUpdates;
  elements.useSystemFFmpegCheck.checked = settings.useSystemFFmpeg;
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
  } else {
    elements.outputPath.textContent = 'Same as input file';
  }
};

const loadPresets = async () => {
  presets = await window.electronAPI.getPresets();
  elements.presetSelect.innerHTML = '';

  const categories = Array.from(
    presets
      .reduce((acc, preset) => {
        if (!acc.has(preset.category)) {
          acc.set(preset.category, {
            category: preset.category,
            label: preset.categoryLabel || preset.category,
            order: Number.isFinite(preset.categoryOrder) ? preset.categoryOrder : 999,
            isAdvanced: preset.isAdvanced === true,
          });
        }
        return acc;
      }, new Map<string, { category: string; label: string; order: number; isAdvanced: boolean }>())
      .values()
  )
    .sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.label.localeCompare(b.label);
    })
    .filter((entry) => settings.showAdvancedPresets || !entry.isAdvanced);

  categories.forEach((entry) => {
    const catPresets = presets.filter((p) => p.category === entry.category);
    if (catPresets.length > 0) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = entry.label;
      catPresets.forEach((preset) => {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        option.title = preset.description;
        optgroup.appendChild(option);
      });
      elements.presetSelect.appendChild(optgroup);
    }
  });
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
        flushPendingAdvancedSettingsSave();
        elements.settingsModal.classList.remove('visible');
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
      elements.fileInput.click();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === ',' || e.code === 'Comma')) {
      e.preventDefault();
      const hasBlockingModal =
        elements.dynamicModal.classList.contains('visible') ||
        elements.logsModal.classList.contains('visible') ||
        elements.creditsModal.classList.contains('visible');
      if (!hasBlockingModal) {
        setSettingsPanel('settingsGeneralPanel');
        setAdvancedFormatControlValues(settings.advancedFormatSettings);
        elements.settingsModal.classList.add('visible');
        focusFirstInteractiveElement(elements.settingsModal);
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
      if (panelId === 'settingsGeneralPanel' || panelId === 'settingsAdvancedFormatsPanel') {
        setSettingsPanel(panelId);
      }
    });
    tab.addEventListener('keydown', (event) => {
      handleTabKeyboardNavigation(event, settingsTabButtons, (nextTab) => {
        const panelId = nextTab.dataset.settingsPanel;
        if (panelId === 'settingsGeneralPanel' || panelId === 'settingsAdvancedFormatsPanel') {
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
  });

  elements.gpuSelect.addEventListener('change', async () => {
    settings.gpu = elements.gpuSelect.value as AppSettings['gpu'];
    await window.electronAPI.saveSettings({ gpu: settings.gpu });
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
    await checkFFmpeg();
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
    setSettingsPanel('settingsGeneralPanel');
    setAdvancedFormatControlValues(settings.advancedFormatSettings);
    elements.settingsModal.classList.add('visible');
    focusFirstInteractiveElement(elements.settingsModal);
  });

  elements.closeSettings.addEventListener('click', () => {
    flushPendingAdvancedSettingsSave();
    elements.settingsModal.classList.remove('visible');
  });

  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) {
      flushPendingAdvancedSettingsSave();
      elements.settingsModal.classList.remove('visible');
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
      await window.electronAPI.saveSettings({ outputDirectory: dir });
    }
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
    showGPUErrorModal(error);
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

const showGPUErrorModal = (error: GPUEncoderError): void => {
  const modal = elements.dynamicModal;
  const titleEl = modal.querySelector('.modal-header h2') as HTMLElement;
  const bodyEl = modal.querySelector('.modal-body p') as HTMLElement;
  const confirmBtn = modal.querySelector('#modalConfirm') as HTMLButtonElement;
  const cancelBtn = modal.querySelector('#modalCancel') as HTMLButtonElement;

  titleEl.textContent = 'GPU Encoding Error';
  bodyEl.textContent = '';
  const messageEl = document.createElement('strong');
  messageEl.style.color = 'var(--error)';
  messageEl.textContent = error.message;

  const detailsEl = document.createElement('div');
  detailsEl.style.marginTop = '12px';
  detailsEl.style.whiteSpace = 'pre-line';
  detailsEl.style.opacity = '0.85';
  detailsEl.style.fontSize = '0.9em';
  detailsEl.textContent = error.details;

  const suggestionEl = document.createElement('div');
  suggestionEl.style.marginTop = '12px';
  suggestionEl.style.padding = '8px 12px';
  suggestionEl.style.background = 'var(--bg-tertiary)';
  suggestionEl.style.borderRadius = '6px';
  suggestionEl.style.fontSize = '0.9em';

  const suggestionLabel = document.createElement('strong');
  suggestionLabel.textContent = 'Suggestion: ';
  suggestionEl.append(suggestionLabel, document.createTextNode(error.suggestion));

  bodyEl.append(messageEl, detailsEl, suggestionEl);

  if (error.canRetryWithCPU) {
    confirmBtn.textContent = 'Retry with CPU';
    cancelBtn.textContent = 'Cancel';
    confirmBtn.className = 'btn btn-sm btn-primary';
  } else {
    confirmBtn.textContent = 'OK';
    cancelBtn.style.display = 'none';
    confirmBtn.className = 'btn btn-sm btn-primary';
  }

  const overlayListener = (e: Event) => {
    if (e.target === modal) {
      closeByEscape();
    }
  };

  const cleanup = () => {
    modal.classList.remove('visible');
    modal.removeEventListener('click', overlayListener);
    cancelBtn.style.display = '';
    bodyEl.textContent = '';
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    if (closeDynamicModal === closeByEscape) {
      closeDynamicModal = null;
    }
  };

  const closeByEscape = () => {
    cleanup();
    showStatus('error', error.message);
  };

  const newConfirmBtn = modal.querySelector('#modalConfirm') as HTMLButtonElement;
  const newCancelBtn = modal.querySelector('#modalCancel') as HTMLButtonElement;

  newConfirmBtn.addEventListener('click', async () => {
    cleanup();
    if (error.canRetryWithCPU) {
      settings.gpu = 'cpu';
      elements.gpuSelect.value = 'cpu';
      await window.electronAPI.saveSettings({ gpu: 'cpu' });
      showStatus('warning', 'Switched to CPU encoding. Start conversion again to retry.');
    }
  });

  newCancelBtn.addEventListener('click', () => {
    cleanup();
    showStatus('error', error.message);
  });

  modal.addEventListener('click', overlayListener);
  modal.classList.add('visible');
  focusFirstInteractiveElement(modal);
  closeDynamicModal = closeByEscape;
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

const runSingleConversion = async (
  inputPath: string,
  presetId: string,
  fileIndex: number,
  totalFiles: number,
  batchOptions: BatchConversionOptions
): Promise<ConversionResult> => {
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

  return window.electronAPI.startConversion(inputPath, presetId, batchOptions.gpu, {
    suppressGpuErrorEvent: totalFiles > 1,
    removeSpacesFromFilenames: batchOptions.removeSpacesFromFilenames,
    outputDirectory: batchOptions.outputDirectory,
    showDebugOutput: batchOptions.showDebugOutput,
  });
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
  if (selectedFiles.length === 0) return;

  const presetId = elements.presetSelect.value;
  if (!presetId) {
    showStatus('error', 'Select a conversion preset first');
    return;
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
    gpu: settings.gpu,
    removeSpacesFromFilenames: settings.removeSpacesFromFilenames,
    outputDirectory: settings.outputDirectory,
    showDebugOutput: settings.showDebugOutput,
  };

  const filesToConvert = [...selectedFiles];
  const totalFiles = filesToConvert.length;
  const results: Array<ConversionResult & { inputPath: string }> = [];
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
        batchOptions
      );
      results.push({ inputPath, ...result });

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
    if (result?.success) {
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

  if (wasCancelled) {
    showStatus('warning', `Batch cancelled. ${successCount}/${totalFiles} converted.`);
  } else if (failedCount === 0) {
    showStatus('success', `Batch complete. ${successCount}/${totalFiles} converted.`);
  } else if (successCount === 0) {
    showStatus('error', `Batch failed. 0/${totalFiles} converted.`);
  } else {
    showStatus('warning', `Batch complete with errors. ${successCount}/${totalFiles} converted.`);
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
