<!--> [!NOTE]

> 🅱️ This is a Beta build. -->

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                              | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Win-x64-Setup.exe) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Win-arm64-Setup.exe) | **[Universal DMG](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-macOS-universal.dmg)**  | **AppImage:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-x86_64.AppImage) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-arm64.AppImage)         |
| <div align="center"><!--<a href="#"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a>--></div>                                                                                   | **[Universal ZIP](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-macOS-universal.zip)**  | **DEB:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-amd64.deb) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-arm64.deb)                         |
| _See MSI note in releases_                                                                                                                                                                                     |                                                                                                                 | **RPM:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-x86_64.rpm) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-aarch64.rpm)                      |
|                                                                                                                                                                                                                |                                                                                                                 | **Flatpak sideload:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-x86_64.flatpak) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.5.0/CONV2-Linux-aarch64.flatpak) |

### ℹ️ Enjoying CONV2? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## Changes in `v1.5.0:`

- **FFMPEG:** Updated ffmpeg on _ALL_ platforms to `8.1.2`.
- **NEW - Windows code signing:** WOO HOO!! Windows Codesigning is here!
  - After a good while of not having it, Windows Binaries are now signed by Azure Artifact Signing!
- **Building - FFMPEG:** FFMPEG checksums are now enforced.
  - Added a new .env variable and the ability to download FFmpeg binaries from a server: `FFMPEG_DL_SERVER="https://example-download-server.com/ffmpeg/version/"`
  - The naming scheme for the `.7z` binaries is `ffmpeg_os_arch.7z` (macOS uses `macOS`).
  - `npm run get:ffmpeg:all` downloads all architectures and extracts them into the right locations. After independently verifying the new binaries, run `npm run ffmpeg:checksums:generate` to update their checksums.
- **FFMPEG:** Updated bundled FFmpeg wording, notices, and GPL source offer for FFmpeg `8.1.2` across Windows, macOS, and Linux.
- **UI:** Reverted color scheme back to the blue color (I like it better :P).
- **UI:** Self-hosted Inter and Outfit fonts for offline reliability and privacy (removed Google Fonts remote links).
- **UI:** Fixed light-theme muted-text contrast failing WCAG AA (`#7d88a1` → `#5c6880`).
- **UI:** Modal focus is now restored to the triggering element on close (WCAG 2.4.3).
- **UI:** File-input change handler now validates extensions (matching drag-drop behavior).
- **Security:** Removed `'unsafe-inline'` from CSP `style-src` by converting all inline styles to a utility class.
- **Security:** Added explicit `font-src 'self'` to CSP.
- **Codebase:** Unified all `getElementById` calls to use `getRequiredElement` (clear errors on missing DOM elements instead of silent null crashes).
- **Codebase:** Wrapped `getFileInfo` IPC call in `.catch()` to prevent unhandled rejections on file-select.
- **Codebase:** Progress bar `aria-valuenow` is now reset to `0` at the start of each conversion.
- **Linux:** Fixed an issue with linux packaging naming for the electron api.
- **UI:** Updated the experimental interface introduced during the beta cycle.
- **Codebase:** Many fixes to the app and FFmpeg for AMD hardware.

## Changes in `v1.4.1:`

- **macOS:** Fixed an issue where the updater was getting stuck and would not be able to restart the app to complete the update process.
- **Misc:**
  - Edge case fixes.
  - General Improvements.
  - Updated packages.

## Changes in `v1.4.0:`

- **FFMPEG:** Updated bundled `FFMPEG` builds for the v1.4.0 release cycle; current release notes above describe the latest bundled version.
- **UI:** Flat, native-leaning visual refresh across the main window and settings. Dropped purple/cyan gradients, mesh backgrounds, glow, and shimmer in favor of restrained system-blue accents, tighter corner radii, and flatter panels, buttons, and progress bars. Light and dark themes both updated.
- **FFMPEG:** Retuned AV1 CPU presets for better quality and compression efficiency:
  - All CPU AV1 tiers now apply `libsvtav1` tuning (`tune=0`) consistently, not just the best-quality and best-compression tiers.
  - CPU AV1 encodes now default to 10-bit (`yuv420p10le`) for improved compression and reduced banding.
  - CRF defaults adjusted: Best Quality `15` → `18`, Quality `20` → `24`, Small File `40` → `44`.
- **FFMPEG:** Retuned GIF presets to produce much smaller files at comparable quality:
  - Quality tiers now default to ordered `bayer` dithering instead of error-diffusion `sierra2_4a`, so static regions compress better between frames.
  - Reduced default dimensions, frame rates, and palette sizes across all GIF tiers (e.g. Best Quality `1080px` → `720px`, Best Compression `128` colors → `64`).
- **Codebase:** FFmpeg binary path resolution is now lazy-loaded to avoid eager module initialization at startup.
- **Testing:** Expanded preset tests for AV1 10-bit output, consistent `svtav1-params` usage, and updated GIF tier defaults.
- **PKG:** Updated packages.

## Changes in `v1.3.0:`

- **FFMPEG:** Major ffmpeg flag tweaks and improvements.
- **Compression:** Fixed an issue where bitrate args weren't being passed to FFMPEG (causing large file sizes).
- **UI:** New UI! Enjoy a much more info-dense and friendly preset selection UI!
  - Still a WIP. Working on cleaning it up :)
