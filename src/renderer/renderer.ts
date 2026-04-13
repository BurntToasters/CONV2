interface Preset {
  id: string;
  name: string;
  description: string;
  category: string;
}

type GifLoopMode = 'forever' | 'once';
type GifDither = 'sierra2_4a' | 'floyd_steinberg' | 'bayer' | 'none';
type GifTierKey = 'bestQuality' | 'quality' | 'balanced' | 'bestCompression';

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

interface AdvancedFormatSettings {
  gif: GifAdvancedSettings;
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

const GIF_DITHER_VALUES: ReadonlySet<GifDither> = new Set([
  'sierra2_4a',
  'floyd_steinberg',
  'bayer',
  'none',
]);

const createDefaultGifAdvancedSettings = (): GifAdvancedSettings => ({
  loopMode: 'forever',
  tiers: {
    bestQuality: {
      fps: 15,
      maxDimension: 1080,
      maxColors: 256,
      dither: 'sierra2_4a',
    },
    quality: {
      fps: 12,
      maxDimension: 900,
      maxColors: 224,
      dither: 'sierra2_4a',
    },
    balanced: {
      fps: 10,
      maxDimension: 720,
      maxColors: 192,
      dither: 'bayer',
    },
    bestCompression: {
      fps: 8,
      maxDimension: 540,
      maxColors: 128,
      dither: 'none',
    },
  },
});

const createDefaultAdvancedFormatSettings = (): AdvancedFormatSettings => ({
  gif: createDefaultGifAdvancedSettings(),
});

const clampInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
};

const normalizeGifDither = (value: unknown, fallback: GifDither): GifDither => {
  if (typeof value !== 'string') {
    return fallback;
  }
  return GIF_DITHER_VALUES.has(value as GifDither) ? (value as GifDither) : fallback;
};

const normalizeGifTierSettings = (
  value: Partial<Record<keyof GifTierSettings, unknown>> | undefined,
  fallback: GifTierSettings
): GifTierSettings => {
  const tier = value || {};
  return {
    fps: clampInteger(tier.fps, 1, 60, fallback.fps),
    maxDimension: clampInteger(tier.maxDimension, 160, 2160, fallback.maxDimension),
    maxColors: clampInteger(tier.maxColors, 2, 256, fallback.maxColors),
    dither: normalizeGifDither(tier.dither, fallback.dither),
  };
};

const normalizeGifAdvancedSettings = (value: unknown): GifAdvancedSettings => {
  const defaults = createDefaultGifAdvancedSettings();
  const incoming = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const incomingTiers =
    incoming.tiers && typeof incoming.tiers === 'object'
      ? (incoming.tiers as Record<string, unknown>)
      : {};

  return {
    loopMode: incoming.loopMode === 'once' ? 'once' : 'forever',
    tiers: {
      bestQuality: normalizeGifTierSettings(
        incomingTiers.bestQuality as Partial<Record<keyof GifTierSettings, unknown>> | undefined,
        defaults.tiers.bestQuality
      ),
      quality: normalizeGifTierSettings(
        incomingTiers.quality as Partial<Record<keyof GifTierSettings, unknown>> | undefined,
        defaults.tiers.quality
      ),
      balanced: normalizeGifTierSettings(
        incomingTiers.balanced as Partial<Record<keyof GifTierSettings, unknown>> | undefined,
        defaults.tiers.balanced
      ),
      bestCompression: normalizeGifTierSettings(
        incomingTiers.bestCompression as
          | Partial<Record<keyof GifTierSettings, unknown>>
          | undefined,
        defaults.tiers.bestCompression
      ),
    },
  };
};

