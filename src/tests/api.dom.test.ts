// @vitest-environment jsdom
// Failure modes: src/tests/api.dom.failure-modes.md
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { api, fetchLicenses } from '../api';

// The v1 preload bridge (src/shared/electronApi.ts, now deleted) exposed:
// getPathForFile, selectOutputDirectory, getFileInfo, startConversionQueue,
// cancelConversion, onConversionProgress, onConversionLog,
// onConversionQueueUpdated, onGPUEncoderError, getPresets, getGpuCapabilities,
// refreshGpuCapabilities, getSettings, getDefaultAdvancedFormatSettings,
// saveSettings, checkForUpdates, downloadUpdate, installUpdate,
// isUpdatesDisabled, onUpdateState, checkFFmpeg, getVersion, getPlatform,
// getArch, revealPath, openExternal, getSystemTheme, onThemeChange,
// onAppMenuAction, setConversionMenuState, minimizeWindow, toggleMaximizeWindow,
// closeWindow, isWindowMaximized, onWindowChromeStyle, onWindowMaximizedChanged,
// resetSettings, restartApp, getLicenses.
const EXPECTED_API_METHODS = [
  // v1 names kept as-is
  'selectOutputDirectory',
  'getFileInfo',
  'startConversionQueue',
  'cancelConversion',
  'onConversionProgress',
  'onConversionLog',
  'onConversionQueueUpdated',
  'onGPUEncoderError',
  'getPresets',
  'getGpuCapabilities',
  'refreshGpuCapabilities',
  'getSettings',
  'saveSettings',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate',
  'onUpdateState',
  'checkFFmpeg',
  'getVersion',
  'getPlatform',
  'getArch',
  'revealPath',
  'openExternal',
  'getSystemTheme',
  'onThemeChange',
  'onAppMenuAction',
  'setConversionMenuState',
  'minimizeWindow',
  'toggleMaximizeWindow',
  'closeWindow',
  'isWindowMaximized',
  'onWindowMaximizedChanged',
  'resetSettings',
  'restartApp',
  // renames
  'getDefaultSettings',
  'getDistributionChannel',
  // new Tauri surface
  'selectInputFiles',
  'cancelUpdateDownload',
  'setUpdateChannel',
  'logError',
  'startDragging',
  'onDragDropEvent',
];

// v1 methods with no Tauri counterpart; each has a documented replacement.
const REMOVED_V1_METHODS = [
  'getPathForFile',
  'getLicenses',
  'onWindowChromeStyle',
  'getDefaultAdvancedFormatSettings',
  'isUpdatesDisabled',
];

beforeEach(() => {
  invokeMock.mockReset();
});

describe('renderer api surface', () => {
  it('exposes exactly the v1 method list after documented port changes', () => {
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_API_METHODS].sort());
  });

  it('drops the v1 methods the webview cannot honor', () => {
    for (const name of REMOVED_V1_METHODS) {
      expect(Object.keys(api)).not.toContain(name);
    }
  });

  it('replaces getLicenses with the licenses.json asset helper', () => {
    expect(typeof fetchLicenses).toBe('function');
  });

  it('routes new and renamed methods to their Rust command names', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: [] });
    await expect(api.selectInputFiles()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith('select_input_files');

    invokeMock.mockResolvedValueOnce({ ok: true, data: 'github' });
    await expect(api.getDistributionChannel()).resolves.toBe('github');
    expect(invokeMock).toHaveBeenCalledWith('get_distribution_channel');
  });

  it('omits the requestedCodec key for the all-codecs probe', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: { platform: 'darwin' } });
    await api.getGpuCapabilities(null);
    // A null key would fail Rust's FalliblePayload validation; the probe-all
    // request must send no key at all.
    expect(invokeMock).toHaveBeenCalledWith('get_gpu_capabilities', {});
  });

  it('unwraps error envelopes into thrown Errors', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'Settings are not implemented yet.' },
    });
    await expect(api.getSettings()).rejects.toThrow('Settings are not implemented yet.');
  });
});
