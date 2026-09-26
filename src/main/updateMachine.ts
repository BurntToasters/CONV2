// Pure update-check lifecycle: (state, event) -> (next state, effects). updater.ts runs the effects.

export type UpdatePhase =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'disabled'
  | 'already-checking';

export interface UpdateStatePayload {
  phase: UpdatePhase;
  manual: boolean;
  message?: string;
  percent?: number;
}

type CheckMode = 'manual' | 'silent';

interface ActiveCheck {
  mode: CheckMode;
  /** Beta feed had nothing newer: 'scheduled' waits one tick, 'running' re-checks stable. */
  fallback: 'none' | 'scheduled' | 'running';
  /** The channel changed mid-check; results belong to the old feed. */
  discard: boolean;
}

export interface UpdateState {
  check: ActiveCheck | null;
  recheckQueued: boolean;
  offer: { version: string; epoch: number } | null;
  /** Epoch when the running download started; null when idle. */
  downloadEpoch: number | null;
  downloaded: string | null;
  installing: boolean;
  /** Bumped on channel change so stale dialogs and downloads are ignored. */
  epoch: number;
}

export interface UpdateContext {
  /** The selected channel resolves to the beta feed. */
  betaFeed: boolean;
}

export type UpdateEvent =
  | { type: 'check'; mode: CheckMode }
  | { type: 'check-rejected'; message: string }
  | { type: 'checker-checking' }
  | { type: 'checker-available'; version: string; accepted: boolean }
  | { type: 'checker-not-available' }
  | { type: 'checker-error'; message: string }
  | { type: 'fallback-tick' }
  | { type: 'channel-changed' }
  | { type: 'download'; version?: string; epoch?: number }
  | { type: 'download-rejected'; message: string }
  | { type: 'download-progress'; message: string; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'install' }
  | { type: 'install-failed'; message: string };

export type UpdateDialog =
  | { type: 'dialog'; dialog: 'no-updates' }
  | { type: 'dialog'; dialog: 'available'; version: string; epoch: number }
  | { type: 'dialog'; dialog: 'already-downloaded' | 'downloaded'; version: string }
  | { type: 'dialog'; dialog: 'error'; message: string };

export type UpdateEffect =
  | { type: 'send'; payload: UpdateStatePayload }
  | { type: 'apply-channel'; forceStable: boolean }
  | { type: 'start-check' }
  | { type: 'schedule-fallback' }
  | { type: 'schedule-silent-check' }
  | { type: 'start-download' }
  | { type: 'menu-changed' }
  | { type: 'run-install' }
  | { type: 'reject'; message: string }
  | UpdateDialog;

export interface UpdateTransition {
  state: UpdateState;
  effects: UpdateEffect[];
}

export const initialUpdateState = (): UpdateState => ({
  check: null,
  recheckQueued: false,
  offer: null,
  downloadEpoch: null,
  downloaded: null,
  installing: false,
  epoch: 0,
});

const send = (
  phase: UpdatePhase,
  manual: boolean,
  message?: string,
  percent?: number
): UpdateEffect => ({
  type: 'send',
  payload: percent === undefined ? { phase, manual, message } : { phase, manual, message, percent },
});

const downloadedSend = (version: string): UpdateEffect =>
  send('downloaded', false, `Version ${version} downloaded.`);

