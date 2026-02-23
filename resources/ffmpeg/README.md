# FFmpeg Binaries

The FFmpeg binaries are not included in the repository due to size constraints.

## Download Sources

| Platform | Source | Build Type |
|----------|--------|------------|
| Windows | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) | GPL (n8.0 release) |
| Linux | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) | GPL (n8.0 release) |
| macOS | [osxexperts.net](https://www.osxexperts.net/) | GPL |

## Required Structure

```
resources/ffmpeg/
├── NOTICE.txt
├── README.md
├── win/
│   ├── x64/
│   │   ├── ffmpeg.exe
│   │   └── ffprobe.exe
│   └── arm64/
│       ├── ffmpeg.exe
│       └── ffprobe.exe
├── mac/
│   ├── x64/
│   │   ├── ffmpeg
│   │   └── ffprobe
│   └── arm64/
│       ├── ffmpeg
│       └── ffprobe
└── linux/
    ├── x64/
    │   ├── ffmpeg
    │   └── ffprobe
    └── arm64/
        ├── ffmpeg
        └── ffprobe
```

## Notes

- Use **GPL builds** (not LGPL) if you need x264/x265 support
- Use **static builds** (not shared) for easier bundling
- Ensure binaries have execute permissions on macOS/Linux (`chmod +x`)
