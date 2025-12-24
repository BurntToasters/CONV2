interface ElectronFile extends File {
  path: string;
}

interface Preset {
  id: string;
  name: string;
  description: string;
  category: string;
}

interface AppSettings {
  outputDirectory: string;
  gpu: 'nvidia' | 'amd' | 'intel' | 'cpu';
  theme: 'system' | 'dark' | 'light';
}

interface VideoInfo {
  duration: number;
  size: number;
  width: number;
  height: number;
  codec: string;
  format: string;
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

let selectedFile: string | null = null;
let selectedFileInfo: VideoInfo | null = null;
let isConverting = false;
let settings: AppSettings;
let presets: Preset[] = [];
let conversionStartTime = 0;
let lastOutputPath = '';

const elements = {
  dropZone: document.getElementById('dropZone') as HTMLDivElement,
  fileInput: document.getElementById('fileInput') as HTMLInputElement,
  browseBtn: document.getElementById('browseBtn') as HTMLButtonElement,
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
  settingsModal: document.getElementById('settingsModal') as HTMLDivElement,
  closeSettings: document.getElementById('closeSettings') as HTMLButtonElement,
  outputDirBtn: document.getElementById('outputDirBtn') as HTMLButtonElement,
  outputPath: document.getElementById('outputPath') as HTMLSpanElement,
  themeSelect: document.getElementById('themeSelect') as HTMLSelectElement,
  resetSettingsBtn: document.getElementById('resetSettingsBtn') as HTMLButtonElement,
  checkUpdateBtn: document.getElementById('checkUpdateBtn') as HTMLButtonElement,
  versionInfo: document.getElementById('versionInfo') as HTMLSpanElement,
  ffmpegWarning: document.getElementById('ffmpegWarning') as HTMLDivElement,
  dynamicModal: document.getElementById('dynamicModal') as HTMLDivElement,
  viewCreditsBtn: document.getElementById('viewCreditsBtn') as HTMLButtonElement,
  creditsModal: document.getElementById('creditsModal') as HTMLDivElement,
  closeCredits: document.getElementById('closeCredits') as HTMLButtonElement,
  licensesList: document.getElementById('licensesList') as HTMLDivElement,
};

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

  const cleanup = () => {
    modal.classList.remove('visible');
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
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

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      cleanup();
      options.onCancel?.();
    }
  }, { once: true });

  modal.classList.add('visible');
};

