export interface QuitGuardDeps {
  isConversionActive: () => boolean;
  isUpdateInstallInProgress: () => boolean;
  /** Resolves true when the user chooses to quit anyway. */
  confirmQuit: () => Promise<boolean>;
  stopConversion: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface QuitGuard {
  /** True: caller may continue. False: caller must preventDefault; resume runs once confirmed. */
  request: (resume: () => void) => boolean;
  /** Drops a prior confirmation; call when a new conversion starts. */
  reset: () => void;
  /** Resolves once any in-flight prompt has finished. */
  settled: () => Promise<void>;
}

/** One confirmation for every quit path (window close, app menu, Cmd+Q, OS shutdown). */
export const createQuitGuard = (deps: QuitGuardDeps): QuitGuard => {
  let confirmed = false;
  let pending: Array<() => void> = [];
  let inFlight: Promise<void> | null = null;

  const report = (error: unknown): void => {
    deps.onError?.(error);
  };

  const runPrompt = async (): Promise<void> => {
    let accepted = false;
    try {
      accepted = await deps.confirmQuit();
    } catch (error) {
      report(error);
    }
    if (!accepted) {
      pending = [];
      return;
    }

    confirmed = true;
    try {
      await deps.stopConversion();
    } catch (error) {
      report(error);
    }

    const resumes = pending;
    pending = [];
    for (const resume of resumes) {
      try {
        resume();
      } catch (error) {
        report(error);
      }
    }
  };

  return {
    request: (resume) => {
      if (confirmed || deps.isUpdateInstallInProgress() || !deps.isConversionActive()) {
        return true;
      }
      pending.push(resume);
      if (!inFlight) {
        inFlight = runPrompt().finally(() => {
          inFlight = null;
        });
      }
      return false;
    },
    reset: () => {
      confirmed = false;
    },
    settled: () => inFlight ?? Promise.resolve(),
  };
};
