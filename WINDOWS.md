# Vizor for Windows

## Install and open

1. Download the current **Vizor-Setup-*-x64.exe** from the [latest release](https://github.com/colinosbo/vizor/releases/latest). Existing installed copies can use **Help → Check for updates**.
2. Run it and accept the included license. Vizor installs for your Windows user; you do not need to install Node or run commands.
3. Open **Vizor** from your desktop or Start menu. It opens in its own app window.
4. Choose **New agent**, select **Claude Code**, **Codex**, or an **API connection**, and select a project for terminal agents. Use **Set up / sign in** if a CLI is missing or needs login. API agents use your own Anthropic/OpenAI key; API billing is separate from chat subscriptions.

The installer is for Windows 11 on Intel/AMD 64-bit PCs. It includes the app, its browser engine and Node runtime. No Git, Docker, Node installation or database service is needed. Windows ARM is not verified. **The download is unsigned**, so Windows may show an unknown-publisher/SmartScreen warning. Only continue if you trust the release and its checksum; managed computers may block unsigned apps.

## Everyday use

- Open the desktop or Start menu shortcut. Opening it again brings the existing window forward.
- Closing the app window or choosing **File → Quit Vizor** stops its local server. No terminal window or background service needs to stay open.
- **File → Open your data folder** opens your workspace in Explorer.
- The app picks an available local port automatically and listens only on 127.0.0.1. It can run alongside a separate browser/portable installation without taking over that app's port.
- External HTTPS links open in your normal browser. The app window stays on your local workspace. Camera, microphone, remote images and downloads are blocked inside the app; copy buttons can write to your clipboard.
- Autopilot is off. Orchestrator proposals still require your approval. No telemetry or additional paid services are enabled.
- Claude Code and Codex open their real native terminal interfaces. Each has its own session and project. Use **Resume**, **Interrupt**, **Stop**, or settings to rename/archive. Board layout and session IDs survive restarts; terminal processes never restart automatically. See [Terminal agents](TERMINAL-AGENTS.md).
- Closing with live terminals asks whether to stop them and quit. Updates wait for terminals to close. A native CLI can run subprocesses and edit files under its own permissions; the project folder is a starting directory, not a security boundary.

## Your keys and conversations

Program files install under `%LOCALAPPDATA%\Programs\vizor-desktop`. Saved information lives separately in **`%LOCALAPPDATA%\Vizor\workspace`**:

- `.env`: your permanent encryption key and configuration.
- `data\`: SQLite conversations, agent settings, encrypted provider keys and spending history.

The separate `shell` folder stores the app window's browser profile. Do not share any of these folders. Before a backup, quit Vizor and copy **both `.env` and the whole `data` folder** to a private backup location. Losing `.env` makes saved provider keys unreadable. Never replace its master key after saving keys.

Terminal conversations and CLI authentication stay in each tool's own profile (normally `%USERPROFILE%\.claude` and `%USERPROFILE%\.codex`, or the tool's configured home). Back those up privately following the tool's guidance if you want to move terminal history. Vizor stores session identifiers, not a second copy of native history or subscription credentials. Managed native executables live under `%LOCALAPPDATA%\Vizor\tools`.

## Update or uninstall

Starting with v0.8.0, Vizor checks for stable GitHub releases shortly after startup and every six hours while open. It verifies the release's internal signature and installer checksum, downloads the update, and installs it automatically when you close the app. It does not force a restart. When ready, **Restart now** offers an earlier restart; it defers if a reply is running. The app stops its local server before installation. Your workspace stays outside the installation directory and is preserved.

Use **Help → Check for updates** for an immediate check. **Help → Automatic updates** saves an opt-out; enabling it again resumes updates. Failed/offline checks leave Vizor usable. Updates contact only Vizor's public GitHub release feed and asset CDN; no GitHub account is needed and no conversations or provider keys are sent. This internal release authentication is separate from Windows publisher signing; publisher warnings can still occur.

You can still quit Vizor, back up the workspace, and run a newer installer manually. Portable/source downloads use this manual path. Schema changes create a pre-upgrade database backup when needed. Keep your original backup until you confirm an update; older versions should not open a newer database. Allow a few moments for a background installation to finish before reopening the shortcut.

Use **Windows Settings → Apps → Installed apps → Vizor → Uninstall** to remove the program and shortcuts. **Your workspace is kept**, so reinstalling can recover it. If you also want to remove private data, quit/uninstall first, then remove the Vizor data folder yourself after deciding whether to keep a backup.

## Move from the portable download

1. Quit both the old portable app and the installed app.
2. Back up the portable folder's `.env` and `data` together.
3. Copy them into `%LOCALAPPDATA%\Vizor\workspace`. If the installed app already contains information you want to keep, back that up first; these are separate workspaces and are not merged.
4. For the standard `DATABASE_URL="file:./data/vizor.db"`, no path change is needed. If you previously used an absolute/custom database path, update only that path to the copied database. Preserve `MASTER_KEY` exactly.
5. Open the desktop shortcut and check your history before removing the portable folder.

## Troubleshooting

If startup fails, close other copies, reopen Vizor, and check that the matching `.env` and database are present in your workspace. Reinstalling repairs program files and keeps your workspace. Never fix a key error by replacing its master key.

For support, use the [issue tracker](https://github.com/colinosbo/vizor/issues) and include your Windows/app version and a redacted description. Do not attach `.env`, API keys, databases, private conversations or backups.

## Developer build

On Windows x64 with Node 24 installed for development:

```powershell
npm ci
npm run setup
npm run build:portable
npm run package:portable
npm run test:portable
npm ci --prefix desktop
npm ci --prefix desktop/terminal-host --ignore-scripts
npm run package:windows
npm run test:terminals
npm run test:windows
npm run test:updates
```

The installer smoke check refuses an existing Vizor installation or shortcut. Use a clean Windows account/runner. It installs into a temporary folder, checks shortcuts and the installed app, reinstalls over the same version, uninstalls, and confirms private data was retained. Provider calls are not made by this check; separate application/portable checks use mocks. Packaged inspection uses Chromium's explicitly requested local debug port; ordinary launches do not enable it.

Advanced users can set `VIZOR_DESKTOP_DATA_DIR` to an absolute local directory before launch to keep an independent workspace/profile. `VIZOR_DISABLE_UPDATES=1` forces update checks off for development/isolated tests. The default settings are recommended. Hosted accounts, Windows publisher signing and autopilot remain outside this release.
