export const SETUP_WIZARD_STEP_COUNT = 10;

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
  /** On failure, restores the last saved values in memory (unless superseded) and rejects. */
  saveSettings: (partial: Partial<SetupWizardSettingsSlice>) => Promise<void>;
  setUpdateChannel: (channel: SetupWizardSettingsSlice['updateChannel']) => Promise<void>;
  reportError: (message: string) => void;
  applyTheme: () => Promise<void>;
  applyGpuModeUi: () => void;
  persistGpuMode: (mode: GPUMode) => Promise<void>;
  selectOutputDirectory: () => Promise<string | undefined>;
  openHelp: () => void;
  focusFirstIn: (container: HTMLElement) => void;
  isFfmpegInstalled: () => boolean;
  prepareAppTourSpotlight: (targetId: string) => void;
  clearAppTourSpotlight: () => void;
  /** Runs after the wizard closes, so other screens can resync from settings. */
  onClosed?: () => void;
}

let deps: SetupWizardDeps | null = null;
let currentStep = 0;
let returnFocus: HTMLElement | null = null;
let spotlightResizeListener: (() => void) | null = null;

let overlay: HTMLDivElement | null = null;
let dialog: HTMLElement | null = null;
let spotlightLayer: HTMLDivElement | null = null;
let spotlightRing: HTMLDivElement | null = null;
let calloutBody: HTMLDivElement | null = null;
let stepLabel: HTMLSpanElement | null = null;
let spotlightStepLabel: HTMLSpanElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;
let skipBtn: HTMLButtonElement | null = null;
let spotlightBackBtn: HTMLButtonElement | null = null;
let spotlightNextBtn: HTMLButtonElement | null = null;
let outputPathEl: HTMLSpanElement | null = null;
let stepTransitionBusy = false;
let wizardCompleting = false;
let spotlightScrollListener: (() => void) | null = null;
let spotlightTargetObserver: ResizeObserver | null = null;

const detachSpotlightTargetObserver = (): void => {
  if (spotlightTargetObserver) {
    spotlightTargetObserver.disconnect();
    spotlightTargetObserver = null;
  }
};

const resetSpotlightChromeStyles = (): void => {
  if (spotlightRing) {
    spotlightRing.style.top = '';
    spotlightRing.style.left = '';
    spotlightRing.style.width = '';
    spotlightRing.style.height = '';
  }
  const callout = document.getElementById('setupWizardCallout');
  if (callout) {
    callout.style.top = '';
    callout.style.left = '';
  }
};

const scheduleSpotlightMeasure = (step: number): void => {
  measureSpotlightLayout(step);
  requestAnimationFrame(() => {
    measureSpotlightLayout(step);
    requestAnimationFrame(() => measureSpotlightLayout(step));
  });
};

const getStepPanel = (step: number): HTMLElement | null => {
  if (!overlay) {
    return null;
  }
  return overlay.querySelector<HTMLElement>(`[data-wizard-step="${step}"]`);
};

const getStepPanels = (): HTMLElement[] => {
  if (!overlay) {
    return [];
  }
  return Array.from(overlay.querySelectorAll<HTMLElement>('[data-wizard-step]'));
};

const isSpotlightStep = (step: number): boolean => {
  return getStepPanel(step)?.dataset.wizardPresentation === 'spotlight';
};

const getSpotlightTargetId = (step: number): string | null => {
  const target = getStepPanel(step)?.dataset.spotlightTarget;
  return target && target.length > 0 ? target : null;
};

const clearSpotlightLayout = (): void => {
  deps?.clearAppTourSpotlight();
  detachSpotlightTargetObserver();
  if (spotlightResizeListener) {
    window.removeEventListener('resize', spotlightResizeListener);
    spotlightResizeListener = null;
  }
  if (spotlightScrollListener) {
    window.removeEventListener('scroll', spotlightScrollListener, true);
    spotlightScrollListener = null;
  }
  overlay?.classList.remove('spotlight-mode');
  if (spotlightLayer) {
    spotlightLayer.hidden = true;
    spotlightLayer.setAttribute('aria-hidden', 'true');
  }
  if (calloutBody) {
    calloutBody.replaceChildren();
  }
  resetSpotlightChromeStyles();
  if (dialog) {
    dialog.hidden = false;
    dialog.removeAttribute('aria-hidden');
  }
};

const positionSpotlightCallout = (targetRect: DOMRect): void => {
  const callout = document.getElementById('setupWizardCallout');
  if (!callout) {
    return;
  }
  const margin = 12;
  const calloutRect = callout.getBoundingClientRect();
  let top = targetRect.bottom + margin;
  if (top + calloutRect.height > window.innerHeight - margin) {
    top = Math.max(margin, targetRect.top - calloutRect.height - margin);
  }
  let left = targetRect.left + targetRect.width / 2 - calloutRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - calloutRect.width - margin));
  callout.style.top = `${top}px`;
  callout.style.left = `${left}px`;
};

