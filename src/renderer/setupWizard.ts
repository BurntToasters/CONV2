export const SETUP_WIZARD_STEP_COUNT = 8;

type GPUMode = 'auto' | 'manual';
type ThemePreference = 'system' | 'dark' | 'light' | 'custom';

export interface SetupWizardSettingsSlice {
  theme: ThemePreference;
  interfaceStyle: 'glass' | 'flat';
  outputDirectory: string;
  gpuMode: GPUMode;
  notifyOnConversionComplete: boolean;
  preventSleepWhileConverting: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  setupWizardCompleted: boolean;
}

export interface SetupWizardDeps {
  getSettings: () => SetupWizardSettingsSlice;
  patchSettings: (partial: Partial<SetupWizardSettingsSlice>) => void;
  saveSettings: (partial: Partial<SetupWizardSettingsSlice>) => Promise<void>;
  applyTheme: () => Promise<void>;
  applyGpuModeUi: () => void;
  persistGpuMode: (mode: GPUMode) => Promise<void>;
  selectOutputDirectory: () => Promise<string | undefined>;
  openHelp: () => void;
  focusFirstIn: (container: HTMLElement) => void;
  isFfmpegInstalled: () => boolean;
}

let deps: SetupWizardDeps | null = null;
let currentStep = 0;
let returnFocus: HTMLElement | null = null;

let overlay: HTMLDivElement | null = null;
let stepLabel: HTMLSpanElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;
let skipBtn: HTMLButtonElement | null = null;
let outputPathEl: HTMLSpanElement | null = null;

const getStepPanels = (): HTMLElement[] => {
  if (!overlay) {
    return [];
  }
  return Array.from(overlay.querySelectorAll<HTMLElement>('[data-wizard-step]'));
};

const syncWizardControlsFromSettings = (): void => {
  if (!deps || !overlay) {
    return;
  }
  const settings = deps.getSettings();

  overlay.querySelectorAll<HTMLButtonElement>('.wizard-theme-option').forEach((btn) => {
    const theme = btn.dataset.theme as ThemePreference | undefined;
    btn.classList.toggle('active', theme === settings.theme);
  });

  overlay.querySelectorAll<HTMLButtonElement>('.wizard-style-option').forEach((btn) => {
    const style = btn.dataset.style;
    btn.classList.toggle('active', style === settings.interfaceStyle);
  });

  const gpuAuto = overlay.querySelector<HTMLInputElement>('#wizardGpuModeAuto');
  const gpuManual = overlay.querySelector<HTMLInputElement>('#wizardGpuModeManual');
  if (gpuAuto && gpuManual) {
    gpuAuto.checked = settings.gpuMode !== 'manual';
    gpuManual.checked = settings.gpuMode === 'manual';
  }

  const notifyCheck = overlay.querySelector<HTMLInputElement>('#wizardNotifyCheck');
  const sleepCheck = overlay.querySelector<HTMLInputElement>('#wizardPreventSleepCheck');
  if (notifyCheck) {
    notifyCheck.checked = settings.notifyOnConversionComplete !== false;
  }
  if (sleepCheck) {
    sleepCheck.checked = settings.preventSleepWhileConverting;
  }

  const channelSelect = overlay.querySelector<HTMLSelectElement>('#wizardUpdateChannelSelect');
  if (channelSelect) {
    channelSelect.value = settings.updateChannel;
  }

  if (outputPathEl) {
    outputPathEl.textContent = settings.outputDirectory
      ? settings.outputDirectory
      : 'Same as input file';
  }

  const ffmpegNote = overlay.querySelector<HTMLElement>('#wizardFfmpegNote');
  if (ffmpegNote) {
    ffmpegNote.hidden = deps.isFfmpegInstalled();
  }
};

const updateStepUi = (): void => {
  if (!overlay || !stepLabel || !backBtn || !nextBtn) {
    return;
  }

  const panels = getStepPanels();
  panels.forEach((panel) => {
    const step = Number(panel.dataset.wizardStep);
    panel.hidden = step !== currentStep;
  });

  stepLabel.textContent = `Step ${currentStep + 1} of ${SETUP_WIZARD_STEP_COUNT}`;
  backBtn.disabled = currentStep === 0;
  const isLast = currentStep === SETUP_WIZARD_STEP_COUNT - 1;
  nextBtn.textContent = isLast ? 'Get started' : 'Next';
  nextBtn.classList.toggle('btn-primary', true);
  syncWizardControlsFromSettings();
};

