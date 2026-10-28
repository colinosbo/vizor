# Vizor v0.7.0 Windows desktop installer

October 28, 2026. A Windows x64 installer with a dedicated application window, desktop and Start menu shortcuts, and uninstall support. Node.js and the browser engine are bundled. Rights reserved. Autopilot remains off.

## Result

- `Vizor-Setup-0.7.0-x64.exe` installs per user and creates shortcuts to `Vizor.exe`. No separately installed Node, browser, compiler, database service or administrator setup is needed for the standard per-user installation.
- Electron 45.1.0 supplies the app window. A bundled Node 24.22.1 process runs the same Next.js/SQLite application, avoiding Electron/native SQLite ABI coupling. No terminal window or external browser tab is needed for ordinary use.
- The app selects an available 127.0.0.1 port, waits for its own launcher's IPC readiness message, and loads that exact local origin. Opening a second copy focuses the first. Closing the window stops the owned local server; an IPC disconnect also cleans up after a crashed main process.
- Program files and user data are separate. The default workspace is `%LOCALAPPDATA%\Vizor\workspace`; the app's browser profile is in the adjacent `shell` folder. Updates and uninstalling retain those folders. **File → Open your data folder** provides access for backups.
- Renderer Node integration is disabled, context isolation and sandboxing are enabled, and no native preload/IPC API is exposed to page content. Navigation and resource requests are restricted to the selected local origin. External HTTPS links open in the system browser. Permission handlers deny access except local clipboard writes. Downloads and webviews are blocked. Production fuses disable RunAsNode, Node options and Node CLI inspection, require ASAR loading and enable embedded ASAR integrity checking.
- No automatic updates, telemetry, signing service, startup service or autopilot are enabled. Existing owner-scoped persistence, encrypted provider keys and explicit human approvals remain in place.

## Verification

Application/package source: `1ce0c550233216f7921ab638b36777c95d52572b`.

The [public v0.7.0 release](https://github.com/colinosbo/vizor/releases/tag/v0.7.0) contains the installer, four portable packages, individual checksums and SHA256SUMS.txt. The complete installer was downloaded without GitHub authentication and matched its published SHA-256. That public file was then installed locally into its default per-user location, its desktop shortcut was launched, and its local readiness endpoint confirmed v0.7.0. GitHub's latest-release endpoint points to v0.7.0. Authenticode inspection confirms the installer is not signed.

The [Windows installer workflow](https://github.com/colinosbo/vizor/actions/runs/40757410868) passed against that commit before publication. It compiles and packages the app, runs type checking, **93 automated tests**, formatting and the portable smoke check, then builds and exercises the actual NSIS installer. Its upload step accepts only the exact tested installer checksum and matching draft/source commit.

The installed-app check verifies:

- Real silent installation into a path containing spaces, with both shortcut targets checked.
- The installed `Vizor.exe` opens the local app with Node/npm absent from PATH.
- UI hydration and show/hide key controls work without submitting a key.
- `window.require`, `window.process` and a native Electron bridge are unavailable to the renderer.
- A second app process focuses the first and exits instead of creating another workspace window.
- Reopening preserves the exact `.env` and a saved spending cap.
- Closing the app stops its server. Killing only its main process also stops the backend, and reopening preserves the master key.
- Installing the same version over itself exercises NSIS's existing-installation replacement path and preserves saved data.
- Uninstalling removes program files and desktop/Start menu shortcuts while retaining the exact encryption configuration and database. The check waits for Windows' asynchronous uninstaller cleanup.

The same installer check passes locally on Windows. **Seven Chromium browser checks** also pass locally against v0.7.0, covering onboarding/key lifecycle, conversation controls, accessibility/layouts, templates, restart recovery, accounts, orchestration approvals/audit and spending guards. Provider checks in those tests use fixtures.

All four [portable package jobs](https://github.com/colinosbo/vizor/actions/runs/40757408062) pass for Windows x64, macOS Intel, macOS Apple silicon and Ubuntu x64. The separate [source-launch workflow](https://github.com/colinosbo/vizor/actions/runs/40757406733) passes on Windows, Intel macOS and Ubuntu. Each uses the 93-test application suite. Existing local source-workspace configuration and database row counts were checked unchanged after its v0.7.0 restart, with a private pre-upgrade backup retained.

## Boundaries and handoff

- The installer is **unsigned**. SmartScreen/unknown-publisher prompts and managed-device restrictions remain possible. No code-signing certificate, notarization, Windows Store publication or consumer download-warning certification is claimed.
- Installer coverage is Windows x64 on the local Windows machine and the current hosted Windows runner. Windows ARM and every Windows hardware/OS variant are not separately tested.
- Reinstalling over the same version tests the installer replacement path; future schema changes still need their own migration and upgrade checks. Earlier populated-database tests cover Prisma history, encrypted credentials, conversations, foreign keys and rollback. The installer does not merge portable and installed workspaces automatically.
- Installed-app checks make no provider requests. Portable/application/browser checks use mocks; no live paid inference or billing-account verification is claimed. Users enter their own API keys through onboarding.
- The [Windows guide](../../WINDOWS.md) documents install/open, the data location, backups, updates, retained data after uninstall and moving from a portable workspace. `.env` and `data` must be preserved together.
