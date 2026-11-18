// Main window entry. The API module evaluates before the engine, and the
// engine uses it at call time.
import './api';
import './conv2Engine';
import { call } from './commands';
import { installE2eHookIfEnabled } from './e2e-hook';

window.addEventListener('load', () => {
  void (async () => {
    await window.__CONV2_RENDERER_STARTUP_READY__;
    try {
      await installE2eHookIfEnabled();
    } catch (error) {
      console.error('[conv2] E2E hook failed', error);
    }
    await call('mark_main_window_ready');
  })().catch((error: unknown) => {
    console.error('[conv2] main renderer readiness failed', error);
  });
});
