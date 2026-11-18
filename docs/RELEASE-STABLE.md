# Stable release runbook

This runbook covers the transition from an accepted beta to its stable
release. Replace `X.Y.Z` with the stable version and `N` with the accepted beta
number. Do not use it to bypass a failed candidate or a failed `main` gate.
Run every command from a clean checkout of the canonical repository.

## 1. One-time branch enforcement

`main` must be protected before stable promotion. `beta` is a mutable staging
branch and needs no protection. With a GitHub CLI account that has repository
administration permission:

```sh
npm run repo:protect-release-branches
```

The command protects `main` with the `ci-gate` status check, requires the
branch to be up to date, allows the intentional administrator bypass, and
disables force pushes and branch deletion. CI runs tests, audits, validation,
and unsigned compile smoke only. Building, signing, and publishing stay on the
manually operated release machines. `release:preflight` does not check branch
protection and does not wait for hosted CI.

## 2. Freeze and prove the candidate

### Soak gate

Every condition must hold before the candidate is frozen:

- No runtime change has landed since the beta tag.
- No open regression is known for that beta.
- The field exposure is recorded. Download counts are a proxy, not an install
  count:

  ```sh
  gh release view vX.Y.Z-beta.N --json assets --jq '.assets[] | [.name, .downloadCount] | @tsv'
  ```

  The maintainer sets a minimum before the soak starts and records it, with the
  observed counts and date, in the promotion record.

### Microsoft Store gate

CONV2 ships to the Microsoft Store as an MSIX bundle under the existing
`BurntToasters.CONV2` product (`npm run build:msstore`).

- The Store is a follow-up after the GitHub release and does not block stable.
- Store packages are stable only, versioned `X.Y.Z.0`, and must be greater than
  the last CONV2 1 Store version (see `build-setup.md`).
- Before the Store release goes public, run a Partner Center package flight of
  the signed bundle. The flight must show settings, window state, and the GPU
  cache imported from the CONV2 1 package folder (`store_package_dirs` in
  `src-tauri/src/legacy.rs`). Record the flight ID and result.

### Candidate proof

The only stable candidate source is `next-X.Y.Z`, promoted directly to `main`.
The production source must stay the accepted beta source users tested. No
production, packaging, updater, installer, build, or toolchain path may change
without another beta. Run the complete gate, including E2E:

```sh
git fetch --tags origin
git rev-parse --verify "refs/tags/vX.Y.Z-beta.N^{commit}"
git switch next-X.Y.Z
git pull --ff-only origin next-X.Y.Z
git diff --name-status vX.Y.Z-beta.N..HEAD
git diff --check vX.Y.Z-beta.N..HEAD
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
```

Compare against the beta tag, never the mutable `origin/beta` tip. Do not run
`release:preflight` on `next-X.Y.Z`; it accepts only `beta` for beta versions
and `main` for stable versions.

Open the promotion pull request from `next-X.Y.Z` directly to `main`. Every
GitHub Actions job for that exact head must be green. Download the `e2e-*`
artifacts and confirm every scenario passed.

A Mac runs the E2E gate in background mode by default
(`CONV2_E2E_BACKGROUND=1`); CI runs in the foreground. The report does not
record the mode, so the release record must state which one produced it.

## 3. Promote the tested source to main

Merge the exact accepted `next-X.Y.Z` head into protected `main` through the
normal GitHub merge flow. Do not merge it through `beta` first and do not force
push either release branch. Require the post-merge `main` CI run to pass, then
start a short-lived metadata branch from the pushed `main` tip:

```sh
git switch main
git pull --ff-only origin main
git switch -c release/X.Y.Z
```

Change only release metadata. Edit `package.json` `version` to `X.Y.Z`, then
synchronize the generated version files without updating dependencies:

```sh
npm run sync-version
```

Edit `CHANGELOG.md` so the current section is the final stable entry and remove
beta-only wording. Review the diff, commit it, and merge the branch to `main`
through a pull request. CI accepts `release/*` into `main` only when the head
removes just the beta suffix and every changed path is an enumerated metadata
file.

## 4. Prove the stable source

On the exact pushed stable commit:

```sh
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
npm run licenses:cargo:strict
npm run release:preflight
```

Also confirm that `git status --short` is empty apart from generated Tauri
schema paths the release tooling permits, `npm audit --omit=dev
--audit-level=high` passes, `npm run audit:dev-reviewed` passes, `cargo audit`
reports no unignored vulnerability, and no `-beta.N` suffix remains.

On the macOS release machine, run the E2E stability check after the gate:

```sh
npm run test:e2e:stability
```

