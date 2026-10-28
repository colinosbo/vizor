# Vizor v0.8.0 automatic Windows updates

October 28, 2026. Installed Windows copies can receive new stable GitHub releases without downloading another installer manually. People on v0.7.1 or earlier need one final manual installation to obtain the updater. Portable and source copies continue to use manual updates. Autopilot remains off.

Application/package source: `f6e9ba23a10b333e0daebb7eb8840d74233a020b`.

## Behavior and release authentication

- Checks the fixed public `colinosbo/vizor` GitHub feed shortly after startup and every six hours. Drafts, prereleases, same-version releases and downgrades are excluded. Source pushes alone do not update users.
- Verifies a detached Ed25519 signature against the packaged public key before downloading an installer. Signed version, Windows x64 identity, filename, size and SHA-512 must match the updater metadata. Additional web-installer packages are rejected. The standard updater verifies the downloaded checksum as well.
- Downloads in the background, shows progress/readiness, and installs on normal app quit after the owned local server stops. It never schedules a forced restart. **Restart now** defers if a generation is active or activity cannot be confirmed.
- **Help → Check for updates** checks immediately; **Help → Automatic updates** persists an opt-out. Errors are sanitized and recoverable, and an offline app remains usable.
- The sandboxed renderer receives only a narrow update bridge. Main-process handlers verify the sender, main frame and exact local origin. No filesystem, process or general Electron API is exposed. Update requests do not carry provider keys, conversations, GitHub credentials or a unique installation tracking header.
- A permanent private release key is held in a GitHub Actions secret and an ignored local backup. Only its public verification key is distributed. Signing happens after the native package checks; the private key is unavailable during compilation. This is independent of Windows publisher signing: the installer remains unsigned and Windows warnings are still possible. Store/paid signing setup remains canceled.

## Verified checks

- Local type checking, formatting, production compilation and all **105 automated tests** pass. Update cases include exact metadata authentication, tampering/wrong signer, untrusted URLs and secondary packages, wrong platform, downgrade refusal, download gating, offline retry, saved opt-out, concurrent-check suppression, active/unknown generation deferral and server shutdown before installation. Provider checks use mocks.
- **Nine Chromium browser checks** pass locally, including the desktop-only update banner, mobile layout, deferred restart message and ordinary browser behavior, alongside existing onboarding, keys, conversations, accounts, approvals/audit and spending guards. Update UI checks inject a mock bridge.
- A local real two-version test builds separately identified private Windows test apps with an ephemeral key and localhost feed. It exercises the actual updater download, signed metadata verification, active-run deferral through private launcher IPC, automatic NSIS installation on normal quit, reopening the newer app, preserved `.env` and spending cap, and uninstalling the fixture. These packages are never published as Vizor releases. It makes no provider calls.
- All four [portable package jobs](https://github.com/colinosbo/vizor/actions/runs/40788804185) pass on Windows x64, Intel macOS, Apple silicon macOS and Ubuntu x64. The [source launch checks](https://github.com/colinosbo/vizor/actions/runs/40788775989) pass on Windows, Intel macOS and Ubuntu. These run the same 105-test suite.
- The [Windows release workflow](https://github.com/colinosbo/vizor/actions/runs/40788806222) passes for the exact source commit. It builds the production updater/key/feed and approved icon, verifies packed resources, exercises real install/shortcuts/launch/reopen/upgrade/uninstall, and repeats the two-version updater test before signing/uploading release metadata.
- The [public v0.8.0 release](https://github.com/colinosbo/vizor/releases/tag/v0.8.0) was published only after both packaging workflows passed. It contains the Windows installer, four portable packages, checksums, blockmap, `latest.yml`, signed JSON manifest and detached signature. The complete public installer was downloaded anonymously and matched its published SHA-256. Its public manifest signature verifies against the app's pinned key and matches the installer's SHA-512.
- That public installer upgraded the existing local v0.7.1 installation after a private backup. Its exact configuration and every database table matched immediately after installation. After reopening, saved data still matched; only normal request-rate counters changed. The installed v0.8.0 app successfully checked the actual public GitHub feed, reported `current`, and confirmed automatic updates are enabled. This verification made no provider calls.
- The separate local source workspace runs v0.8.0 with its original configuration and database record counts preserved, following a private backup.

## Boundaries

There are no new live provider/billing checks. Automatic update coverage is Windows x64, with a real two-version fixture rather than a fabricated public v0.8.1 release. Future schema changes still require their own migration tests; existing migration safeguards back up databases before pending changes. No Windows ARM, publisher certificate, Store distribution or promise to remove OS security warnings is claimed.

See [Windows setup](../../WINDOWS.md) and [publishing updates](../../UPDATE-RELEASES.md) for controls, backup/key custody, required release assets and recovery.
