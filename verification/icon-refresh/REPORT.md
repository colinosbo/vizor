# Vizor v0.7.1 icon refresh

October 28, 2026. Uses the user-approved orange block Claude character inside a dark scope reticle. This is a Windows icon and packaging update; signing and Microsoft Store setup were left unchanged.

## Applied artwork

- The approved master is [desktop/clawd-scope.png](../../desktop/clawd-scope.png). Builds resize this file; they no longer redraw the old V mark or invoke image generation.
- The app window uses the generated 256-pixel PNG. The Windows application, taskbar/shortcut resources, installer and uninstaller use the generated multi-resolution ICO, with 16, 20, 24, 32, 40, 48, 64, 128 and 256 pixel entries. Transparent edges are preserved.
- Sharp is pinned as a build dependency. It performs only image resizing and encoding; no runtime image/provider calls are introduced.
- Packaging parses the compiled application and installer PE resources and compares every ICO entry's PNG bytes against the generated approved icon. It also compares the packed app-window PNG in app.asar. An old/missing icon fails the build.

## Verified

Application/package source: `477fe6d52521cea1ef17a800dcc592dba8cfd033`.

- Local type checking, formatting, all **93 automated tests**, production compilation, portable startup and Windows installer building pass. The app/installer icon resource checks pass locally.
- The [Windows installer workflow](https://github.com/colinosbo/vizor/actions/runs/40770549956) passed for the exact source commit, including icon checks and real installation, desktop/Start menu shortcuts, native app startup without Node on PATH, renderer isolation, single instance, reopening, reinstall/upgrade persistence, shutdown/crash cleanup and uninstall data retention.
- All four [portable package jobs](https://github.com/colinosbo/vizor/actions/runs/40770547728) passed for Windows x64, Intel macOS, Apple silicon macOS and Ubuntu x64. The separate [source launch checks](https://github.com/colinosbo/vizor/actions/runs/40770547595) passed on Windows, Intel macOS and Ubuntu. All use the 93-test application suite.
- The [v0.7.1 release](https://github.com/colinosbo/vizor/releases/tag/v0.7.1) was published only after both packaging workflows succeeded. It contains the Windows installer, four portable packages, individual checksums and SHA256SUMS.txt. The complete public Windows installer was downloaded without authentication and matched its published SHA-256.
- That public installer updated the existing local desktop app. The matching encryption configuration/database were backed up, and every table was unchanged immediately after installation. After reopening, saved information and configuration still match; only normal request-rate counters changed. The installed executable contains all nine approved icon images, its packed window asset matches, and the desktop app reports v0.7.1 ready. The separate local source workspace also restarted on v0.7.1 with its configuration and record counts preserved.

Provider verification remains mocked. This visual change does not add live paid inference, alter budgets or approvals, enable autopilot, or change database schemas. The installer remains unsigned; Windows publisher/SmartScreen warnings are still possible. Existing platform and signing boundaries are documented in the [Windows installer report](../windows/REPORT.md).