const appendPanelContentToCallout = (panel: HTMLElement): void => {
  if (!calloutBody) {
    return;
  }
  calloutBody.replaceChildren();
  Array.from(panel.childNodes).forEach((node) => {
    const clone = node.cloneNode(true);
    if (clone instanceof HTMLElement) {
      if (clone.id) {
        clone.removeAttribute('id');
      }
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    }
    calloutBody?.appendChild(clone);
  });
};

const measureSpotlightLayout = (step: number): void => {
  const targetId = getSpotlightTargetId(step);
  if (!targetId || !spotlightRing) {
    return;
  }
  const target = document.getElementById(targetId);
  if (!target) {
    return;
  }
  const pad = 10;
  const rect = target.getBoundingClientRect();
  spotlightRing.style.top = `${Math.max(0, rect.top - pad)}px`;
  spotlightRing.style.left = `${Math.max(0, rect.left - pad)}px`;
  spotlightRing.style.width = `${rect.width + pad * 2}px`;
  spotlightRing.style.height = `${rect.height + pad * 2}px`;
  positionSpotlightCallout(rect);
};

const layoutSpotlightForStep = (step: number): void => {
  const targetId = getSpotlightTargetId(step);
  if (!targetId || !calloutBody) {
    return;
  }
  deps?.prepareAppTourSpotlight(targetId);
  const target = document.getElementById(targetId);
  if (!target) {
    return;
  }
  target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  detachSpotlightTargetObserver();
  if (typeof ResizeObserver !== 'undefined') {
    spotlightTargetObserver = new ResizeObserver(() => {
      if (isSpotlightStep(currentStep)) {
        measureSpotlightLayout(currentStep);
      }
    });
    spotlightTargetObserver.observe(target);
  }
  scheduleSpotlightMeasure(step);
};

const showSpotlightStep = (step: number): void => {
  const panel = getStepPanel(step);
  if (!overlay || !spotlightLayer || !calloutBody || !panel) {
    return;
  }
  overlay.classList.add('spotlight-mode');
  if (dialog) {
    dialog.hidden = true;
    dialog.setAttribute('aria-hidden', 'true');
  }
  spotlightLayer.hidden = false;
  spotlightLayer.removeAttribute('aria-hidden');
  appendPanelContentToCallout(panel);
  syncWizardControlsFromSettings();
  layoutSpotlightForStep(step);
  const remountSpotlight = (): void => {
    if (isSpotlightStep(currentStep)) {
      measureSpotlightLayout(currentStep);
    }
  };
  if (!spotlightResizeListener) {
    spotlightResizeListener = remountSpotlight;
    window.addEventListener('resize', spotlightResizeListener);
  }
  if (!spotlightScrollListener) {
    spotlightScrollListener = remountSpotlight;
    window.addEventListener('scroll', spotlightScrollListener, true);
  }
  const callout = document.getElementById('setupWizardCallout');
  if (callout && deps) {
    deps.focusFirstIn(callout as HTMLElement);
  }
};

const showModalStep = (): void => {
  clearSpotlightLayout();
};

