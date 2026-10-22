# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                              | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Win-x64-Setup.exe) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Win-arm64-Setup.exe) | **[Universal DMG](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-macOS-universal.dmg)**  | **AppImage:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-x86_64.AppImage) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-arm64.AppImage)         |
| <div align="center"><!--<a href="#"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a>--></div>                                                                                   | **[Universal ZIP](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-macOS-universal.zip)**  | **DEB:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-amd64.deb) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-arm64.deb)                         |
| _See MSI note in releases_                                                                                                                                                                                     |                                                                                                                 | **RPM:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-x86_64.rpm) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-aarch64.rpm)                      |
|                                                                                                                                                                                                                |                                                                                                                 | **Flatpak sideload:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-x86_64.flatpak) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.6.1/CONV2-Linux-aarch64.flatpak) |

### ℹ️ Enjoying CONV2? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## Changes in `v1.6.1:`

- **Fix - FFMPEG:** Fixed an issue where the bundled FFMPEG was not being found by CONV2.
- **Fix - DMG Background:** Fixed an issue where the `DMG` background was black and didn't allow for `CONV2` and the `Applications` folder's text to be seen.

## Changes in `v1.6.0:`

- **FFMPEG:** Updated ffmpeg on _ALL_ platforms to `9.0.2`.
- **CI:** Real FFmpeg payload tests are skipped until those binaries are published for GitHub-hosted runners.
- **Building - FFMPEG:** Release scripts download a replacement payload with `get-ffmpeg` and re-check when checksum verification fails.
- **Security:** Bundled FFmpeg binaries are now checked against the tracked checksum manifest before use, and missing or unsafe binary paths fail closed.
- **Codebase:** Video processing now handles HDR and high-bit-depth sources more safely, including tone-mapping 8-bit outputs and preserving compatible HDR metadata.
- **UI:** FFmpeg failures now show clearer, redacted messages for unreadable inputs, missing video streams, unsupported containers, and encoder errors.
- **Codebase:** Main and renderer flows are now split into focused modules with shared IPC contracts and safer conversion, settings, navigation, quit, and update state handling.
- **Testing:** Added cross-platform Electron end-to-end coverage for accessibility, UI workflows, package contents, and real FFmpeg conversions.
- **Security:** Release uploads now use the GitHub CLI credential store instead of `GH_TOKEN` or `GITHUB_TOKEN` environment secrets.
- **Codebase:** Release tooling now guards destructive branch syncs and skips beta artifact mirroring unless explicitly overridden.
- **Electron:** Updated Electron to `44.9.2`.
- **PKG:** Updated packages.

- **UPDATES:** Switching from a newer beta to **Stable** no longer offers an older release (for example `1.5.1` while on `1.6.0-beta.x`). Downgrades are blocked after channel changes.
- **UPDATES:** If you are on beta and there is no newer beta, CONV2 now checks **stable** and offers it when that release is newer than your current beta.
- **UPDATES:** **Update Available!** now starts the download (instead of only re-checking). A ready install is preserved across background checks, and channel changes clear stale offers and re-check the new feed.
- **UPDATES:** Manual check while an update is already downloaded shows **Update Ready / Restart** instead of falsely saying you are on the latest version.
- **UPDATES:** In-app GitHub updates are disabled for Flatpak, Mac App Store, Microsoft Store, and MSI/managed installs (use the store or `flatpak update` instead).
- **UPDATES:** Windows **Help** menu now includes Check / Install Update (same as the macOS app menu).
- **QUEUE:** Retry / Retry failed can no longer start a second conversion while one is already running.
- **QUEUE:** **Cancel** always asks for confirmation before deleting a partial output (button and menu).
- **SAFETY:** **Trash Original on Success** only runs when the output file exists and is non-empty, and it skips trash if the job was cancelled.
- **OS:** Opening a video by launching CONV2 again on Windows/Linux now adds that file to the queue (second-instance), matching macOS `open-file` behavior.
- **OS:** Microsoft Store builds no longer override the package App User Model ID (fixes toast attribution). macOS notification permission denials are remembered correctly.
- **PACKAGING:** Microsoft Store (AppX) builds now include the bundled FFmpeg resources (they were missing when the Store config replaced the main build config).
- **REMUX:** Remux jobs fail fast with a clear error if the input cannot be probed, instead of continuing blind.
- **SETTINGS:** Saving advanced format options no longer overwrites other in-memory settings; relative output folders are cleared instead of being silently ignored; settings save failures are reported to the UI.
- **Codebase:** Aborting a conversion now stops a live FFmpeg process via `AbortSignal`, not only the global cancel path.
- **Tooling:** CI audits Electron as well as production deps; destructive sync scripts are named `sync:beta:destructive` / `sync:main:destructive` (`b` / `r` remain aliases).

