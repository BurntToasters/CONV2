# CONV2

<p align="center">
  <img width="45%" height="1012" alt="CONV2-9-1" src="https://github.com/user-attachments/assets/cd08ca70-4cf4-4070-a865-93edd38a6502" />
&nbsp;
<img width="45%" height="1012" alt="CONV2-9-2" src="https://github.com/user-attachments/assets/68733876-e801-409f-8322-109806c72039" />
</p>

---

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                              | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> MacOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux         |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| **Setup:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Win-x64-Setup.exe) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Win-arm64-Setup.exe) | **[Universal DMG](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-macOS-universal.dmg)**  | **AppImage:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.AppImage)        |
| <div align="center"><!--<a href="#"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a>--></div>                                                                                   | **[Universal ZIP](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-macOS-universal.zip)**  | **Flatpak sideload:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.flatpak) |
| _Also on the Microsoft Store_                                                                                                                                                                                  |                                                                                                                 |                                                                                                                         |

### ℹ️ Enjoying CONV2? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## What is CONV2?

### CONV2 is a quick and simple video converter using FFmpeg, which features:

- In-app updates with signed, verified downloads
- Windows, macOS, and Linux support
- 28 conversion presets: AV1, H.264, H.265, AVI, GIF, animated WebP, remux, and audio extraction
- Multi-file **batch queue** with per-file status, retry, and cancel
- Hardware encoding with automatic CPU fallback
- Advanced per-format quality settings
- A native menu on macOS
- Light, dark, and custom themes
- Built on [Tauri 2](https://tauri.app): small installers and low memory use

## What installers are available?

- **Windows**
  - Setup (`.exe`, NSIS): x64, arm64
  - Microsoft Store (stable releases)
- **macOS** (macOS 15 or later)
  - `.DMG` and `.ZIP`: universal, arm64, and x64
- **Linux**
  - `.AppImage`: x64
  - Flatpak sideload: x64 (no Flathub publication)

## Upgrading from CONV2 1

CONV2 2 is a new application (`run.rosie.conv2`). CONV2 1 cannot update itself
into it; the final CONV2 1 release offers a guided upgrade. On first launch,
CONV2 2 imports your CONV2 1 settings, window position, and GPU cache. The old
data is never modified.

## Hardware acceleration

CONV2 picks a GPU encoder automatically, or you can choose one in Settings. A GPU encoder is used only when it passes a check on your system. If it is missing or fails to start, CONV2 converts on CPU instead and says so in the app.

| GPU      | Encoder          | Platform       | Requirements                                                   |
| :------- | :--------------- | :------------- | :------------------------------------------------------------- |
| NVIDIA   | NVENC            | Windows x64    | Driver 531.61 or newer                                         |
| NVIDIA   | NVENC            | Linux          | Driver 530.41 or newer                                         |
| Intel    | Quick Sync       | Windows x64    | Intel graphics driver                                          |
| Intel    | VAAPI            | Linux          | `intel-media-va-driver` (or `intel-media-driver`) and `libva2` |
| AMD      | AMF              | Windows x64    | AMD graphics driver                                            |
| AMD      | VAAPI            | Linux          | `mesa-va-drivers` and `libva2`                                 |
| Qualcomm | Media Foundation | Windows on Arm | Qualcomm graphics driver                                       |
| Apple    | VideoToolbox     | macOS          | H.264 and H.265 only                                           |

NVENC, AMF and Quick Sync cover H.264, H.265 and AV1 where the GPU supports them. Each codec is checked separately.

Notes:

- **Windows on Arm** (Snapdragon) has no NVENC, AMF or Quick Sync, so the NVIDIA, Intel and AMD rows do not apply there. Qualcomm's Media Foundation encoders are the hardware path.
- **Qualcomm output is 8-bit.** Media Foundation hardware encoders take only 8-bit NV12, so 10-bit and HDR sources are converted to 8-bit SDR. HDR sources are tone-mapped.
- **AV1 on Apple silicon uses the CPU encoder (SVT-AV1),** because VideoToolbox has no AV1 encoder.

## Stream handling

- **Encoding presets** keep the video track and all audio tracks. Subtitles and attachments are not carried into the output.
- **Animated GIF and WebP presets** (`webp-*` presets are animated WebP) write video only, with no audio or subtitles. They never upscale a small source or duplicate frames: the frame rate is capped at the source's rate and the size only shrinks.
- **Remuxing to MKV** copies every stream as-is.
- **Remuxing to MP4 or WebM** copies video and audio and converts text subtitles to the container's format (`mov_text` for MP4, WebVTT for WebM). Bitmap subtitles (PGS/DVD/DVB) and attachments are left out, because those containers cannot store them.
- If a source cannot be remuxed at all (for example AAC audio into WebM, which supports only Opus or Vorbis), CONV2 explains this before starting instead of failing partway.

## FFmpeg

CONV2 bundles a platform-specific FFmpeg and FFprobe, verified against a
checksum manifest before every run. See the source at: https://github.com/BurntToasters/ffmpeg-static-builds

### Want more info? Please visit: [https://help.rosie.run/conv2/en-us/faq](https://help.rosie.run/conv2/en-us/faq)!

---

## Building CONV2

CONV2 is a Tauri 2 application: a TypeScript frontend (Vite) and a Rust backend.

- Prerequisites per platform are in [build-setup.md](build-setup.md).
- Install dependencies with `npm ci`, then fetch FFmpeg with `npm run get:ffmpeg`
  (needs `FFMPEG_DL_SERVER`) or use `npm run prepare:rust-tests` for stubs.
- Run the app with `npm run tauri:dev`; build without bundling with
  `npx tauri build --no-bundle`.
- Scripts are listed in `package.json`. How the code fits together is in
  [ARCHITECTURE.md](ARCHITECTURE.md), and the release process is in
  [docs/RELEASE-STABLE.md](docs/RELEASE-STABLE.md).

### Tests

- `npm run test:all` is the full quality gate.
- `npm run test:e2e` drives the real app through WebdriverIO: every preset is
  converted and verified with FFprobe, plus batch, cancel, settings, UI failure
  modes, accessibility in four themes, and the CONV2 1 import. It writes a
  hash-bound evidence report to `e2e/artifacts/`. `npm run test:e2e:core` runs a
  fast subset.

### CI

GitHub Actions runs on pull requests and pushes to `main` and `beta`, and weekly
for security and the live updater feed. A pull request into `main` must be a
`next-*` promotion or a `release/*` metadata change. Run `npm run test:all` and
`npm run test:e2e` locally before opening a promotion pull request.