- **Settings:** Fixed an issue with the settings corruption checker where every update would reset settings to default.
- **Icon:** Added multiple resolutions to the .ico file for windows.
- **H265/HEVC:** Fixed an issue where conversions with HEVC may not play on all devices.
- **NEW - QUEUE:** File queuing as now been added to CONV2! Want to batch compress or convert files? Now you can!
- **NEW - GIF support:** CONV2 now supports converting supported media into GIFs!
  - This can be enabled under `Advanced Presets` in settings.
- **NEW - Preset adjustments:** A new advanced settings tab has been added to support power users tweaking the built-in profiles!
- **Codebase:** Major bug fixes and improvements all over the place!
- **PKG:** Updated packages
- **Electron:** Updated electron to `41.2.1`.

## Click below for the full `v1` Changelog

<details>
  <summary>Full v1 changelog</summary>

## Changes in `v1.3.3:`

- **NEW - Window State Persistence:** CONV2 now saves and restores window size, position, and maximized state between sessions. The saved position is validated against connected displays before restoring, so the window won't open off-screen after disconnecting a monitor.
- **NEW - Drag-Drop Validation:** Files dropped onto the drop zone are now checked against the list of supported video extensions before processing. Unsupported file types are rejected immediately with a helpful error message instead of silently failing.
- **FFMPEG:** Fixed progress parsing not handling `MM:SS` and bare-seconds time formats, which some FFmpeg builds emit during conversion.
- **FFMPEG:** Fixed AVI H.264 CPU encodes missing the `-pix_fmt yuv420p` flag, which could produce output files with incompatible pixel formats.
- **Settings:** Fixed stale `.tmp` files left on disk by a previous crash not being cleaned up at startup. Corrupt settings files are now backed up with a timestamped filename before being reset to defaults, instead of being silently discarded.
- **Security:** Log output sent to the renderer now replaces the user's home directory path with `~`, preventing the system username from appearing in shared screenshots or debug logs.
- **Codebase:** Multiple reliability and performance improvements to the FFmpeg backend:
  - Added a 30-second TTL cache for the FFmpeg availability check to avoid repeated process spawns.
  - Added timeouts to `ffprobe` calls (30s) and encoder/decoder list queries (15s) to prevent hangs if FFmpeg stalls.
  - Fixed a race where concurrent encoder/decoder list requests could spawn multiple FFmpeg processes before the cache was populated; results are now deduplicated with an in-flight Promise guard.
  - Fixed the cancel conversion force-kill timer always firing 1.5 seconds after cancellation even when the process had already exited; the timer is now cleared immediately in the process exit handler.
  - The `save-settings` IPC handler now logs a warning for any unknown fields sent by the renderer, making stale or mismatched field names easier to catch.
- **Testing:** Expanded test coverage for progress parsing edge cases (MM:SS and bare-seconds formats), AVI H.264 pixel format correctness, and path redaction.

## Changes in `v1.3.2:`

- **Conversion presets & Hardware Acceleration:** Multiple updates and tweaks:
  - **Conversion:** Tweaked UI/UX.
  - **Conversion:** Recent now shows which format was used under the preset name.
  - **Conversion:** More FFMPEG Flags added.
  - **HW Accel:** Added a new detection module at startup that detects what GPUs a user has on their computer.
  - **HW Accel:** Blocks usage of certain GPU options if a selected format is not compatible with the user's GPU.
- **NEW - DEBUG Settings Tab:**
  - Moved `System FFMPEG` setting option to debug tab.
  - Moved `Debug Logs` setting option to debug tab.
  - Added Show ALL GPU Vendors option.
    - This setting will show all potential GPU options regardless of what the user has installed.
- **NEW - Trash Original on Success:** A new option in settings has been added to trash the original video file after a successful conversion (off by default).
- **NEW - CPU Decoding with GPU Encode:** A new option in settings has been added to move decoding tasks to the CPU and let the GPU handle encoding only.
  - This is useful if a user is playing a video game for example to distribute computer resources more efficiently under heavy load.
- **Misc:**
  - **PKG:** Updated packages.
  - **FFMPEG:** Fixed multiple issues with FFMPEG in macOS.
  - **Codebase:** Multiple stability fixes and edge-case error handling.

## Changes in `v1.2.0:`

- **Presets:** More preset options! New additions to `H265/HEVC` and `AV1` allow for best quality and compression or best compression to comperable quality!
- **UI:** The UI has been changed again to a much better on the eyes flatter design.
- **Settings:** The settings UI has been re-written to utilize more horizontal space.
- **Updater:** Added the ability to switch between `STABLE` and `BETA` releases or choose `AUTO` (default).
  - Auto uses what ever update channel you are on by what version you installed. EX: `v1.2.0` -> STABLE **|** `v1.2.0-beta.1` -> BETA.
- **Advanced presets:** Added more presets which can be shown by toggling `Advanced Presets` on in settings.
- **PKG:** Updated packages.
- **Electron:** Updated electron to `41.2.0`.

## Changes in `v1.1.0`

### Major: FFMPEG Binaries are now included in CONV2!

No need to worry about finding your own ffmpeg binaries for your operating system, all requirements for CONV2 are now bundled with it!

- **Flatpak:** Flatpak support has been added!
- **PKG:** Updated all packages (Electron is now on `40.6.0`).

To learn more about the FFMPEG builds please go to: https://github.com/BurntToasters/ffmpeg-static-builds/

---

</details>

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

### MSI Installer Support (MSI builds are NOT provided for betas)

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
