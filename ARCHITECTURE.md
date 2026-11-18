# Architecture

CONV2 is a [Tauri 2](https://tauri.app) app: a vanilla TypeScript, HTML and CSS
frontend driving a Rust backend that runs two bundled sidecars, FFmpeg and
FFprobe.

```
frontend (src/, TS)  --invoke()-->  Rust commands (src-tauri/src/)  --spawn-->  conv2-ffmpeg / conv2-ffprobe
        ^                                   |
        +---------- events -----------------+   (conversion-progress, conversion-queue-updated, ...)
```

## Backend (`src-tauri/src/`)

`main.rs` is glue only: plugins, the command registry, and run-loop events.

| Module                                       | Responsibility                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversion.rs`                              | The single-owner conversion queue: validation, the batch runner, cancel, and `is_active()`. Publishes `conversion-queue-updated`, `conversion-progress` (throttled), and `conversion-log` |
| `command_builders.rs`                        | The 28 presets, advanced-format quality tiers, and per-preset FFmpeg arguments                                                                                                            |
| `video_pipeline.rs`                          | HDR, color, rotation, and scaling filter graphs                                                                                                                                           |
| `ffmpeg_args.rs`                             | Argument helpers and collision-free output names (`<base>_converted[_N].<ext>`)                                                                                                           |
| `ffmpeg_progress.rs`                         | `-progress` parsing                                                                                                                                                                       |
| `ffmpeg_failure.rs`                          | Failure classification and the hardware-to-software retry decision                                                                                                                        |
| `ffmpeg_status.rs`                           | Sidecar location, checksum verification, and the `check_ffmpeg` verdict                                                                                                                   |
| `media_info.rs`                              | FFprobe metadata for the file list and preflight                                                                                                                                          |
| `gpu.rs`                                     | Hardware encoder detection by probing FFmpeg, with an on-disk cache                                                                                                                       |
| `settings.rs`                                | Settings model (schema 7), migration, atomic writes, partial merge                                                                                                                        |
| `legacy.rs`                                  | First-launch import of CONV2 1 data (see below)                                                                                                                                           |
| `window_state.rs`                            | Window bounds persistence with off-screen and oversize clamping                                                                                                                           |
| `window.rs`                                  | Hidden main window, deferred reveal, close confirmation, restart                                                                                                                          |
| `app_menu.rs`                                | Native macOS menu, `app-menu-action` events, and item enablement                                                                                                                          |
| `platform.rs`                                | Platform queries, distribution channel, file and folder pickers, open and reveal                                                                                                          |
| `os_integration.rs`                          | Taskbar and Dock progress, sleep inhibition, completion notifications                                                                                                                     |
| `updater.rs`                                 | Update engine: one state thread owns channels, checks, downloads, and installs                                                                                                            |
| `validation.rs`                              | Security boundary: path and URL checks for IPC inputs                                                                                                                                     |
| `process_util.rs`                            | Scrubbed environment, process groups, tree termination, bounded output capture                                                                                                            |
| `fs_util.rs`                                 | Atomic writes, bounded reads, and SHA-256 helpers                                                                                                                                         |
| `ipc.rs`, `types.rs`                         | `{ ok, data } \| { ok: false, error }` envelopes and the shared camelCase model                                                                                                           |
| `app_state.rs`, `constants.rs`, `logging.rs` | Process-wide handles, shared flags, and the rolling `logs/conv2.log`                                                                                                                      |

Persisted state lives in the app data directory for `run.rosie.conv2`:
`settings.json`, `windowState.json`, `gpu-probe-cache.json`,
`legacy-v1-import.json`, and `logs/conv2.log`.

### Conversion flow

`start_conversion_queue` is an async command that resolves when the whole batch
ends, as the v1 handler did. The batch runs on the blocking pool, so a long
queue never occupies an async worker. The queue state has one owner. Every
change publishes a snapshot, and the command's answer equals the last snapshot.
Output goes to the request folder, then the settings folder, then the input's
own folder. A cancelled or failed file leaves no partial output.

### CONV2 1 import

On first launch, when the data folder has no `settings.json`, `legacy.rs`
searches the Electron `userData` folder (`%APPDATA%\conv2`,
`~/Library/Application Support/conv2`, `$XDG_CONFIG_HOME/conv2`, and the
Microsoft Store package folder). It copies window state and the GPU cache, then
settings last, so an interrupted import retries on the next launch. The result
is recorded in `legacy-v1-import.json`. The v1 folder is never modified.

## Frontend (`src/`)

- `commands.ts` is the typed map of Rust commands and the only caller of
  `invoke()`. `src/tests/commands.contract.test.ts` checks its names against
  `src-tauri/build.rs` and the main window capability.
- `api.ts` is the renderer API object built on `commands.ts` and Tauri events.
  Callers use `api.method(...)` at call time, so a replaced method is seen
  everywhere. The E2E hook relies on this to stub file dialogs.
- `main.ts` is the Vite entry point. `conv2Engine.ts` is the renderer
  controller; `queueView.ts`, `presetPickerModel.ts`, `setupWizard.ts`,
  `modals.ts`, `status.ts`, and `fileSelection.ts` hold its feature logic.
- `generated/ipc-types.ts` is rendered from the Rust types by the `ts_bindings`
  test, which fails when the file is stale. Refresh it with
  `CONV2_UPDATE_IPC_TYPES=1 cargo test ts_bindings`.
- `e2e-hook.ts` compiles only into unpackaged E2E builds and exposes
  `window.__CONV2_E2E__` with the `api` object and test helpers.
- `public/` holds files served as-is: the theme init script and generated
  license data.

## Sidecars and releases

`scripts/prepare-sidecars.js` verifies and stages `conv2-ffmpeg` and
`conv2-ffprobe`. `src-tauri/build.rs` re-verifies them against a SHA-256
manifest and rejects development stubs in release builds. The release pipeline
(`scripts/run-release.js`, `release-session.js`, `gpg-sign.js`,
`verify-release-draft.js`, `publish-release.cjs`) is described in
[build-setup.md](build-setup.md) and [docs/RELEASE-STABLE.md](docs/RELEASE-STABLE.md).

The vendored `src-tauri/vendor/tauri-plugin-updater` carries install-safety
patches, documented in its `PATCHES.md` and reproduced by `CONV2.patch`.

### Compact macOS updates

Fresh installs use the universal DMG or ZIP. In-app updates on macOS download a
per-architecture `CONV2-{aarch64,x86_64}.app.tar.zst` instead of the universal
archive. `scripts/pack-macos-updater-zst.js` repacks each per-arch app archive
with `zstd --long=27` and signs it. `scripts/gpg-sign.js` publishes them under
`latest-darwin[-beta]-{arch}-app-zst.json`, and the universal feed stays as the
fallback. A process running under Rosetta requests the native `aarch64` feed.
`npm run test:e2e:updater-zst` checks the real archives (needs a universal
build).

## Testing

- E2E (`npm run test:e2e`): WebdriverIO drives an unpackaged `--features e2e`
  build through the real IPC, the bundled FFmpeg, and the real UI. It converts
  every preset and verifies each output with FFprobe, covers batch, cancel,
  naming, settings, 16 UI failure modes, axe accessibility in four themes,
  screenshots, and the CONV2 1 import. It writes a hash-bound evidence report
  to `e2e/artifacts/`. `npm run test:e2e:core` runs a fast subset.
- Rust unit tests (`cargo test`) cover pure logic such as argument building,
  settings migration, and the updater state machine.
- Vitest with jsdom covers the renderer contracts in `src/tests/`.
- `npm run test:all` is the full quality gate.