const normalizeAdvancedFormatSettings = (value: unknown): AdvancedFormatSettings => {
  const incoming = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    gif: normalizeGifAdvancedSettings(incoming.gif),
  };
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
  settingsGeneralTab: document.getElementById('settingsGeneralTab') as HTMLButtonElement,
  settingsAdvancedFormatsTab: document.getElementById(
    'settingsAdvancedFormatsTab'
  ) as HTMLButtonElement,
  settingsGeneralPanel: document.getElementById('settingsGeneralPanel') as HTMLDivElement,
  settingsAdvancedFormatsPanel: document.getElementById(
    'settingsAdvancedFormatsPanel'
  ) as HTMLDivElement,
  formatTabGif: document.getElementById('formatTabGif') as HTMLButtonElement,
  formatPanelGif: document.getElementById('formatPanelGif') as HTMLDivElement,
  resetGifDefaultsBtn: document.getElementById('resetGifDefaultsBtn') as HTMLButtonElement,
  gifLoopModeSelect: document.getElementById('gifLoopModeSelect') as HTMLSelectElement,
  gifBestQualityFps: document.getElementById('gifBestQualityFps') as HTMLInputElement,
  gifBestQualityMaxDimension: document.getElementById(
    'gifBestQualityMaxDimension'
  ) as HTMLInputElement,
  gifBestQualityMaxColors: document.getElementById('gifBestQualityMaxColors') as HTMLInputElement,
  gifBestQualityDither: document.getElementById('gifBestQualityDither') as HTMLSelectElement,
  gifQualityFps: document.getElementById('gifQualityFps') as HTMLInputElement,
  gifQualityMaxDimension: document.getElementById('gifQualityMaxDimension') as HTMLInputElement,
  gifQualityMaxColors: document.getElementById('gifQualityMaxColors') as HTMLInputElement,
  gifQualityDither: document.getElementById('gifQualityDither') as HTMLSelectElement,
  gifBalancedFps: document.getElementById('gifBalancedFps') as HTMLInputElement,
  gifBalancedMaxDimension: document.getElementById('gifBalancedMaxDimension') as HTMLInputElement,
  gifBalancedMaxColors: document.getElementById('gifBalancedMaxColors') as HTMLInputElement,
  gifBalancedDither: document.getElementById('gifBalancedDither') as HTMLSelectElement,
  gifBestCompressionFps: document.getElementById('gifBestCompressionFps') as HTMLInputElement,
  gifBestCompressionMaxDimension: document.getElementById(
    'gifBestCompressionMaxDimension'
  ) as HTMLInputElement,
  gifBestCompressionMaxColors: document.getElementById(
    'gifBestCompressionMaxColors'
  ) as HTMLInputElement,
  gifBestCompressionDither: document.getElementById(
    'gifBestCompressionDither'
  ) as HTMLSelectElement,
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

const settingsTabButtons = [elements.settingsGeneralTab, elements.settingsAdvancedFormatsTab];
const settingsPanels = [elements.settingsGeneralPanel, elements.settingsAdvancedFormatsPanel];

const formatTabs = [elements.formatTabGif];
const formatPanels = [elements.formatPanelGif];

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
  });
};