const syncWizardControlsFromSettings = (): void => {
  if (!deps || !overlay) {
    return;
  }
  const settings = deps.getSettings();
  const scope = overlay;

  scope.querySelectorAll<HTMLButtonElement>('.wizard-theme-option').forEach((btn) => {
    const theme = btn.dataset.theme as ThemePreference | undefined;
    btn.classList.toggle('active', theme === settings.theme);
  });

  scope.querySelectorAll<HTMLButtonElement>('.wizard-style-option').forEach((btn) => {
    const style = btn.dataset.style;
    btn.classList.toggle('active', style === settings.interfaceStyle);
  });

  const gpuAuto = scope.querySelector<HTMLInputElement>('#wizardGpuModeAuto');
  const gpuManual = scope.querySelector<HTMLInputElement>('#wizardGpuModeManual');
  if (gpuAuto && gpuManual) {
    gpuAuto.checked = settings.gpuMode !== 'manual';
    gpuManual.checked = settings.gpuMode === 'manual';
  }

  const notifyCheck = scope.querySelector<HTMLInputElement>('#wizardNotifyCheck');
  const sleepCheck = scope.querySelector<HTMLInputElement>('#wizardPreventSleepCheck');
  if (notifyCheck) {
    notifyCheck.checked = settings.notifyOnConversionComplete !== false;
  }
  if (sleepCheck) {
    sleepCheck.checked = settings.preventSleepWhileConverting;
  }

  const channelSelect = scope.querySelector<HTMLSelectElement>('#wizardUpdateChannelSelect');
  if (channelSelect) {
    channelSelect.value = settings.updateChannel;
  }

  if (outputPathEl) {
    outputPathEl.textContent = settings.outputDirectory
      ? settings.outputDirectory
      : 'Same as input file';
  }

  scope.querySelectorAll<HTMLElement>('.wizard-ffmpeg-note').forEach((ffmpegNote) => {
    ffmpegNote.hidden = deps!.isFfmpegInstalled();
  });
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

  const labelText = `Step ${currentStep + 1} of ${SETUP_WIZARD_STEP_COUNT}`;
  stepLabel.textContent = labelText;
  if (spotlightStepLabel) {
    spotlightStepLabel.textContent = labelText;
  }

  const isLast = currentStep === SETUP_WIZARD_STEP_COUNT - 1;
  const nextLabel = isLast ? 'Get started' : 'Next';
  nextBtn.textContent = nextLabel;
  if (spotlightNextBtn) {
    spotlightNextBtn.textContent = nextLabel;
  }

  backBtn.disabled = currentStep === 0;
  if (spotlightBackBtn) {
    spotlightBackBtn.disabled = currentStep === 0;
  }

  if (isSpotlightStep(currentStep)) {
    showSpotlightStep(currentStep);
  } else {
    showModalStep();
  }

  syncWizardControlsFromSettings();
};

const closeWizard = (): void => {
  if (!overlay) {
    return;
  }
  stepTransitionBusy = false;
  wizardCompleting = false;
  clearSpotlightLayout();
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
  if (returnFocus && typeof returnFocus.focus === 'function') {
    returnFocus.focus();
  }
  returnFocus = null;
  deps?.onClosed?.();
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Patches memory, then saves; a failed save is reported and the controls resynced.
const saveWizardChange = async (
  partial: Partial<SetupWizardSettingsSlice>,
  failurePrefix: string,
  afterPatch?: () => void
): Promise<void> => {
  const wizardDeps = deps;
  if (!wizardDeps) {
    return;
  }
  wizardDeps.patchSettings(partial);
  afterPatch?.();
  syncWizardControlsFromSettings();
  try {
    await wizardDeps.saveSettings(partial);
  } catch (error) {
    syncWizardControlsFromSettings();
    wizardDeps.reportError(`${failurePrefix}: ${errorMessage(error)}`);
  }
};

const completeWizard = async (): Promise<void> => {
  if (wizardCompleting) {
    return;
  }
  wizardCompleting = true;
  if (!deps) {
    closeWizard();
    return;
  }
  // Still closes on failure; the flag is restored, so setup shows again next launch.
  await saveWizardChange({ setupWizardCompleted: true }, 'Failed to save setup progress');
  closeWizard();
};

const persistStepPreferences = async (): Promise<void> => {
  if (!deps || !overlay) {
    return;
  }
  const settings = deps.getSettings();
  const partial: Partial<SetupWizardSettingsSlice> = {};
  let channel: SetupWizardSettingsSlice['updateChannel'] | undefined;

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
    channel = settings.updateChannel;
  }

  if (Object.keys(partial).length > 0) {
    await deps.saveSettings(partial);
  }
  if (channel) {
    await deps.setUpdateChannel(channel);
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
      void saveWizardChange({ theme }, 'Failed to save theme', () => {
        void deps?.applyTheme();
      });
    });
  });

  overlay.querySelectorAll<HTMLButtonElement>('.wizard-style-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.style;
      if (style !== 'glass' && style !== 'flat') {
        return;
      }
      void saveWizardChange({ interfaceStyle: style }, 'Failed to save interface style', () => {
        void deps?.applyTheme();
      });
    });
  });

  const resyncAfterGpuMode = async (mode: GPUMode): Promise<void> => {
    try {
      await deps?.persistGpuMode(mode);
    } catch (error) {
      deps?.reportError(`Failed to save GPU mode: ${errorMessage(error)}`);
    }
    syncWizardControlsFromSettings();
  };

  const gpuAuto = overlay.querySelector<HTMLInputElement>('#wizardGpuModeAuto');
  const gpuManual = overlay.querySelector<HTMLInputElement>('#wizardGpuModeManual');
  gpuAuto?.addEventListener('change', () => {
    if (gpuAuto.checked) {
      void resyncAfterGpuMode('auto');
    }
  });
  gpuManual?.addEventListener('change', () => {
    if (gpuManual.checked) {
      void resyncAfterGpuMode('manual');
    }
  });

  const notifyCheck = overlay.querySelector<HTMLInputElement>('#wizardNotifyCheck');
  notifyCheck?.addEventListener('change', () => {
    void saveWizardChange(
      { notifyOnConversionComplete: notifyCheck.checked },
      'Failed to save notification setting'
    );
  });

  const sleepCheck = overlay.querySelector<HTMLInputElement>('#wizardPreventSleepCheck');
  sleepCheck?.addEventListener('change', () => {
    void saveWizardChange(
      { preventSleepWhileConverting: sleepCheck.checked },
      'Failed to save prevent-sleep setting'
    );
  });

  const channelSelect = overlay.querySelector<HTMLSelectElement>('#wizardUpdateChannelSelect');
  channelSelect?.addEventListener('change', () => {
    const value = channelSelect.value;
    if (value !== 'auto' && value !== 'stable' && value !== 'beta') {
      return;
    }
    void saveWizardChange({ updateChannel: value }, 'Failed to save update channel');
  });

  overlay.querySelector('#wizardChooseOutputBtn')?.addEventListener('click', () => {
    void (async () => {
      const dir = await deps?.selectOutputDirectory();
      if (dir) {
        await saveWizardChange({ outputDirectory: dir }, 'Failed to save output directory');
      }
    })();
  });

  overlay.querySelector('#wizardClearOutputBtn')?.addEventListener('click', () => {
    void saveWizardChange({ outputDirectory: '' }, 'Failed to reset output directory');
  });

  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.setup-wizard-step-skip')) {
      event.preventDefault();
      void completeWizard();
      return;
    }
    if (target?.closest('.wizard-open-help')) {
      event.preventDefault();
      deps?.openHelp();
    }
  });
};

