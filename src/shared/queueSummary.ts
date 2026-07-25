export type QueueSummaryItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueSummaryItem {
  status: QueueSummaryItemStatus;
  fileName?: string;
  error?: string;
  usedCpuFallback?: boolean;
}

export interface QueueSummaryInput {
  total: number;
  items: QueueSummaryItem[];
}

export interface QueueOutcomeCounts {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  cpuFallback: number;
}

export const countQueueOutcomes = (input: QueueSummaryInput): QueueOutcomeCounts => {
  const total = input.total || input.items.length;
  const done = input.items.filter((item) => item.status === 'done').length;
  const failed = input.items.filter((item) => item.status === 'failed').length;
  const cancelled = input.items.filter((item) => item.status === 'cancelled').length;
  const cpuFallback = input.items.filter(
    (item) => item.status === 'done' && item.usedCpuFallback
  ).length;
  return { total, done, failed, cancelled, cpuFallback };
};

export const summarizeQueueForNotification = (
  input: QueueSummaryInput
): { title: string; body: string } => {
  const { total, done, failed, cancelled, cpuFallback } = countQueueOutcomes(input);

  if (total <= 1) {
    const item = input.items[0];
    if (item?.status === 'done') {
      const suffix = item.usedCpuFallback || cpuFallback > 0 ? ' (CPU fallback)' : '';
      return {
        title: 'Conversion complete',
        body: `${item.fileName || 'Your video is ready.'}${suffix}`,
      };
    }
    if (item?.status === 'cancelled') {
      return { title: 'Conversion cancelled', body: item.fileName || 'Conversion was cancelled.' };
    }
    return {
      title: 'Conversion failed',
      body: item?.error || item?.fileName || 'Conversion did not complete.',
    };
  }

  if (cancelled > 0 && done > 0) {
    return {
      title: 'Batch cancelled',
      body: `${done} of ${total} videos converted before cancel.`,
    };
  }
  if (cancelled > 0 && done === 0) {
    return { title: 'Batch cancelled', body: 'No videos were converted.' };
  }
  if (failed === 0 && done === total) {
    const fallbackNote = cpuFallback > 0 ? ` (${cpuFallback} used CPU fallback)` : '';
    return {
      title: 'Batch complete',
      body: `All ${total} videos converted successfully.${fallbackNote}`,
    };
  }
  if (done === 0) {
    return { title: 'Batch failed', body: `None of the ${total} videos converted.` };
  }
  const fallbackNote = cpuFallback > 0 ? `, ${cpuFallback} CPU fallback` : '';
  return {
    title: 'Batch finished',
    body: `${done} succeeded, ${failed} failed (${total} total${fallbackNote}).`,
  };
};

export type QueueUiStatusType = 'success' | 'error' | 'warning';

export const summarizeQueueForUiStatus = (
  input: QueueSummaryInput,
  options?: { wasCancelled?: boolean }
): { type: QueueUiStatusType; message: string } => {
  const { total, done, failed, cancelled, cpuFallback } = countQueueOutcomes(input);
  const wasCancelled = options?.wasCancelled ?? cancelled > 0;

  if (total <= 1) {
    const item = input.items[0];
    if (item?.status === 'done' && item.usedCpuFallback) {
      return {
        type: 'warning',
        message: 'Conversion complete. GPU unavailable; retried with CPU.',
      };
    }
    if (item?.status === 'done') {
      return { type: 'success', message: 'Conversion complete!' };
    }
    if (item?.status === 'cancelled' || wasCancelled) {
      return { type: 'warning', message: 'Conversion cancelled' };
    }
    return {
      type: 'error',
      message: `Conversion failed: ${item?.error || 'Unknown error'}`,
    };
  }

  const notification = summarizeQueueForNotification(input);
  if (wasCancelled && done > 0) {
    return { type: 'warning', message: notification.body };
  }
  if (wasCancelled && done === 0) {
    return { type: 'warning', message: notification.body };
  }
  if (failed === 0 && done === total) {
    if (cpuFallback > 0) {
      return {
        type: 'warning',
        message: `${notification.body}`,
      };
    }
    return { type: 'success', message: notification.body };
  }
  if (done === 0) {
    return { type: 'error', message: notification.body };
  }
  return { type: 'warning', message: notification.body };
};

export interface QueueSummaryApi {
  countQueueOutcomes: typeof countQueueOutcomes;
  summarizeQueueForNotification: typeof summarizeQueueForNotification;
  summarizeQueueForUiStatus: typeof summarizeQueueForUiStatus;
}

const queueSummaryApi: QueueSummaryApi = {
  countQueueOutcomes,
  summarizeQueueForNotification,
  summarizeQueueForUiStatus,
};

if (typeof window !== 'undefined') {
  (window as Window & { queueSummary?: QueueSummaryApi }).queueSummary = queueSummaryApi;
}