const closeWizard = (): void => {
  if (!overlay) {
    return;
  }
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
  if (returnFocus && typeof returnFocus.focus === 'function') {
    returnFocus.focus();
  }
  returnFocus = null;
};

const completeWizard = async (): Promise<void> => {
  if (!deps) {
    closeWizard();
    return;
  }
  deps.patchSettings({ setupWizardCompleted: true });
  try {
    await deps.saveSettings({ setupWizardCompleted: true });
  } catch {
    // still close; flag may retry on next launch
  }
  closeWizard();
};

const persistStepPreferences = async (): Promise<void> => {
  if (!deps || !overlay) {
    return;
  }
  const settings = deps.getSettings();
  const partial: Partial<SetupWizardSettingsSlice> = {};

  if (currentStep === 1) {
    partial.theme = settings.theme;
    partial.interfaceStyle = settings.interfaceStyle;
  } else if (currentStep === 2) {
    partial.outputDirectory = settings.outputDirectory;
  } else if (currentStep === 3) {
    await deps.persistGpuMode(settings.gpuMode);
  } else if (currentStep === 4) {
    partial.notifyOnConversionComplete = settings.notifyOnConversionComplete;
    partial.preventSleepWhileConverting = settings.preventSleepWhileConverting;
  } else if (currentStep === 5) {
    partial.updateChannel = settings.updateChannel;
  }

  if (Object.keys(partial).length > 0) {
    await deps.saveSettings(partial);
  }
};

const bindWizardControls = (): void => {
  if (!deps || !overlay) {
    return;
  }

  overlay.querySelectorAll<HTMLButtonElement>('.wizard-theme-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme as ThemePreference | undefined;
      if (!theme) {
        return;
      }
      deps?.patchSettings({ theme });
      void deps?.applyTheme();
      void deps?.saveSettings({ theme });
      syncWizardControlsFromSettings();
    });
  });

  overlay.querySelectorAll<HTMLButtonElement>('.wizard-style-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.style;
      if (style !== 'glass' && style !== 'flat') {
        return;
      }
      deps?.patchSettings({ interfaceStyle: style });
      void deps?.applyTheme();
      void deps?.saveSettings({ interfaceStyle: style });
      syncWizardControlsFromSettings();
    });
  });

  const gpuAuto = overlay.querySelector<HTMLInputElement>('#wizardGpuModeAuto');
  const gpuManual = overlay.querySelector<HTMLInputElement>('#wizardGpuModeManual');
  gpuAuto?.addEventListener('change', () => {
    if (gpuAuto.checked) {
      void deps?.persistGpuMode('auto');
    }
  });
  gpuManual?.addEventListener('change', () => {
    if (gpuManual.checked) {
      void deps?.persistGpuMode('manual');
    }
  });

  const notifyCheck = overlay.querySelector<HTMLInputElement>('#wizardNotifyCheck');
  notifyCheck?.addEventListener('change', () => {
    deps?.patchSettings({ notifyOnConversionComplete: notifyCheck.checked });
    void deps?.saveSettings({ notifyOnConversionComplete: notifyCheck.checked });
  });

  const sleepCheck = overlay.querySelector<HTMLInputElement>('#wizardPreventSleepCheck');
  sleepCheck?.addEventListener('change', () => {
    deps?.patchSettings({ preventSleepWhileConverting: sleepCheck.checked });
    void deps?.saveSettings({ preventSleepWhileConverting: sleepCheck.checked });
  });

  const channelSelect = overlay.querySelector<HTMLSelectElement>('#wizardUpdateChannelSelect');
  channelSelect?.addEventListener('change', () => {
    const value = channelSelect.value;
    if (value === 'auto' || value === 'stable' || value === 'beta') {
      deps?.patchSettings({ updateChannel: value });
      void deps?.saveSettings({ updateChannel: value });
    }
  });

  overlay.querySelector('#wizardChooseOutputBtn')?.addEventListener('click', () => {
    void (async () => {
      const dir = await deps?.selectOutputDirectory();
      if (dir) {
        deps?.patchSettings({ outputDirectory: dir });
        await deps?.saveSettings({ outputDirectory: dir });
        syncWizardControlsFromSettings();
      }
    })();
  });

  overlay.querySelector('#wizardClearOutputBtn')?.addEventListener('click', () => {
    deps?.patchSettings({ outputDirectory: '' });
    void deps?.saveSettings({ outputDirectory: '' });
    syncWizardControlsFromSettings();
  });

  overlay.querySelector('#wizardOpenHelpBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    deps?.openHelp();
  });
};

