import { elements } from './dom.js';
import * as setupWizard from './setupWizard.js';

export const getFocusableElements = (container: HTMLElement): HTMLElement[] => {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.offsetParent !== null);
};

export const focusFirstInteractiveElement = (container: HTMLElement): void => {
  const focusables = getFocusableElements(container);
  if (focusables.length > 0) {
    focusables[0].focus();
  }
};

export const getTopVisibleModal = (): HTMLDivElement | null => {
  if (setupWizard.isSetupWizardVisible()) {
    return setupWizard.getSetupWizardOverlay();
  }
  if (elements.dynamicModal.classList.contains('visible')) {
    return elements.dynamicModal;
  }
  if (elements.errorDetailsModal.classList.contains('visible')) {
    return elements.errorDetailsModal;
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

export const trapFocusInModal = (event: KeyboardEvent, modalOverlay: HTMLDivElement): void => {
  let container: HTMLElement | null = null;
  if (modalOverlay.id === 'setupWizardModal' && modalOverlay.classList.contains('spotlight-mode')) {
    container = modalOverlay.querySelector<HTMLElement>('.setup-wizard-callout');
  } else {
    container = modalOverlay.querySelector<HTMLElement>('.setup-wizard-dialog, .modal');
  }
  if (!container || container.hidden) {
    return;
  }
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) {
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (active === first || !active || !container.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last || !active || !container.contains(active)) {
    event.preventDefault();
    first.focus();
  }
};

export const handleTabKeyboardNavigation = (
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
