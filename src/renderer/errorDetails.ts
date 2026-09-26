// "Details" view for a failed conversion: the friendly reason plus FFmpeg's raw tail.
import { elements } from './dom.js';
import { focusFirstInteractiveElement } from './modals.js';

export interface ErrorDetails {
  title: string;
  summary?: string;
  detail: string;
}

let returnFocus: HTMLElement | null = null;

export const isErrorDetailsOpen = (): boolean =>
  elements.errorDetailsModal.classList.contains('visible');

export const openErrorDetails = ({ title, summary, detail }: ErrorDetails): void => {
  returnFocus = document.activeElement as HTMLElement | null;
  elements.errorDetailsTitle.textContent = title;
  elements.errorDetailsSummary.textContent = summary ?? '';
  elements.errorDetailsSummary.hidden = !summary;
  elements.errorDetailsContent.textContent = detail;
  elements.errorDetailsModal.classList.add('visible');
  focusFirstInteractiveElement(elements.errorDetailsModal);
};

export const closeErrorDetails = (): void => {
  if (!isErrorDetailsOpen()) return;
  elements.errorDetailsModal.classList.remove('visible');
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
};

elements.closeErrorDetails.addEventListener('click', closeErrorDetails);
elements.errorDetailsModal.addEventListener('click', (event) => {
  if (event.target === elements.errorDetailsModal) closeErrorDetails();
});
elements.copyErrorDetailsBtn.addEventListener('click', () => {
  const text = [elements.errorDetailsSummary.textContent, elements.errorDetailsContent.textContent]
    .filter(Boolean)
    .join('\n\n');
  void navigator.clipboard.writeText(text).then(
    () => {
      elements.copyErrorDetailsBtn.textContent = 'Copied';
      setTimeout(() => {
        elements.copyErrorDetailsBtn.textContent = 'Copy';
      }, 1500);
    },
    () => undefined
  );
});
