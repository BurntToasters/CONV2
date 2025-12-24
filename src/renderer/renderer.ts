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

interface ModalOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmClass?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

let selectedFile: string | null = null;
let isConverting = false;
let settings: AppSettings;
let presets: Preset[] = [];

const elements = {
  dropZone: document.getElementById('dropZone') as HTMLDivElement,
  fileInput: document.getElementById('fileInput') as HTMLInputElement,
  browseBtn: document.getElementById('browseBtn') as HTMLButtonElement,
  fileInfo: document.getElementById('fileInfo') as HTMLDivElement,
  fileName: document.getElementById('fileName') as HTMLSpanElement,
  presetSelect: document.getElementById('presetSelect') as HTMLSelectElement,
  gpuSelect: document.getElementById('gpuSelect') as HTMLSelectElement,
  convertBtn: document.getElementById('convertBtn') as HTMLButtonElement,
  cancelBtn: document.getElementById('cancelBtn') as HTMLButtonElement,
  progressContainer: document.getElementById('progressContainer') as HTMLDivElement,
  progressFill: document.getElementById('progressFill') as HTMLDivElement,
  progressPercent: document.getElementById('progressPercent') as HTMLSpanElement,
  progressTime: document.getElementById('progressTime') as HTMLSpanElement,
  statusMessage: document.getElementById('statusMessage') as HTMLDivElement,
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

const init = async () => {
  await checkFFmpeg();
  await loadSettings();
  await loadPresets();
  await loadVersion();
  await applyTheme();
  setupEventListeners();
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
      handleFileSelect(files[0].path);
    }
  });

  elements.fileInput.addEventListener('change', () => {
    const files = elements.fileInput.files;
    if (files && files.length > 0) {
      handleFileSelect(files[0].path);
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
  });

  window.electronAPI.onConversionComplete((result) => {
    isConverting = false;
    elements.progressContainer.classList.remove('visible');
    elements.convertBtn.disabled = false;
    elements.cancelBtn.style.display = 'none';

    if (result.success) {
      showStatus('success', `Conversion complete! Click to open folder.`);
      elements.statusMessage.onclick = () => window.electronAPI.openPath(result.outputPath);
      elements.statusMessage.style.cursor = 'pointer';
    } else {
      showStatus('error', `Conversion failed: ${result.error}`);
      elements.statusMessage.style.cursor = 'default';
    }
  });
};

const handleFileSelect = (filePath: string) => {
  selectedFile = filePath;
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  elements.fileName.textContent = fileName;
  elements.fileInfo.classList.add('visible');
  elements.convertBtn.disabled = false;
  hideStatus();
};

const startConversion = async () => {
  if (!selectedFile) return;

  isConverting = true;
  elements.convertBtn.disabled = true;
  elements.cancelBtn.style.display = 'inline-flex';
  elements.progressContainer.classList.add('visible');
  elements.progressFill.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  elements.progressTime.textContent = '00:00:00';
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
