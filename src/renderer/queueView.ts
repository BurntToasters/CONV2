import type { QueueItemSnapshot, QueueSnapshot } from '../shared/appContract';
import { elements } from './dom.js';
import { openErrorDetails } from './errorDetails.js';

export interface QueueViewDeps {
  isConverting: () => boolean;
  /** A previous run's preset/GPU is known, so Retry can reuse it. */
  hasRunContext: () => boolean;
  retry: (inputPath: string) => void;
}

let deps: QueueViewDeps = {
  isConverting: () => false,
  hasRunContext: () => false,
  retry: () => undefined,
};

export const configureQueueView = (next: QueueViewDeps): void => {
  deps = next;
};

let lastQueueDisplaySnapshot: QueueSnapshot | null = null;

/** The last multi-file or failed batch shown, kept after the run for Retry failed. */
export const getLastQueueDisplaySnapshot = (): QueueSnapshot | null => lastQueueDisplaySnapshot;

/** Everything that affects how a single queue row is drawn. */
const queueRowSignature = (item: QueueItemSnapshot): string =>
  [
    item.status,
    item.error ?? '',
    item.usedCpuFallback ? '1' : '0',
    item.fileName,
    deps.isConverting() ? '1' : '0',
    deps.hasRunContext() ? '1' : '0',
    item.errorDetail ? '1' : '0',
  ].join('\u0001');

const fillQueueRow = (li: HTMLLIElement, item: QueueItemSnapshot): void => {
  li.className = `conversion-queue-item is-${item.status}`;
  const name = document.createElement('span');
  name.className = 'conversion-queue-name';
  name.textContent = item.fileName;
  name.title = item.error ? `${item.fileName}: ${item.error}` : item.fileName;
  const status = document.createElement('span');
  status.className = 'conversion-queue-status';
  // Failure reasons are already one friendly sentence; show them in full.
  const statusLabel =
    item.status === 'failed' && item.error
      ? item.error
      : item.status === 'done' && item.usedCpuFallback
        ? 'done (cpu)'
        : item.status;
  status.textContent = statusLabel;
  const statusWrap = document.createElement('div');
  statusWrap.className = 'conversion-queue-status-wrap';
  statusWrap.append(status);
  if (item.status === 'failed' && item.errorDetail) {
    const details = document.createElement('button');
    details.type = 'button';
    details.className = 'btn btn-secondary btn-xs conversion-queue-details';
    details.textContent = 'Details';
    details.setAttribute('aria-label', `Show error details for ${item.fileName}`);
    const detail = item.errorDetail;
    details.addEventListener('click', () => {
      openErrorDetails({ title: `Error details: ${item.fileName}`, summary: item.error, detail });
    });
    statusWrap.append(details);
  }
  if (item.status === 'failed' && !deps.isConverting() && deps.hasRunContext()) {
    const retryOne = document.createElement('button');
    retryOne.type = 'button';
    retryOne.className = 'btn btn-secondary btn-xs conversion-queue-retry-one';
    retryOne.textContent = 'Retry';
    retryOne.setAttribute('aria-label', `Retry ${item.fileName}`);
    retryOne.addEventListener('click', () => deps.retry(item.inputPath));
    statusWrap.append(retryOne);
  }
  li.replaceChildren(name, statusWrap);
};

// Rows are cached by item id so a snapshot only repaints the rows that changed.
// A full rebuild would be O(files) per snapshot, i.e. O(files²) per batch.
const renderedQueueRows = new Map<string, { li: HTMLLIElement; signature: string }>();
let renderedQueueKey = '';

export const resetQueueRowCache = (): void => {
  renderedQueueRows.clear();
  renderedQueueKey = '';
};

export const renderConversionQueue = (snapshot: QueueSnapshot | null): void => {
  if (snapshot && snapshot.total > 1) {
    lastQueueDisplaySnapshot = snapshot;
  }

  const display =
    snapshot ??
    (!deps.isConverting() && lastQueueDisplaySnapshot ? lastQueueDisplaySnapshot : null);

  const showBatchUi =
    display &&
    (display.total > 1 ||
      display.items.some((item) => item.status === 'failed' || item.status === 'cancelled'));

  if (!showBatchUi || !display) {
    elements.conversionQueue.hidden = true;
    elements.conversionQueueList.replaceChildren();
    resetQueueRowCache();
    elements.retryFailedQueueBtn.classList.add('u-hidden');
    if (snapshot === null && deps.isConverting()) {
      lastQueueDisplaySnapshot = null;
    }
    return;
  }

  elements.conversionQueue.hidden = false;
  const failedCount = display.items.filter((item) => item.status === 'failed').length;
  elements.retryFailedQueueBtn.classList.toggle(
    'u-hidden',
    deps.isConverting() || failedCount === 0 || !deps.hasRunContext()
  );

  const nextKey = display.items.map((item) => item.id).join('\u0001');
  if (nextKey !== renderedQueueKey) {
    resetQueueRowCache();
    const fragment = document.createDocumentFragment();
    for (const item of display.items) {
      const li = document.createElement('li');
      fillQueueRow(li, item);
      renderedQueueRows.set(item.id, { li, signature: queueRowSignature(item) });
      fragment.appendChild(li);
    }
    elements.conversionQueueList.replaceChildren(fragment);
    renderedQueueKey = nextKey;
    return;
  }

  for (const item of display.items) {
    const cached = renderedQueueRows.get(item.id);
    if (!cached) continue;
    const signature = queueRowSignature(item);
    if (signature === cached.signature) continue;
    fillQueueRow(cached.li, item);
    cached.signature = signature;
  }
};