export const transition = (
  prev: UpdateState,
  event: UpdateEvent,
  ctx: UpdateContext
): UpdateTransition => {
  let state: UpdateState = { ...prev, check: prev.check ? { ...prev.check } : null };
  const effects: UpdateEffect[] = [];
  const manual = state.check?.mode === 'manual';

  const endCheck = (): void => {
    state.check = null;
    if (state.recheckQueued) {
      state.recheckQueued = false;
      effects.push({ type: 'schedule-silent-check' });
    }
  };
  const restoreChannel = (): void => {
    if (state.check && state.check.fallback !== 'none') {
      effects.push({ type: 'apply-channel', forceStable: false });
    }
  };
  const tryFallback = (): boolean => {
    if (!state.check || state.check.fallback !== 'none' || !ctx.betaFeed) return false;
    state.check.fallback = 'scheduled';
    effects.push({ type: 'schedule-fallback' });
    return true;
  };
  const reportError = (isManual: boolean, message: string): void => {
    effects.push(
      state.downloaded ? downloadedSend(state.downloaded) : send('error', isManual, message)
    );
  };
  const startCheck = (mode: CheckMode): void => {
    state.check = { mode, fallback: 'none', discard: false };
    effects.push({ type: 'apply-channel', forceStable: false });
    if (!state.downloaded)
      effects.push(send('checking', mode === 'manual', 'Checking for updates...'));
    effects.push({ type: 'start-check' });
  };

  switch (event.type) {
    case 'check':
      if (state.check) {
        if (event.mode === 'manual') {
          effects.push(send('already-checking', true, 'Update check already in progress.'));
        }
        break;
      }
      startCheck(event.mode);
      break;

    case 'check-rejected':
      if (!state.check) break;
      restoreChannel();
      endCheck();
      reportError(manual, `Update error: ${event.message}`);
      break;

    case 'checker-checking':
      if (state.check?.discard || state.downloaded) break;
      effects.push(send('checking', manual, 'Checking for updates...'));
      break;

    case 'checker-available': {
      if (state.check?.discard) {
        restoreChannel();
        endCheck();
        break;
      }
      if (!event.accepted) {
        if (tryFallback()) break;
        restoreChannel();
        state.offer = null;
        effects.push(
          state.downloaded
            ? downloadedSend(state.downloaded)
            : send('not-available', manual, 'No newer version is available for this channel.')
        );
        endCheck();
        break;
      }
      restoreChannel();
      if (state.downloaded === event.version) {
        state.offer = null;
        effects.push(downloadedSend(event.version));
        endCheck();
        break;
      }
      if (state.downloaded) {
        state.downloaded = null;
        effects.push({ type: 'menu-changed' });
      }
      state.offer = { version: event.version, epoch: state.epoch };
      effects.push(send('available', manual, `Update available: ${event.version}`));
      endCheck();
      if (manual) {
        effects.push({
          type: 'dialog',
          dialog: 'available',
          version: event.version,
          epoch: state.epoch,
        });
      }
      break;
    }

    case 'checker-not-available':
      if (state.check?.discard) {
        restoreChannel();
        endCheck();
        break;
      }
      if (tryFallback()) break;
      restoreChannel();
      state.offer = null;
      if (state.downloaded) {
        effects.push(downloadedSend(state.downloaded));
        endCheck();
        if (manual) {
          effects.push({ type: 'dialog', dialog: 'already-downloaded', version: state.downloaded });
        }
        break;
      }
      effects.push(send('not-available', manual, 'You have the latest version.'));
      endCheck();
      if (manual) effects.push({ type: 'dialog', dialog: 'no-updates' });
      break;

    case 'checker-error': {
      restoreChannel();
      const discarded = state.check?.discard === true;
      endCheck();
      if (discarded) break;
      reportError(manual, `Update error: ${event.message}`);
      if (manual) effects.push({ type: 'dialog', dialog: 'error', message: event.message });
      break;
    }

    case 'fallback-tick':
      if (!state.check || state.check.fallback !== 'scheduled') break;
      if (state.check.discard) {
        endCheck();
        break;
      }
      state.check.fallback = 'running';
      effects.push({ type: 'apply-channel', forceStable: true });
      if (!state.downloaded) effects.push(send('checking', manual, 'Checking for updates...'));
      effects.push({ type: 'start-check' });
      break;

    case 'channel-changed':
      state.epoch += 1;
      state.offer = null;
      if (state.downloaded) {
        state.downloaded = null;
        effects.push({ type: 'menu-changed' });
      }
      effects.push(send('not-available', false, 'Update channel changed.'));
      if (state.check) {
        state.check.discard = true;
        state.recheckQueued = true;
      } else {
        startCheck('silent');
      }
      break;

    case 'download': {
      const fromDialog = event.version !== undefined;
      if (fromDialog && (state.offer?.version !== event.version || event.epoch !== state.epoch)) {
        break;
      }
      if (!state.offer) {
        effects.push(send('error', true, 'No update is available to download.'));
        if (state.downloaded) effects.push(downloadedSend(state.downloaded));
        break;
      }
      state.downloadEpoch = state.epoch;
      effects.push({ type: 'start-download' }, send('downloading', true, 'Downloading update...'));
      break;
    }

    case 'download-rejected':
      state.downloadEpoch = null;
      reportError(true, `Update error: ${event.message}`);
      break;

    case 'download-progress':
      effects.push(send('downloading', false, event.message, event.percent));
      break;

    case 'downloaded':
      if (state.downloadEpoch !== null && state.downloadEpoch !== state.epoch) {
        state.downloadEpoch = null;
        state.offer = null;
        break;
      }
      state.downloadEpoch = null;
      state.downloaded = event.version;
      state.offer = null;
      effects.push({ type: 'menu-changed' }, downloadedSend(event.version));
      effects.push({ type: 'dialog', dialog: 'downloaded', version: event.version });
      break;

    case 'install':
      if (state.installing) break;
      if (!state.downloaded) {
        const message = 'No downloaded update is ready to install.';
        effects.push(send('error', true, message), { type: 'reject', message });
        break;
      }
      state.installing = true;
      effects.push(
        { type: 'menu-changed' },
        send('installing', true, 'Restarting to install update...'),
        { type: 'run-install' }
      );
      break;

    case 'install-failed':
      state.installing = false;
      effects.push({ type: 'menu-changed' }, send('error', true, `Update error: ${event.message}`));
      break;
  }

  state = { ...state };
  return { state, effects };
};
