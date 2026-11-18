# Roadmap

Deferred work, with the problem, the plan, and the acceptance criteria.

## Mac App Store (not in 2.0)

CONV2 1 and 2.0 ship outside the Mac App Store: a signed, notarized DMG and ZIP,
plus the in-app updater.

**Problem.** A Mac App Store build needs its own sandbox profile and packaging.
The bundled FFmpeg and FFprobe sidecars must run inside the App Sandbox, the
in-app updater must be absent, and file access must go through user-selected
locations only.

**Plan.**

1. Add a `CONV2_DISTRIBUTION_CHANNEL=mas` build that turns the updater off, as
   the `msstore` channel does.
2. Write a sandbox entitlements file. Grant user-selected read and write file
   access, and keep `com.apple.security.inherit` on the sidecars.
3. Check that the sidecars launch from inside the signed app bundle with the
   sandbox inherited, that outputs land in the folder the user picked, and that
   "move original to trash" works under the sandbox.
4. Package with `productbuild`, validate with `altool`, and upload through
   Transporter.

**Acceptance.** A sandboxed build converts a file picked by the user into a
folder picked by the user, with no entitlement beyond those listed, and passes
App Store validation. The `msstore` precedent applies: the store package is a
stable-only follow-up that never blocks the GitHub release.

## Linux arm64 releases

The `arm64` AppImage and Flatpak scripts stay wired but are not published.

**Plan.** Add an arm64 runner to the release matrix once an arm64 FFmpeg payload
is part of `FFMPEG_DL_SERVER`, then enable `release:linux:arm64` in the
runbook.

**Acceptance.** The arm64 AppImage and Flatpak pass the packaged-artifact QA in
`docs/RELEASE-STABLE.md`.

## Per-sidecar macOS entitlements

Today one entitlements file signs the app and both sidecars. Neither sidecar
needs the broad exceptions that file grants.

**Plan.** Sign the sidecars with a minimal file, then regenerate the updater
bundles and re-notarize, in that order, because re-signing after notarization
breaks the staple.

**Acceptance.** `codesign --verify --deep --strict`, `xcrun stapler validate`,
and `spctl` pass on the final app, and `scripts/zip-macos.js` checks each
sidecar against its own expected entitlements.

## Accessibility: Convert button contrast

The E2E axe audit pins two known findings: white text on the Convert button is
about 3.1:1 in the dark theme and about 4.0:1 in the midnight-blue theme, below
the 4.5:1 AA minimum. CONV2 1 shipped the same accent colors.

**Plan.** Darken the accent used behind the Convert button text in those two
themes, or use dark text on it.

**Acceptance.** Remove the entries from `KNOWN` in the accessibility scenario of
`e2e/specs/main.spec.js`; the audit then fails on any violation in all four
themes.