- **UI:** First-launch **setup tour** (skippable, 10 steps with main-window spotlights for files, presets, and Convert); **Skip tour** on every step; **Replay setup tour** in Settings; **Reset settings** + restart shows the tour again.
- **UI:** Custom title bar polish (macOS traffic-light inset, themed border/background); window background syncs with theme and interface style (glass/flat); modals clear the title bar on Win/macOS.
- **UI:** Settings **Appearance** section; batch queue with clearer failures, **Retry failed**, and per-file **Retry**; live **File N of M** text during multi-file jobs.
- **UI:** In-app batch status matches background notification copy via shared `queueSummary` helpers.
- **UI:** GPU panel summary line for Auto mode (recommended vendor + reason); preset search focuses with `/`.
- **UI:** **Trash Original on Success** now asks for confirmation before being enabled and shows an active warning indicator while it is on.
- **QUEUE:** Batch size is now bounded and malformed queue requests are rejected safely.
- **REMUX:** Remuxing an MKV to MP4 no longer fails when the source has subtitles. Text subtitles are converted to the container's format (`mov_text` for MP4, WebVTT for WebM) and attachments that MP4 cannot store are left out. MKV remuxes still copy every stream untouched.
- **REMUX:** Sources that genuinely cannot be remuxed are now explained before the job starts instead of failing partway, including audio the container cannot hold (for example AAC into WebM, which supports only Opus or Vorbis).
- **REMUX:** HEVC remuxed into MP4 is now tagged `hvc1` so it plays in QuickTime, Safari, and on iOS. Previously it was tagged `hev1`, which those players reject.
- **ENCODING:** Advanced AV1 quality values above 51 are clamped for hardware encoders, whose quality parameters stop at 51. CPU encoding keeps the full SVT-AV1 range.
- **ENCODING:** AV1 on Apple silicon now correctly uses CPU arguments, since VideoToolbox has no AV1 encoder.
- **GIF:** Fixed GIF conversion failing outright when **Max Colors** was set to 2. FFmpeg needs at least 3 colors when a transparent palette slot is reserved, so the minimum is now 3 in both the settings and the input field.
- **OS:** Completion notifications mention click-to-reveal when an output path is available (unfocused window).
- **Security:** macOS hardened runtime no longer disables library validation.
- **Privacy:** Debug log redaction now also hides home paths belonging to other user accounts, not just the current user's.
- **Building - FFMPEG:** Downloads are now extracted to a temporary staging directory and checked against the tracked checksum manifest **before** anything is installed into `resources/ffmpeg`, so a failed check leaves the existing binaries untouched. The destination is also cleaned to avoid stale files.
- **Linux:** Both Flatpak build paths now grant identical sandbox permissions, and the Node SDK extension matches the Node version the project builds with. Tests enforce that they stay in sync.
- **Codebase:** Window state is now written atomically, and encoder names come from a single shared map so capability checks and conversions can never disagree.
- **Docs:** README notes native menus and batch queue (no file-type registration), plus a hardware-acceleration support table and how each preset type handles audio, subtitle, and attachment streams.
- **Tooling:** TypeScript 7; CI now covers release-candidate branches and runs the runtime smoke test, config checks, and a coverage gate.
- **Tooling:** New end-to-end test suite that runs every conversion preset through the bundled FFmpeg and checks the resulting streams, rather than only checking the arguments CONV2 builds. It skips automatically when no FFmpeg payload is present, so contributors are never blocked.

**Setup tour (manual QA):** Skip on step 1; finish all steps; Replay from Settings; Reset settings → restart → tour shows again.

- **UI:** Overhauled Dark/Light/Custom themes; preset picker polish; custom title bar on Windows and macOS.
- **QUEUE:** Main-process batch queue with per-file status and CPU fallback in main.
- **OS:** Taskbar/dock progress, notifications, prevent-sleep; Jump List; macOS About, Open Recent, recent-document `open-file` only.
- **Codebase:** `gpuEncoders`, `conversionQueue`, `osIntegration`, `windowChrome`, `applicationMenu`.

## What is CONV2?

### CONV2 is a quick and simple video converter using ffmpeg on the backend which features:

- In-App Updates
- Windows, macOS, and Linux Support
- Minimalist UI
- Minimal Bloat (besides the part that its electron-based)
- Quick Video Presets
- Advanced Settings
- Light and Dark Mode
- And More!

---

### MSI Installer Support

> [!IMPORTANT]
> **Enterprise Users:** We now support Windows X64/ARM64 `.MSI` installers for MDM/AD deployment.
>
> - **.MSI installers do NOT support auto-updates.** You must deploy the new MSI manually.
> - These are strictly for enterprise management; standard users should use the **EXE** above.
> - _Files available in the "Assets" dropdown below._

---

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are fully signed. Windows releases are fully signed using Azure Artifact Signing. Linux releases are GPG signed.

### This changelog is made using the BCLS Standard: https://github.com/BurntToasters/BCLS
