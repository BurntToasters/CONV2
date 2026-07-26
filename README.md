# CONV2

<p align="center">
  <img width="45%" height="1012" alt="CONV2-9-1" src="https://github.com/user-attachments/assets/cd08ca70-4cf4-4070-a865-93edd38a6502" />
&nbsp;
<img width="45%" height="1012" alt="CONV2-9-2" src="https://github.com/user-attachments/assets/68733876-e801-409f-8322-109806c72039" />
</p>

---

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                              | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> MacOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Win-x64-Setup.exe) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Win-arm64-Setup.exe) | **[Universal DMG](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-macOS-universal.dmg)**  | **AppImage:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.AppImage) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-arm64.AppImage)         |
| <div align="center"><!--<a href="#"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a>--></div>                                                                                   | **[Universal ZIP](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-macOS-universal.zip)**  | **DEB:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-amd64.deb) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-arm64.deb)                         |
| _See MSI note in releases_                                                                                                                                                                                     |                                                                                                                 | **RPM:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.rpm) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-aarch64.rpm)                      |
|                                                                                                                                                                                                                |                                                                                                                 | **Flatpak sideload:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.flatpak) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-aarch64.flatpak) |

### ℹ️ Enjoying CONV2? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## What is CONV2?

### CONV2 is a quick and simple video converter using ffmpeg on the backend which features:

- In-App Updates
- Windows, macOS, and Linux Support
- Native **File / Convert / Help** menus on Windows and macOS (no system-wide “Open with CONV2” file registration)
- Multi-file **batch queue** with per-file status in the main window
- Minimalist UI
- Minimal Bloat (besides the part that its electron-based)
- Quick Video Presets
- Advanced Settings
- Light and Dark Mode
- And More!

## What installers are available?

- **Windows**
  - `.EXE`: x64, arm64
    - There are portable `.exe` binaries available but they are experimental.
  - `.MSI`: x64, arm64 (Important! MSI builds have the auto updater permanently disabled as these are meant for enterprise installments!)
- **MacOS** (Intel support may be phased out soon)
  - `.DMG`: Universal
  - `.ZIP`: Universal
- **Linux**
  - `Flatpak sideload`: x64, arm64 (no Flathub publication)
  - `.DEB`: x64, arm64
  - `.RPM`: x64, arm64
  - `.AppImage`: x64, arm64

## Hardware acceleration

CONV2 picks a GPU encoder automatically, or you can choose one in Settings. What is available depends on platform:

| GPU    | Windows                 | macOS                      | Linux                   |
| :----- | :---------------------- | :------------------------- | :---------------------- |
| NVIDIA | NVENC (H.264/H.265/AV1) | n/a                        | NVENC (H.264/H.265/AV1) |
| Intel  | Quick Sync              | n/a                        | Quick Sync              |
| AMD    | AMF                     | n/a                        | **CPU only**            |
| Apple  | n/a                     | VideoToolbox (H.264/H.265) | n/a                     |

Two limits worth knowing:

- **AMD on Linux falls back to CPU encoding.** AMF encoders ship only in Windows FFmpeg builds, so CONV2 switches AMD/Linux jobs to CPU automatically and says so in the app.
- **AV1 on Apple silicon uses the CPU encoder (SVT-AV1),** because VideoToolbox has no AV1 encoder.

## Stream handling

- **Encoding presets** keep the video track and all audio tracks. Subtitles and attachments are not carried into the output.
- **Remuxing to MKV** copies every stream as-is.
- **Remuxing to MP4 or WebM** copies video and audio and converts text subtitles to the container's format (`mov_text` for MP4, WebVTT for WebM). Bitmap subtitles (PGS/DVD/DVB) and attachments are left out, because those containers cannot store them.
- If a source cannot be remuxed at all (for example AAC audio into WebM, which supports only Opus or Vorbis), CONV2 explains this before starting instead of failing partway.

## FFmpeg

Conv2 comes bundled with a platform specific FFMPEG binary. See the source at: https://github.com/BurntToasters/ffmpeg-static-builds

### Want more info? Please visit: [https://help.rosie.run/conv2/en-us/faq](https://help.rosie.run/conv2/en-us/faq)!

---

## Building CONV2

CONV2 is an electronjs application using nodejs/npm for its environment.

- Build scripts are available in the `package.json` file.
- To install all dependencies run `npm i`.