const goBack = (): void => {
  if (stepTransitionBusy || wizardCompleting || currentStep <= 0) {
    return;
  }
  currentStep -= 1;
  updateStepUi();
  focusActiveWizardSurface();
};

const goNext = (): void => {
  if (stepTransitionBusy || wizardCompleting) {
    return;
  }
  void (async () => {
    stepTransitionBusy = true;
    try {
      await persistStepPreferences();
      if (wizardCompleting) {
        return;
      }
      if (currentStep >= SETUP_WIZARD_STEP_COUNT - 1) {
        await completeWizard();
        return;
      }
      currentStep += 1;
      updateStepUi();
      focusActiveWizardSurface();
    } catch (error) {
      deps?.reportError(`Failed to save setup wizard settings: ${errorMessage(error)}`);
    } finally {
      stepTransitionBusy = false;
    }
  })();
};

const focusActiveWizardSurface = (): void => {
  if (!deps) {
    return;
  }
  if (isSpotlightStep(currentStep)) {
    const callout = document.getElementById('setupWizardCallout');
    if (callout) {
      deps.focusFirstIn(callout);
    }
    return;
  }
  const modal = overlay?.querySelector<HTMLElement>('.setup-wizard-dialog');
  if (modal) {
    deps.focusFirstIn(modal);
  }
};

const wireNavigation = (): void => {
  backBtn?.addEventListener('click', goBack);
  nextBtn?.addEventListener('click', goNext);
  skipBtn?.addEventListener('click', () => {
    void completeWizard();
  });
  spotlightBackBtn?.addEventListener('click', goBack);
  spotlightNextBtn?.addEventListener('click', goNext);
};

export const initSetupWizard = (wizardDeps: SetupWizardDeps): void => {
  deps = wizardDeps;
  overlay = document.getElementById('setupWizardModal') as HTMLDivElement | null;
  if (!overlay) {
    return;
  }
  dialog = overlay.querySelector('.setup-wizard-dialog');
  spotlightLayer = overlay.querySelector('#setupWizardSpotlightLayer');
  spotlightRing = overlay.querySelector('#setupWizardSpotlightRing');
  calloutBody = overlay.querySelector('#setupWizardCalloutBody');
  stepLabel = overlay.querySelector('#setupWizardStepLabel');
  spotlightStepLabel = overlay.querySelector('#setupWizardSpotlightStepLabel');
  backBtn = overlay.querySelector('#setupWizardBackBtn');
  nextBtn = overlay.querySelector('#setupWizardNextBtn');
  skipBtn = overlay.querySelector('#setupWizardSkipBtn');
  spotlightBackBtn = overlay.querySelector('#setupWizardSpotlightBackBtn');
  spotlightNextBtn = overlay.querySelector('#setupWizardSpotlightNextBtn');
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
  if (overlay.classList.contains('visible')) {
    return;
  }
  stepTransitionBusy = false;
  wizardCompleting = false;
  clearSpotlightLayout();
  returnFocus = document.activeElement as HTMLElement | null;
  currentStep = 0;
  syncWizardControlsFromSettings();
  updateStepUi();
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  focusActiveWizardSurface();
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
