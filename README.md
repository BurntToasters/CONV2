# CONV2
<p align="center">
  <img width="45%" height="1012" alt="CONV2-9-1" src="https://github.com/user-attachments/assets/cd08ca70-4cf4-4070-a865-93edd38a6502" />
&nbsp;
<img width="45%" height="1012" alt="CONV2-9-2" src="https://github.com/user-attachments/assets/68733876-e801-409f-8322-109806c72039" />
</p>

---
# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> MacOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **[Universal EXE (x64/arm64)](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Win.exe)** | **[Universal DMG](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.AppImage) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-arm64.AppImage) |
| <div align="center"><!--<a href="#"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a>--></div> | **[Universal ZIP](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-MacOS-universal.zip)** | **DEB:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-amd64.deb) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-arm64.deb) |
| *See MSI note in releases* | | **RPM:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.rpm) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-aarch64.rpm) |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-x86_64.flatpak) / [arm64](https://github.com/BurntToasters/CONV2/releases/latest/download/CONV2-Linux-aarch64.flatpak) |

### ℹ️ Enjoying CONV2? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## What is CONV2? 
### CONV2 is a quick and simple video converter using ffmpeg on the backend which features:
* In-App Updates
* Windows, MacOS, and Linux Support
* Minimalist UI
* Minimal Bloat (besides the part that its electron-based)
* Quick Video Presets
* Advanced Settings
* Light and Dark Mode
* And More!

## What installers are available?
* **Windows**
  * `.EXE`: x64, arm64
    * There are portable `.exe` binaries available but they are experimental.
  * `.MSI`: x64, arm64 (Important! MSI builds have the auto updater permanently disabled as these are meant for enterprise installments!)
* **MacOS** (Intel support may be phased out soon)
  * `.DMG`: Universal
  * `.ZIP`: Universal
* **Linux**
  * `Flatpak`: x64, arm64
  * `.DEB`: x64, arm64
  * `.RPM`: x64, arm64
  * `.AppImage`: x64, arm64

## FFmpeg
Conv2 comes bundled with a platform specific FFMPEG binary. See the source at: https://github.com/BurntToasters/ffmpeg-static-builds

### Want more info? Please visit: [https://help.rosie.run/conv2/en-us/faq](https://help.rosie.run/conv2/en-us/faq)!
---



## Building CONV2
CONV2 is an electronjs application using nodejs/npm for its environment.
* Build scripts are available in the `package.json` file.
* To install all dependencies run `npm i`.
