# Build prerequisites for CONV2

## Windows

- Windows 10 or 11, x64 or ARM64
- PowerShell 7.x
- Visual Studio 2022 or 2026 Build Tools with the C++ workload (x64 and ARM64)
  and the "C++ Clang Compiler for Windows" component
  (`Microsoft.VisualStudio.Component.VC.Llvm.Clang`). `ring` (through the
  updater's TLS stack) needs clang to build for `aarch64-pc-windows-msvc`.
  Build from a VS developer shell (`npm run win-compiler:arm64` or
  `win-compiler:x64`), which puts that clang on `PATH`.
- Node.js `^24.22.1 || >=26.13.0` (`engines.node` in package.json)
- Rust (rustup)
- Azure Artifact Signing: once per release machine, as Administrator, run
  `npm run setup:win:artifact-signing`

The only public Windows installer is NSIS (x64 and arm64). MSI and Portable
packages are retired.

## macOS

- macOS 15 or later. `minimumSystemVersion` in `tauri.conf.json` is 15.0
  because the bundled FFmpeg is built for macOS 15; `build:mac:zip` checks the
  minimum OS of each required architecture slice against that floor.
- Xcode Command Line Tools (`lipo`, `codesign`, `notarytool`)
- zstd CLI (`brew install zstd`) for the updater archives, checked by
  `npm run prerelease:prepare`
- Node.js `^24.22.1 || >=26.13.0`
- Rust (rustup)

macOS builds produce the universal package or native arm64 and x64 packages.
`npm run build:mac:universal` builds the universal DMG and app, then
`npm run build:mac:zip` verifies the signed app and creates its ZIP.
`npm run build:mac:native` builds each native app once with its DMG and updater
archive, then creates architecture-matched ZIPs. Individual prepared targets
are `build:mac:arm64:prepared` and `build:mac:x64:prepared`; run the matching
`build:mac:zip:arm64` or `build:mac:zip:x64` afterwards. Native apps and the
FFmpeg and FFprobe binaries must be thin for their target. Every public
installer is named `CONV2-macOS-{arm64,x64,universal}.{dmg,zip}`.

The Mac App Store is not part of 2.0. It is tracked in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Linux

- Build the public AppImage on Ubuntu 24.04, the oldest supported glibc
  baseline.
- `npm run setup:deb` installs the Ubuntu build, E2E (xvfb), 7-Zip (for
  `get:ffmpeg`), and Flatpak prerequisites.
- Node.js `^24.22.1 || >=26.13.0`
- Rust (rustup)
- The Flatpak (`run.rosie.conv2`) uses the GNOME 51 runtime
  (`org.gnome.Platform//51`) and the matching 26.08 SDK extensions.
- Public releases ship x64 only (`npm run release:linux:x64`): an AppImage and
  a Flatpak sideload bundle. The arm64 wiring (`release:linux:arm64`,
  `build:linux:arm64`) stays for future use and is not part of the release
  matrix.

## Rust toolchain policy

CONV2 builds with the Rust version pinned in `rust-toolchain.toml`, used by CI,
Flatpak, and release builds. Install that exact toolchain before building:

```sh
npm run rust:update
```

## Bundled sidecars

Tauri ships two `externalBin` sidecars next to the CONV2 executable:
`conv2-ffmpeg` and `conv2-ffprobe`. `npm run prepare:sidecars` copies them into
`src-tauri/binaries/` under Tauri's `<name>-<target-triple>` names after
verifying every source binary.

FFmpeg binaries are never committed. `npm run get:ffmpeg` downloads them from
`FFMPEG_DL_SERVER` (see `.env.example`) into `resources/ffmpeg/`, and they are
verified against `resources/ffmpeg/checksums.json`. The universal macOS sidecar
is merged with `lipo`. `workspace:bootstrap` (and so every `release:*` command)
runs `npm run ffmpeg:ensure`, which fetches only the missing host targets, so
each release machine needs `FFMPEG_DL_SERVER` in `.env` and 7-Zip (`7zz` or
`7z` on `PATH`, or the default 7-Zip install on Windows).

When the FFmpeg builder publishes new binaries, run `npm run get:ffmpeg:update`.
It backs up `resources/ffmpeg/`, downloads all six targets, regenerates and
re-verifies the checksums, prints the hash diff, and restores the backup on any
failure or Ctrl+C. Cross-check a few hashes, then commit
`resources/ffmpeg/checksums.json`.

`npm run prepare:rust-tests` (development and CI) writes non-functional FFmpeg
stubs when FFmpeg is absent. `build.rs` re-hashes the prepared sidecars and
fails release-profile builds that contain stubs, and `scripts/gpg-sign.js`
refuses to sign them. `CONV2_ALLOW_STUB_SIDECARS=1` exists only for the CI
compile smoke and is rejected for stable releases.

## Updater signing key

`src-tauri/tauri.conf.json` carries the updater public key in
`plugins.updater.pubkey`. It currently holds the placeholder
`REPLACE_WITH_CONV2_MINISIGN_PUBKEY`, so no release can be signed until the
real key is generated:

```sh
npx tauri signer generate -w ~/.tauri/conv2.key
```

Put the printed public key in `plugins.updater.pubkey`, and set
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `.env`
on every release machine. `release:sign:gpg` checks each `.sig` against the
configured public key, so a mismatched key fails before anything is uploaded.
Keep the key distinct from any other project's.

## License notice audit

`npm run licenses:cargo` writes the packaged Cargo license data and an exact
unresolved-package report. Every prerelease and stable release runs
`npm run release:licenses`, which uses `licenses:cargo:strict` and fails until
every dependency has a verified license notice.

## Verify the toolchain

```sh
npm ci
npm run prepare:rust-tests
npm run test:all
npx tauri build --no-bundle
```

CI runs tests and checks only. It must never invoke `release:*` scripts or
build release binaries; signed bundles are produced on isolated build machines.

## Release artifact freshness

The `npm run release:win`, `release:mac`, and `release:linux:x64` entry points
prepare locked dependencies, run the release-machine gate with GUI E2E skipped,
remove old bundles, and create a commit- and environment-bound build session.
The exact release commit must already have passed the complete `test:all` gate
with E2E enabled in protected CI or a clean proving checkout.

If `npm run release:prepare` was run separately and succeeded, use the matching
`release:win:resume`, `release:mac:resume`, or `release:linux:x64:resume`.
Resume still runs the branch and upstream preflight and refuses sessions from a
different commit, version, lockfile, platform, architecture, or toolchain, and
sessions older than 24 hours.

For a beta recovery where one platform already built the same version before
the release branch advanced, pass `--skip-check` to bypass only the draft's
exact target-commit check, for example `npm run release:mac -- --skip-check`.
Stable releases reject this override.

Windows creates the draft release (`release:draft`); macOS and Linux wait for
it (`release:wait-draft`).

## CONV2 1 update feed

CONV2 1's electron-updater reads `latest.yml`, `latest-mac.yml`, and
`latest-linux.yml` from the newest GitHub release, beta or stable. Without them,
CONV2 1 users see update errors, so every 2.x release must carry them.
`release:win:continue` runs `npm run release:legacy-v1-feed` right after
`release:draft`. It copies the feed files of the v1 release named in
`legacy-v1-feed.json` (`sourceTag`), rewrites every download URL to
`../<sourceTag>/<file>` so it resolves to that v1 release, and uploads them to
the draft. `release:verify:draft` fails if a file is missing or points
elsewhere, and `release:publish` checks that every referenced v1 file exists
with the listed size.

- Check without uploading:
  `npm run release:legacy-v1-feed -- --dry-run --check-urls`.
- When the final v1 bridge release ships, set `sourceTag` to it and refresh the
  current latest v2 release:
  `npm run release:legacy-v1-feed -- --release vX.Y.Z --allow-published`. This
  replaces only the feed files.
- Publish any v1 release made after v2 is live with "Set as the latest
  release" turned off. Otherwise `/releases/latest` points at v1 and the v2
  updater endpoints break.

Flatpak packaging exports the exact clean `HEAD` tree, plus the verified Linux
FFmpeg binaries (never committed), into an ignored staging directory. Commit
the intended release state before running `npm run flatpak:bundle`.

Updater manifests are generated only after each Tauri Minisign signature has
been matched to its artifact with the public key in `tauri.conf.json`. The
manifests are schema-validated before upload.

The `b`, `r`, and `release:*` scripts reset and clean their Git worktrees. Run
them only on disposable, isolated build machines. `b` and `r` run without
confirmation, and `release:finalize` has no guard either, so run it only from a
checkout with nothing uncommitted. Before publishing, verify that the draft
holds the Windows x64 and arm64 NSIS installers, native arm64 and x64 plus
universal macOS DMG and ZIP packages, the Linux x64 AppImage and Flatpak,
updater manifests and signatures, SHA-256 lists, and GPG detached signatures
(`npm run release:verify:draft`).

## Microsoft Store

The Store package is an MSIX bundle under the existing Partner Center product,
identity `BurntToasters.CONV2`. It is not an NSIS installer.

Setup (Windows release machine with the Windows SDK, which provides
`makeappx.exe`). Put these in `.env` (see `.env.example`):

- `MSSTORE_IDENTITY_NAME=BurntToasters.CONV2`
- `MSSTORE_PUBLISHER=CN=BC0CB990-55E8-4580-97B7-1E2DAA4B44F6`
- `MSSTORE_PUBLISHER_DISPLAY_NAME=BurntToasters`

Commands:

- `npm run build:msstore` builds both architectures and writes
  `msstore/CONV2_<X.Y.Z>.0.msixbundle`.
- `npm run build:msstore:x64` or `build:msstore:arm64` builds one architecture
  and writes only its `.msix`, for local testing.
- `npm run build:msstore:win:x64` (or `:arm64`, `:win`) builds only the Store
  exe, with no packaging.

The top-level `build:msstore*` commands run `sync-version`, `licenses`, and
`prepare:sidecars` first. The exe is built with `tauri build --no-bundle` and
`CONV2_DISTRIBUTION_CHANNEL=msstore`, which turns the in-app updater off.
`scripts/msstore-pack.js` copies the exe, the two sidecars
(`conv2-ffmpeg.exe`, `conv2-ffprobe.exe`), and the `bundle.resources` notices
into a pack folder, renders `src-tauri/msstore-assets/AppxManifest.xml`, and
runs `makeappx`. It refuses to pack when a sidecar is missing, is a development
stub, or does not match the prepared sidecar manifest.

Version rules:

- Store packages are stable only. A prerelease such as `2.0.0-beta.1` is
  refused. `--allow-prerelease` is for local packaging tests only, and its
  output says so. Never submit it.
- The Store version is `X.Y.Z.0`. The revision must be `0`.
- The version must be greater than CONV2 1's last Store version, `1.7.0.0`
  (`STORE_BASELINE_VERSION` in `scripts/msstore-pack.js`).

Submission:

1. Upload the `.msixbundle` to the Partner Center product. Partner Center signs
   it. Do not upload the `.msix` files or sign them yourself.
2. Run a package flight before the Store release goes public. It must prove the
   CONV2 1 data import from the Store package folder
   (`%LOCALAPPDATA%\Packages\burnttoasters.conv2_*\LocalCache\Roaming\conv2`;
   see `src-tauri/src/legacy.rs`).
3. The Store release is a follow-up after the GitHub stable release and does
   not block it. See `docs/RELEASE-STABLE.md`.

## App icons

`src-tauri/icons/` holds the generated icon set. `npx tauri icon <master.png>`
rewrites every file in that folder. To refresh only the Windows `.ico` from a
margin-free master, run it into a temporary folder and copy `icon.ico` back:

```sh
npx tauri icon <windows-master.png> -o tmp-icons
cp tmp-icons/icon.ico src-tauri/icons/icon.ico
```

The Microsoft Store tiles in `src-tauri/msstore-assets/` are separate files.
