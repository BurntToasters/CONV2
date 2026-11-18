// Compile-time gated WebDriver guest plugin for unpackaged E2E builds only.
// Comparing the Vite define directly lets Rollup drop this chunk in
// production builds.
import { api, type Conv2RendererApi } from './api';

export async function installE2eHookIfEnabled(): Promise<void> {
  if (import.meta.env.VITE_CONV2_E2E !== '1') return;
  await import('@wdio/tauri-plugin');
  (
    window as Window & {
      __CONV2_E2E__?: { ready: boolean; api: Conv2RendererApi };
    }
  ).__CONV2_E2E__ = {
    ready: true,
    api,
  };
}
