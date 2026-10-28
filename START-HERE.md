# Start Vizor

Vizor runs on your own computer. You bring your own Claude/Anthropic or OpenAI API key. No account on someone else's Vizor server is needed.

## First time

1. Install **Node.js 24 LTS**, including npm, from [nodejs.org](https://nodejs.org/en/download). Choose the **24.x** version. Reopen your terminal or launcher after installing it.
2. Download the latest **vizor-v0.5.0.zip** from [Releases](https://github.com/colinosbo/vizor/releases/latest), then **extract the entire ZIP** to a folder you can write to. Do not run it from inside the ZIP. Keep it out of a synced/cloud folder when possible.
3. Start it for your system:

| System               | Launch                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Windows              | Double-click **Start Vizor.cmd**                                                                           |
| macOS                | Double-click **Start Vizor.command**, or open Terminal in the extracted folder and run `sh start-vizor.sh` |
| Linux                | Open a terminal in the extracted folder and run `sh start-vizor.sh`                                        |
| Any supported system | `npm run launch`                                                                                           |

The first launch installs the pinned dependencies, creates your local database and private encryption key, builds the app, and opens your browser. This needs internet and may take several minutes. Later launches reuse the installation and build. You do not need Git, a database server, Docker, or Codex.

The release also includes **SHA256SUMS.txt**. You can compare its ZIP hash with `Get-FileHash .\vizor-v0.5.0.zip -Algorithm SHA256` in Windows PowerShell, `shasum -a 256 vizor-v0.5.0.zip` on macOS, or `sha256sum vizor-v0.5.0.zip` on Linux.

If the browser does not open, visit **http://127.0.0.1:3000**. Keep the launcher window open while using Vizor. Press **Ctrl+C** to stop it. Use the same launcher to start it again.

## Add your keys

The first page has separate **Claude** and **ChatGPT** cards. Each has key-creation/billing instructions. Enter a key in the masked field and choose **Test connection**. The small inference test can incur an API charge; API billing is separate from Claude Pro or ChatGPT Plus. Keys are encrypted in your own local database and never included in the download.

Connect one provider or both. Open **Spending limits** to set your monthly dollar caps, then **Open workspace** to begin. You can configure the orchestrator later. **Autopilot is off**, and proposed messages or agent changes require your approval.

## Your data

Every installation creates its own `.env` encryption key and `data/` folder. Another person's keys, conversations and spending history do not come with the download.

Stop Vizor before backing up **both `.env` and the entire `data/` folder**. Keep backups private. Restoring only the database without its matching `.env` makes saved provider keys unreadable. Some file managers hide `.env`; enable showing hidden files when copying it. Do not replace the encryption key during an upgrade.

## Updating

1. Stop Vizor and back up `.env` and `data/`.
2. Extract the new download into a **new folder**.
3. Copy your original `.env` and complete `data/` folder into it. In the new folder, remove the old `data/.vizor-launch.lock` and `data/.vizor-build.json` if present. Do not copy `node_modules` or `.next` from the old installation.
4. Run the new launcher. It installs the correct dependencies, applies migrations and rebuilds. Keep the old folder/backup until you have checked your data.

To roll back, stop the new version and restore the **old code, database and matching `.env` together**. Opening a migrated database with old code is not a supported rollback.

## If something stops setup

| Message / symptom                                          | Next step                                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js is missing or the version is unsupported           | Install Node.js **24 LTS**, reopen the launcher, and try again.                                                                                                   |
| Port 3000 is already in use                                | Close your other Vizor launcher/app. To use another port, change `APP_ORIGIN` in `.env` to `http://127.0.0.1:3001`; the launcher uses that port automatically.    |
| Another launcher is running                                | Use its existing window, or close it before restarting. If a crash left a lock, the next launch reclaims it when that process is gone.                            |
| Missing/invalid MASTER_KEY or existing data without `.env` | Restore the original matching `.env`. The launcher will not silently replace it.                                                                                  |
| Dependency/build failure                                   | Check internet, disk space and Node.js 24. Then run `node scripts/launch.mjs --repair` from the extracted folder. Repair preserves `.env` and your database.      |
| Browser did not open / remote Linux machine                | Run `node scripts/launch.mjs --no-open` and open the printed local address yourself. The launcher is for local desktop use, not public hosting.                   |
| Permission or native-module error                          | Use a writable local folder and the normal Node.js 24 installation for your computer's architecture. Unsupported/older systems may lack native dependency builds. |

macOS may require allowing a downloaded launcher in system security settings or using the documented Terminal command. The download is a source distribution with local setup, not a signed native installer. Supported targets are current Windows, macOS and Linux desktops with Node.js 24; see the release verification notes for what was actually tested.

For a reproducible problem, open an [issue](https://github.com/colinosbo/vizor/issues). Do not attach API keys, `.env`, your database, private conversations or backups. Include your OS, Node.js version and a redacted error message instead.

## Rights

Vizor is **rights reserved**, not open source. The included [LICENSE](LICENSE) permits downloading and running your own local workspace. Redistribution, modification, sublicensing and resale rights are reserved.