const setFormatPanel = (panelId: 'formatPanelGif'): void => {
  formatPanels.forEach((panel) => {
    const isActive = panel.id === panelId;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  });

  formatTabs.forEach((tab) => {
    const isActive = tab.dataset.formatPanel === panelId;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
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

const readGifControls = (): GifAdvancedSettings => {
  return normalizeGifAdvancedSettings({
    loopMode: elements.gifLoopModeSelect.value,
    tiers: {
      bestQuality: {
        fps: elements.gifBestQualityFps.value,
        maxDimension: elements.gifBestQualityMaxDimension.value,
        maxColors: elements.gifBestQualityMaxColors.value,
        dither: elements.gifBestQualityDither.value,
      },
      quality: {
        fps: elements.gifQualityFps.value,
        maxDimension: elements.gifQualityMaxDimension.value,
        maxColors: elements.gifQualityMaxColors.value,
        dither: elements.gifQualityDither.value,
      },
      balanced: {
        fps: elements.gifBalancedFps.value,
        maxDimension: elements.gifBalancedMaxDimension.value,
        maxColors: elements.gifBalancedMaxColors.value,
        dither: elements.gifBalancedDither.value,
      },
      bestCompression: {
        fps: elements.gifBestCompressionFps.value,
        maxDimension: elements.gifBestCompressionMaxDimension.value,
        maxColors: elements.gifBestCompressionMaxColors.value,
        dither: elements.gifBestCompressionDither.value,
      },
    },
  });
};

const saveGifSettingsFromControls = async (): Promise<void> => {
  const nextGifSettings = readGifControls();
  settings.advancedFormatSettings = normalizeAdvancedFormatSettings({
    ...settings.advancedFormatSettings,
    gif: nextGifSettings,
  });
  setGifControlValues(settings.advancedFormatSettings.gif);
  await window.electronAPI.saveSettings({
    advancedFormatSettings: {
      gif: settings.advancedFormatSettings.gif,
    },
  });
};

const resetGifSettingsToDefaults = async (): Promise<void> => {
  settings.advancedFormatSettings = normalizeAdvancedFormatSettings({
    ...settings.advancedFormatSettings,
    gif: createDefaultGifAdvancedSettings(),
  });
  setGifControlValues(settings.advancedFormatSettings.gif);
  await window.electronAPI.saveSettings({
    advancedFormatSettings: {
      gif: settings.advancedFormatSettings.gif,
    },
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
  elements.settingsModal.classList.remove('visible');
  elements.creditsModal.classList.add('visible');
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
  settings.advancedFormatSettings = normalizeAdvancedFormatSettings(
    settings.advancedFormatSettings
  );
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
  setGifControlValues(settings.advancedFormatSettings.gif);

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

  const advancedCategories = ['avi', 'gif'];
  const categories = ['av1', 'h264', 'h265', 'avi', 'gif', 'remux', 'audio'].filter(
    (cat) => settings.showAdvancedPresets || !advancedCategories.includes(cat)
  );
  const categoryNames: Record<string, string> = {
    av1: 'AV1',
    h264: 'H.264',
    h265: 'H.265/HEVC',
    avi: 'AVI',
    gif: 'GIF',
    remux: 'Remux',
    audio: 'Audio',
  };

  categories.forEach((cat) => {
    const catPresets = presets.filter((p) => p.category === cat);
    if (catPresets.length > 0) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = categoryNames[cat];
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
    if (e.key === 'Escape') {
      if (elements.settingsModal.classList.contains('visible')) {
        elements.settingsModal.classList.remove('visible');
      }
      if (elements.dynamicModal.classList.contains('visible')) {
        if (closeDynamicModal) {
          closeDynamicModal();
        } else {
          elements.dynamicModal.classList.remove('visible');
        }
      }
      if (elements.creditsModal.classList.contains('visible')) {
        closeCreditsModal();
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      elements.fileInput.click();
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
  });

  formatTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.formatPanel;
      if (panelId === 'formatPanelGif') {
        setFormatPanel(panelId);
      }
    });
  });

  elements.gifLoopModeSelect.addEventListener('change', async () => {
    await saveGifSettingsFromControls();
  });

  (Object.keys(gifTierInputs) as GifTierKey[]).forEach((tier) => {
    const tierInputs = gifTierInputs[tier];
    tierInputs.fps.addEventListener('change', async () => {
      await saveGifSettingsFromControls();
    });
    tierInputs.maxDimension.addEventListener('change', async () => {
      await saveGifSettingsFromControls();
    });
    tierInputs.maxColors.addEventListener('change', async () => {
      await saveGifSettingsFromControls();
    });
    tierInputs.dither.addEventListener('change', async () => {
      await saveGifSettingsFromControls();
    });
  });

  elements.resetGifDefaultsBtn.addEventListener('click', async () => {
    await resetGifSettingsToDefaults();
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
    elements.settingsModal.classList.add('visible');
  });

  elements.closeSettings.addEventListener('click', () => {
    elements.settingsModal.classList.remove('visible');
  });

  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) {
      elements.settingsModal.classList.remove('visible');
    }
  });

  elements.showLogsBtn.addEventListener('click', () => {
    elements.logsModal.classList.add('visible');
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
    elements.logsContent.textContent = '';
  });

  elements.copyLogsBtn.addEventListener('click', () => {
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
    elements.progressFill.style.width = `${progress.percent}%`;
    elements.progressPercent.textContent = `${Math.floor(progress.percent)}%`;
    elements.progressTime.textContent = progress.time;

    if (progress.percent > 0 && conversionStartTime > 0) {
      const elapsed = (Date.now() - conversionStartTime) / 1000;
      const estimatedTotal = elapsed / (progress.percent / 100);
      const remaining = estimatedTotal - elapsed;
      if (remaining > 0 && remaining < 86400) {
        elements.progressEta.textContent = `ETA: ${formatDuration(remaining)}`;
      }
    }

    if (progress.fps > 0) {
      elements.progressSpeed.textContent = `${progress.fps.toFixed(1)} fps`;
    } else if (progress.speed !== 'N/A') {
      elements.progressSpeed.textContent = progress.speed;
    }
  });

  window.electronAPI.onConversionLog((message) => {
    elements.logsContent.textContent += message;
    elements.logsContent.scrollTop = elements.logsContent.scrollHeight;
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
    elements.logsContent.textContent += `\n=== [${fileIndex + 1}/${totalFiles}] ${fileName} ===\n`;
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