const wireNavigation = (): void => {
  backBtn?.addEventListener('click', () => {
    if (currentStep > 0) {
      currentStep -= 1;
      updateStepUi();
    }
  });

  nextBtn?.addEventListener('click', () => {
    void (async () => {
      await persistStepPreferences();
      if (currentStep >= SETUP_WIZARD_STEP_COUNT - 1) {
        await completeWizard();
        return;
      }
      currentStep += 1;
      updateStepUi();
      const modal = overlay?.querySelector<HTMLElement>('.setup-wizard-dialog');
      if (modal && deps) {
        deps.focusFirstIn(modal);
      }
    })();
  });

  skipBtn?.addEventListener('click', () => {
    void completeWizard();
  });
};

export const initSetupWizard = (wizardDeps: SetupWizardDeps): void => {
  deps = wizardDeps;
  overlay = document.getElementById('setupWizardModal') as HTMLDivElement | null;
  if (!overlay) {
    return;
  }
  stepLabel = overlay.querySelector('#setupWizardStepLabel');
  backBtn = overlay.querySelector('#setupWizardBackBtn');
  nextBtn = overlay.querySelector('#setupWizardNextBtn');
  skipBtn = overlay.querySelector('#setupWizardSkipBtn');
  outputPathEl = overlay.querySelector('#wizardOutputPath');

  bindWizardControls();
  wireNavigation();
};

export const isSetupWizardVisible = (): boolean => {
  return overlay?.classList.contains('visible') ?? false;
};

export const getSetupWizardOverlay = (): HTMLDivElement | null => {
  return overlay;
};

export const openSetupWizard = (): void => {
  if (!overlay || !deps) {
    return;
  }
  returnFocus = document.activeElement as HTMLElement | null;
  currentStep = 0;
  syncWizardControlsFromSettings();
  updateStepUi();
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  const modal = overlay.querySelector<HTMLElement>('.setup-wizard-dialog');
  if (modal) {
    deps.focusFirstIn(modal);
  }
};

export const maybeOpenSetupWizard = (): void => {
  if (!deps) {
    return;
  }
  if (!deps.getSettings().setupWizardCompleted) {
    openSetupWizard();
  }
};

export const skipSetupWizardFromEscape = (): void => {
  if (isSetupWizardVisible()) {
    void completeWizard();
  }
};

export interface SetupWizardApi {
  initSetupWizard: typeof initSetupWizard;
  maybeOpenSetupWizard: typeof maybeOpenSetupWizard;
  openSetupWizard: typeof openSetupWizard;
  isSetupWizardVisible: typeof isSetupWizardVisible;
  getSetupWizardOverlay: typeof getSetupWizardOverlay;
  skipSetupWizardFromEscape: typeof skipSetupWizardFromEscape;
}

const setupWizardApi: SetupWizardApi = {
  initSetupWizard,
  maybeOpenSetupWizard,
  openSetupWizard,
  isSetupWizardVisible,
  getSetupWizardOverlay,
  skipSetupWizardFromEscape,
};

declare const module: { exports?: unknown } | undefined;

if (typeof window !== 'undefined') {
  (window as Window & { setupWizard?: SetupWizardApi }).setupWizard = setupWizardApi;
}

if (typeof module !== 'undefined' && module && typeof module.exports !== 'undefined') {
  module.exports = setupWizardApi;
}