const buildLicenseEntries = (data: Record<string, LicenseCrawlerEntry> | null): LicenseDisplayEntry[] => {
  const entries: LicenseDisplayEntry[] = [
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
      const entryInfo = (typeof info === 'object' && info !== null)
        ? info as LicenseCrawlerEntry
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

  return [entries[0], ...packageEntries];
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
    const hasLicenses = !!data && typeof data === 'object' && Object.keys(data as Record<string, unknown>).length > 0;
    const entries = buildLicenseEntries(data as Record<string, LicenseCrawlerEntry> | null);
    renderLicenses(entries);

    if (!hasLicenses) {
      const warning = document.createElement('div');
      warning.className = 'license-item license-error';
      warning.textContent = 'licenses.json is missing or empty. Run "npm run licenses" before packaging to include dependency credits.';
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
  await checkFFmpeg();
  await loadSettings();
  await loadPresets();
  await loadVersion();
  await applyTheme();
  setupEventListeners();
  setupKeyboardShortcuts();
};

const checkFFmpeg = async () => {
  const installed = await window.electronAPI.checkFFmpeg();
  if (!installed) {
    elements.ffmpegWarning.style.display = 'block';
    elements.convertBtn.disabled = true;
  }
};

const loadSettings = async () => {
  settings = await window.electronAPI.getSettings();
  elements.gpuSelect.value = settings.gpu;
  elements.themeSelect.value = settings.theme;
  if (settings.outputDirectory) {
    elements.outputPath.textContent = settings.outputDirectory;
  } else {
    elements.outputPath.textContent = 'Same as input file';
  }
};

const loadPresets = async () => {
  presets = await window.electronAPI.getPresets();
  elements.presetSelect.innerHTML = '';

  const categories = ['av1', 'h264', 'h265', 'remux', 'audio'];
  const categoryNames: Record<string, string> = {
    av1: 'AV1',
    h264: 'H.264',
    h265: 'H.265/HEVC',
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
  elements.versionInfo.textContent = `CONV2 v${version}`;
};

const applyTheme = async () => {
  if (settings.theme === 'system') {
    const systemTheme = await window.electronAPI.getSystemTheme();
    document.documentElement.setAttribute('data-theme', systemTheme);
  } else {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }

  window.electronAPI.onThemeChange((theme) => {
    if (settings.theme === 'system') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  });
};

const setupKeyboardShortcuts = () => {
  document.addEventListener('keydown', (e) => {
    // Escape - close modals
    if (e.key === 'Escape') {
      if (elements.settingsModal.classList.contains('visible')) {
        elements.settingsModal.classList.remove('visible');
      }
      if (elements.dynamicModal.classList.contains('visible')) {
        elements.dynamicModal.classList.remove('visible');
      }
      if (elements.creditsModal.classList.contains('visible')) {
        closeCreditsModal();
      }
    }

    // Ctrl/Cmd + O - open file
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      elements.fileInput.click();
    }

    // Enter - start conversion (when file selected and not converting)
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const isModalOpen = elements.settingsModal.classList.contains('visible') ||
                          elements.dynamicModal.classList.contains('visible') ||
                          elements.creditsModal.classList.contains('visible');
      if (!isModalOpen && selectedFile && !isConverting && !elements.convertBtn.disabled) {
        startConversion();
      }
    }
  });
};

const setupEventListeners = () => {
  elements.dropZone.addEventListener('click', () => elements.fileInput.click());
  elements.browseBtn.addEventListener('click', (e) => {
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
      handleFileSelect((files[0] as ElectronFile).path);
    }
  });

  elements.fileInput.addEventListener('change', () => {
    const files = elements.fileInput.files;
    if (files && files.length > 0) {
      handleFileSelect((files[0] as ElectronFile).path);
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
  });

  elements.convertBtn.addEventListener('click', startConversion);
  elements.cancelBtn.addEventListener('click', cancelConversion);

  elements.showInFolderBtn?.addEventListener('click', () => {
    if (lastOutputPath) {
      window.electronAPI.openPath(lastOutputPath);
    }
  });

  elements.settingsBtn.addEventListener('click', () => {
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
    window.electronAPI.checkForUpdates();
    elements.checkUpdateBtn.textContent = 'Checking...';
    elements.checkUpdateBtn.disabled = true;
    setTimeout(() => {
      elements.checkUpdateBtn.textContent = 'Check for Updates';
      elements.checkUpdateBtn.disabled = false;
    }, 5000);
  });

  window.electronAPI.onConversionProgress((progress) => {
    elements.progressFill.style.width = `${progress.percent}%`;
    elements.progressPercent.textContent = `${progress.percent.toFixed(1)}%`;
    elements.progressTime.textContent = progress.time;

    // Calculate ETA
    if (progress.percent > 0 && conversionStartTime > 0) {
      const elapsed = (Date.now() - conversionStartTime) / 1000;
      const estimatedTotal = elapsed / (progress.percent / 100);
      const remaining = estimatedTotal - elapsed;
      if (remaining > 0 && remaining < 86400) {
        elements.progressEta.textContent = `ETA: ${formatDuration(remaining)}`;
      }
    }

    // Show speed
    if (progress.fps > 0) {
      elements.progressSpeed.textContent = `${progress.fps.toFixed(1)} fps`;
    } else if (progress.speed !== 'N/A') {
      elements.progressSpeed.textContent = progress.speed;
    }
  });

  window.electronAPI.onConversionComplete((result) => {
    isConverting = false;
    elements.progressContainer.classList.remove('visible');
    elements.convertBtn.disabled = false;
    elements.cancelBtn.style.display = 'none';

    if (result.success) {
      lastOutputPath = result.outputPath;
      showStatus('success', 'Conversion complete!');
      elements.showInFolderBtn.style.display = 'inline-flex';
    } else {
      showStatus('error', `Conversion failed: ${result.error}`);
      elements.showInFolderBtn.style.display = 'none';
    }
  });
};

const handleFileSelect = async (filePath: string) => {
  selectedFile = filePath;
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  elements.fileName.textContent = fileName;

  // Get file info
  const info = await window.electronAPI.getFileInfo(filePath);
  if (info) {
    selectedFileInfo = info;
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
    elements.fileDetails.textContent = details.join(' • ');
  } else {
    elements.fileDetails.textContent = '';
  }

  elements.fileInfo.classList.add('visible');
  elements.convertBtn.disabled = false;
  elements.showInFolderBtn.style.display = 'none';
  hideStatus();
};

const startConversion = async () => {
  if (!selectedFile) return;

  isConverting = true;
  conversionStartTime = Date.now();
  elements.convertBtn.disabled = true;
  elements.cancelBtn.style.display = 'inline-flex';
  elements.progressContainer.classList.add('visible');
  elements.progressFill.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  elements.progressTime.textContent = '00:00:00';
  elements.progressEta.textContent = '';
  elements.progressSpeed.textContent = '';
  elements.showInFolderBtn.style.display = 'none';
  hideStatus();

  const presetId = elements.presetSelect.value;
  await window.electronAPI.startConversion(selectedFile, presetId);
};

const cancelConversion = async () => {
  await window.electronAPI.cancelConversion();
  isConverting = false;
  elements.progressContainer.classList.remove('visible');
  elements.convertBtn.disabled = false;
  elements.cancelBtn.style.display = 'none';
  showStatus('warning', 'Conversion cancelled');
};

const showStatus = (type: 'success' | 'error' | 'warning', message: string) => {
  elements.statusMessage.className = `status-message visible ${type}`;
  elements.statusMessage.textContent = message;
};

const hideStatus = () => {
  elements.statusMessage.classList.remove('visible');
};

document.addEventListener('DOMContentLoaded', init);
