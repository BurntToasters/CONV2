# Microsoft Store MSIX pack failure modes

Written before `scripts/msstore-pack.js` and `scripts/msstore-pack.test.mjs`
(AGENTS.md). The pack script turns the no-bundle Store exe, the sidecars and
the resources into one `.msixbundle` for the existing Partner Center product
(identity `BurntToasters.CONV2`). Pure parts are tested by
`scripts/msstore-pack.test.mjs`. Windows-only steps (makeappx) are listed as
confirmations for a Windows machine with the SDK.

## Host and tooling

1. Run on macOS or Linux. Expected: exit 1 before any file is created, with a
   message that says MSIX packing needs Windows and the Windows SDK `makeappx`.
   No `msstore/` directory is created.
2. Run on Windows with no `makeappx.exe` on PATH and no Windows Kits 10 bin
   folder. Expected: refused, message tells the user to install the Windows SDK.
3. Several Windows SDK versions are installed. Expected: the highest version
   under `Windows Kits\10\bin` with an `x64\makeappx.exe` is chosen.
4. `makeappx pack` or `makeappx bundle` exits nonzero. Expected: the error
   propagates, the pack folder is removed, and no `.msix` or `.msixbundle` is
   left behind.
5. A stale `.msix` or `.msixbundle` from an earlier run exists. Expected: it is
   removed before packing, so a failed run cannot leave an old package that
   looks new.

## Version mapping

6. `2.0.0-beta.1` is passed. Expected: refused, message says Store packages are
   stable only.
7. `--allow-prerelease` is passed with a prerelease. Expected: packed as
   `2.0.0.0`, and the output says it is a local test package that must not be
   submitted.
8. `--allow-prerelease` is passed with a stable version. Expected: no warning
   about prerelease, same `X.Y.Z.0` output.
9. The version has two or four parts (`2.0`, `2.0.0.0`). Expected: refused.
10. A component is above 65535 (`65536.0.0`). Expected: refused.
11. The version has build metadata (`2.0.0+abc`). Expected: refused.
12. The version is `1.7.0` or lower (not greater than the CONV2 1 Store
    version `1.7.0.0`, the highest 1.x release). Expected: refused.
13. `sync-version`'s Windows form `2.0.0.65535` would be produced by
    `windowsPackageVersionFromSemver`. Expected: the pack never uses it; the
    output revision is always `0`.
14. An unknown argument such as `--allow-prereleas` (typo). Expected: refused.
15. An unknown architecture (`ia32`, `X64`). Expected: refused with usage.

## Environment

16. `MSSTORE_IDENTITY_NAME`, `MSSTORE_PUBLISHER` or
    `MSSTORE_PUBLISHER_DISPLAY_NAME` is missing or whitespace only. Expected:
    refused, and every missing name is listed in one message.
17. `MSSTORE_PUBLISHER` does not start with `CN=`. Expected: refused.
18. `MSSTORE_IDENTITY_NAME` has spaces, underscores or other characters outside
    letters, digits, `.` and `-`. Expected: refused.

## Manifest rendering

19. A value contains `&`, `<`, `>`, `"` or `'` (for example a description).
    Expected: escaped, so the XML still parses and no element is injected.
20. A placeholder has no value. Expected: throws.
21. A `{{...}}` placeholder survives rendering. Expected: throws, so the package
    never contains raw template text.
22. The rendered `Executable` attribute equals the exe file name copied into
    the pack folder (`conv2.exe`).
23. The manifest has no startup task and no network capability, declares
    `runFullTrust`, and uses MinVersion `10.0.10240.0` and MaxVersionTested
    `10.0.22621.0` (the CONV2 1 Store package values; the app converts local
    files and needs no internetClient).
24. The manifest references an asset (`Assets\...png`) that was not copied.
    Expected: refused before makeappx. This is the check that replaces
    `makeappx /nv`, which skips makeappx's own validation.

## Assets

25. The restored CONV2 1 PNGs in `src-tauri/msstore-assets/` do not start with
    the PNG signature. Expected: the test fails. (Checked by the test on the real
    files.)
26. A non-PNG file is placed in `msstore-assets/`. Expected: not copied into
    `Assets/`.

## Sidecars

27. A sidecar (`conv2-ffmpeg`, `conv2-ffprobe`) for the target triple is
    missing from `src-tauri/binaries/`. Expected: refused, naming the file and
    `npm run prepare:sidecars`.
28. The sidecar is absent from `.sidecar-manifest.json`. Expected: refused.
29. The manifest entry has `"stub": true`. Expected: refused.
30. The file contents contain `CONV2-SIDECAR-STUB` and are under 4096 bytes,
    even though the manifest says `stub: false`. Expected: refused.
31. A real binary above 4096 bytes contains the marker text. Expected: not a
    stub (same rule as `src-tauri/build.rs`).
32. The file no longer matches the manifest `sha256` (changed after prepare).
    Expected: refused.
33. An arm64 sidecar is used for an x64 build. Expected: not possible, because
    the file name includes the target triple and the plan uses the triple.

## Resources

34. A `bundle.resources` source is missing (for example the checksum manifest).
    Expected: refused, with every missing path listed.
35. A resource destination escapes the exe folder (`../x`) or is absolute.
    Expected: refused.
36. `bundle.resources` is not an object map. Expected: refused with a clear
    message.
37. Resource copies land under the pack folder at the same relative paths the
    Tauri config names (`ffmpeg/...`), so the notices and checksum manifest
    ship.

## Exe

38. `target/<triple>/release/conv2.exe` is missing (build not run). Expected:
    refused, naming `npm run build:msstore:win:<arch>`.
39. The exe name is read from the `[package]` name in `src-tauri/Cargo.toml`
    (`conv2`), not from the product name.

## Layout and cleanup

40. A pack folder from an earlier failed run exists. Expected: removed before
    the new layout is written.
41. After success or failure, `msstore/pack-<arch>` folders are removed.
    Expected: only `.msix` and `.msixbundle` files remain in `msstore/`.
42. Both arches are packed in one run. Expected: one `CONV2_<X.Y.Z>.0.msixbundle`
    is created. A single-arch run creates only its `.msix` and says so.
43. Nothing is written outside `msstore/`.

## Build wiring (package.json)

44. `build:msstore:win:*` builds without `--bundles nsis` and with `--no-bundle`
    and `--msstore`, so `CONV2_DISTRIBUTION_CHANNEL=msstore` is set and the
    in-app updater is off. Expected: the test reads package.json.
45. `build:msstore*` runs `sync-version`, `licenses` and `prepare:sidecars`
    before building, then runs `msstore-pack.js`. Expected: the test reads
    package.json.

## Confirmations on a Windows machine (not testable here)

46. The `.msixbundle` is signed by Partner Center, and Partner Center accepts
    the identity, publisher and version.
47. `makeappx pack /nv` produces a package that installs and launches (the exe,
    the sidecars and the notices are present in the install folder).
48. A package flight with the same identity imports CONV2 1 data from the old
    profile locations (see `src-tauri/src/legacy.rs`). No Rust code changed for
    this. The flight must confirm it before public release.
49. The Store build reports the Store channel (in-app updater hidden). The pack
    step does not check the channel; the build step sets it.
