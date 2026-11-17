# ⬇️ Downloads

<!--
> [!NOTE]
> 🅱️ This is a Beta
-->

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                              | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-Win-x64-Setup.exe) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-Win-arm64-Setup.exe) | **[Universal DMG](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-macOS-universal.dmg)**  | **AppImage:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-Linux-x86_64.AppImage) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-Linux-arm64.AppImage)         |
| <div align="center"><!--<a href="#"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a>--></div>                                                                                   | **[Universal ZIP](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-macOS-universal.zip)**  | **Flatpak sideload:** [x64](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-Linux-x86_64.flatpak) / [arm64](https://github.com/BurntToasters/CONV2/releases/download/v1.7.0/CONV2-Linux-aarch64.flatpak) |
| _See MSI note in releases_                                                                                                                                                                                     |                                                                                                                 |                                                                                                                                                                                                                                |

### ℹ️ Enjoying CONV2? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## Changes in `v1.7.0:`

- **NEW - Animated WebP:** Added four animated WebP presets (`Best Quality`, `Quality`, `Balanced`, `Best Compression`), with their own tuning tab in advanced format settings for frame rate, max size, quality, and loop mode.
- **NEW - Linux GPU Encoding:** Intel and AMD GPUs on Linux now encode through VAAPI instead of falling back to CPU. This needs the VA driver for your GPU (`intel-media-va-driver` or `mesa-va-drivers`) and `libva2`.
- **NEW - Qualcomm GPU Encoding:** Added Qualcomm Media Foundation hardware encoding on Windows on Arm (Snapdragon). Output is 8-bit, so HDR sources are tone-mapped to SDR.
- **UI:** GPU encoders are now checked per codec on your system, and CONV2 falls back to CPU and tells you when one is missing or fails to start.
- **UI:** GIF and WebP presets no longer upscale small sources or duplicate frames. The frame rate is capped at the source's rate and the size only shrinks.
- **UI:** The GIF frame rate is now capped at `50` fps, since browsers misplay GIF frames above that.
- **Codebase:** The default AV1, H.265, and AVI quality tiers now use faster encoder presets. Tiers you never changed are moved to the new defaults automatically; tiers you customized are kept.
- **Codebase:** Updated the default x265 and SVT-AV1 tuning parameters. AVI keeps its previous x265 parameters.
- **Codebase:** H.265 tiers that use the advanced x265 parameters (Best Quality and Best Compression by default) now encode 10-bit output on CPU, even from 8-bit sources.
- **Fix - Audio:** Fixed an issue where surround sources with layouts like `5.1(side)` or `7.1(wide)` failed to encode to Opus.
- **Fix - Audio:** Fixed an issue where only the first audio track got a proper bitrate. Each surround track now gets a bitrate scaled to its channel count.
- **FFMPEG:** Updated the bundled FFMPEG binaries on _ALL_ platforms.
- **Linux:** Moved the Flatpak to the GNOME `51` runtime.
- **Linux:** Flatpak sideload bundles for x64 and arm64 are now published with every release.
- **Linux:** `.deb` and `.rpm` packages are no longer published. Use the AppImage or the Flatpak sideload.
- **Codebase:** Migrated the toolchain to Node.js `26.13.0` LTS and updated the CI actions.
- **Codebase:** Added `npm run get:ffmpeg:update` to pull new FFMPEG builds for all platforms and regenerate the checksum manifest, restoring the previous files if anything fails.
- **Testing:** Added coverage for WebP, VAAPI, Qualcomm, surround audio, and settings-migration paths, including real FFMPEG end-to-end conversions.
- **Testing:** The release E2E gate now blocks a release when CONV2 cannot open a window on macOS, Windows, or Linux with a display. A headless Linux builder with no display still warns and skips.
- **Tooling:** Beta releases accept `--skip-check` without the extra confirmation variable. Stable releases stay protected.

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
