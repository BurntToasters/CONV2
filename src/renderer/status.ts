// Main-window status line. Failures keep one friendly sentence; raw output sits behind Details.
import { elements } from './dom.js';
import { openErrorDetails, type ErrorDetails } from './errorDetails.js';

export type StatusType = 'success' | 'error' | 'warning';

let currentDetails: ErrorDetails | null = null;

export const showStatus = (type: StatusType, message: string, details?: ErrorDetails): void => {
  elements.statusMessage.className = `status-message visible ${type}`;
  let textEl = elements.statusMessage.querySelector('.status-text');
  if (!textEl) {
    textEl = document.createElement('span');
    textEl.className = 'status-text';
    elements.statusMessage.appendChild(textEl);
  }
  textEl.textContent = message;
  currentDetails = details && details.detail.trim().length > 0 ? details : null;
  elements.statusDetailsBtn.classList.toggle('u-hidden', currentDetails === null);
};

export const hideStatus = (): void => {
  elements.statusMessage.classList.remove('visible');
  currentDetails = null;
  elements.statusDetailsBtn.classList.add('u-hidden');
};

elements.statusDetailsBtn.addEventListener('click', () => {
  if (currentDetails) openErrorDetails(currentDetails);
});