It repeats the full E2E gate five times, so expect a long run. It writes
`e2e/artifacts/e2e-stability-darwin-arm64.json`; cite that file in the release
record.

## 5. Build and sign on isolated machines

Use clean, isolated release machines. Load signing secrets for the session
only and delete `.env` afterwards. Each command runs preflight, prepares
locked dependencies, regenerates notices and sidecars, and creates or reuses
the commit-bound draft:

```sh
npm run release:win
npm run release:mac
npm run release:linux
```

Public Linux releases ship x64 only (AppImage and Flatpak). The arm64 wiring is
kept for later and is not part of the release matrix. The platform commands
skip GUI E2E on the signing machine; step 4 and protected CI already proved the
exact commit with E2E enabled.

## 6. Packaged-artifact QA

Install each signed artifact and verify launch, a real conversion, the queue,
cancel, the updater on the stable and beta channels, macOS notarization and
sidecar signatures, and Linux launchers (AppImage and Flatpak).

### Updater gate

Update from the accepted beta to the stable candidate on each platform:

- **macOS, user-owned location:** the app is replaced and relaunches as `X.Y.Z`.
- **macOS, admin-owned `/Applications`:** the update asks for administrator
  approval and replaces the app.
- **Windows x64 and arm64 NSIS:** the update installs over the beta and the app
  starts as `X.Y.Z`. A running conversion blocks the install until it ends.
- **Linux AppImage:** the image is replaced and starts as `X.Y.Z`.
- **Flatpak:** the in-app updater does not apply. Reinstall the stable asset
  and confirm the version.

Record each result with the artifact name and SHA-256. Do not publish a draft
that has not passed this matrix.

### CONV2 1 upgrade path

CONV2 1 cannot update itself into CONV2 2. Verify on a machine with CONV2 1:

- The final v1 release offers the guided upgrade to the v2 download.
- The v2 release carries the v1 `latest*.yml` copies (`legacy-v1-feed.json`
  names the v1 tag they point at):

  ```sh
  npm run release:legacy-v1-feed -- --dry-run --check-urls
  ```

- First launch of v2 imports the v1 settings, window state, and GPU cache, and
  leaves the v1 folder unchanged.

## 7. Verify the draft

After all platform assets and signatures are present:

```sh
npm run release:verify:draft
```

Resolve duplicate drafts, missing signatures, wrong manifest URLs, a missing v1
update feed, or a wrong target commit. Never override the verifier.

## 8. Publish, then verify the live feed

```sh
npm run release:publish
npm run release:verify:published
```

The second command must prove the live updater feed and signatures for
`X.Y.Z`. Confirm GitHub shows the release as the latest non-prerelease and that
the tag resolves to the exact stable `main` commit.

## 9. Post-release checks

Install or update through each distribution path and smoke test a conversion,
the queue, and the updater. Keep `main` protection enabled. If any publish-time
check fails, stop distribution work and repair the metadata or assets. Do not
create a second release for the same version.

## 10. Recovering an interrupted macOS update

The macOS updater replaces only the `Contents` directory of the installed app,
so the outer `CONV2.app` and its Dock identity stay. The swap is two renames
(`swap_macos_app_contents` in `src-tauri/vendor/tauri-plugin-updater/src/`):

1. `CONV2.app/Contents` moves to a hidden sibling backup directory named
   `.CONV2-app.conv2-update-backup-<hash>` (16 lowercase hex digits).
2. The staged `Contents` moves into `CONV2.app/Contents` and its identity is
   checked.

A crash between the renames leaves `CONV2.app` without `Contents`, and the app
cannot start to run its own recovery. Restore it by hand. The paths assume
`/Applications`.

1. Quit CONV2.
2. Confirm `ls -la /Applications/CONV2.app` shows no `Contents`. If it exists,
   stop and keep the backup: this is not the state described here.
3. Find the backup and confirm it holds `Contents`:
   `ls -la /Applications | grep conv2-update-backup`, then
   `ls /Applications/.CONV2-app.conv2-update-backup-*/Contents`. A backup with
   no `Contents` means the first rename never happened, so this does not apply.
4. Move the backup's `Contents` back, using the exact name from step 3 (use
   `sudo` if `/Applications` is administrator-owned):

   ```sh
   mv "/Applications/.CONV2-app.conv2-update-backup-<hash>/Contents" "/Applications/CONV2.app/Contents"
   ```

5. Remove the emptied backup. `rmdir` refuses a non-empty directory:

   ```sh
   rmdir "/Applications/.CONV2-app.conv2-update-backup-<hash>"
   ```

6. Launch CONV2. The restored build is the pre-update one, and the next update
   check offers the update again.

Record any case that does not match, with the `ls` output, before retrying.
