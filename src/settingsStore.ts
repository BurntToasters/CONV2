// Serialized renderer settings saves. Every save runs in order, so a quick
// on/off toggle cannot persist out of order. Per-key revisions let a failed
// save tell whether a newer change to the same key has superseded it, and a
// committed-value mirror says what the backend last accepted.
import { api, type SaveSettingsPayload } from './api';

export interface SettingsSaveHandle<T = void> {
  /** Settles when this task ran; rejects with the task's error. */
  done: Promise<T>;
  /** True once a later task touched any of the same keys. */
  isStale: () => boolean;
  /** Keys no later task touched; a failed save rolls back only these. */
  liveKeys: () => string[];
}

type Plain = Record<string, unknown>;

let revision = 0;
let pending = 0;
let chain: Promise<void> = Promise.resolve();
const keyRevisions = new Map<string, number>();
let committed: Plain = {};

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** Seeds the committed mirror from settings the backend just returned. */
export const seedCommittedSettings = (loaded: object): void => {
  committed = clone(loaded) as Plain;
};

/** Last value the backend accepted; `parent.child` reads one nested value. */
export const getCommittedSetting = (key: string): unknown => {
  const [top = '', sub] = key.split('.');
  const value = committed[top];
  return clone(sub === undefined ? value : isPlain(value) ? value[sub] : undefined);
};

const commitPatch = (patch: Plain): void => {
  for (const [key, value] of Object.entries(patch)) {
    const existing = committed[key];
    committed[key] =
      isPlain(value) && isPlain(existing) ? { ...existing, ...clone(value) } : clone(value);
  }
};

// Nested objects split per sub-value so independent saves never supersede each other.
const keysOfPatch = (patch: Plain): string[] =>
  Object.entries(patch).flatMap(([key, value]) => {
    const subKeys = isPlain(value) ? Object.keys(value) : [];
    return subKeys.length > 0 ? subKeys.map((sub) => `${key}.${sub}`) : [key];
  });

/** Runs `task` after every earlier settings task; `commit` is mirrored once it succeeds. */
export const enqueueSettingsTask = <T>(
  keys: readonly string[],
  task: () => Promise<T>,
  commit?: Plain
): SettingsSaveHandle<T> => {
  revision += 1;
  const mine = revision;
  keys.forEach((key) => keyRevisions.set(key, mine));
  pending += 1;
  const done = chain.then(async () => {
    const result = await task();
    if (commit) commitPatch(commit);
    return result;
  });
  chain = done
    .then(
      () => undefined,
      () => undefined
    )
    .then(() => {
      pending -= 1;
    });
  return {
    done,
    isStale: () => keys.some((key) => (keyRevisions.get(key) ?? 0) > mine),
    liveKeys: () => keys.filter((key) => (keyRevisions.get(key) ?? 0) <= mine),
  };
};

/** Queues a partial settings patch for the backend. */
export const queueSettingsSave = (patch: Plain): SettingsSaveHandle =>
  enqueueSettingsTask(
    keysOfPatch(patch),
    () => api.saveSettings(patch as SaveSettingsPayload),
    clone(patch)
  );

export const hasPendingSettingsSaves = (): boolean => pending > 0;

/** Waits for the queue to empty; false when `timeoutMs` ran out first. */
export const drainSettingsSaves = async (timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const drained = (async () => {
    while (pending > 0) {
      await chain;
    }
    return true;
  })();
  try {
    return await Promise.race([drained, timeout]);
  } finally {
    clearTimeout(timer);
  }
};
