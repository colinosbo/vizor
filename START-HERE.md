# Start Vizor — no Node installation needed

This guide covers the portable archives. For the Windows desktop installer, shortcuts and automatic updates, use the [Windows app guide](WINDOWS.md).

1. Extract the **whole archive** into a folder you can write to. Do not run it inside the ZIP, Downloads preview, Program Files, a shared folder, or a cloud-synced folder.
2. **Windows:** double-click **Start Vizor.cmd**. **macOS:** open **Start Vizor.command**. **Linux:** run `./start-vizor.sh` from a terminal.
3. Your browser opens Vizor at **http://127.0.0.1:3000**. Keep the launcher window open. Press **Ctrl+C** there to stop.
4. Connect your own Claude or OpenAI API key in the app. API usage is billed by the provider separately from chat subscriptions. Connection tests can incur a small charge. Autopilot is off.

Everything needed to run the app, including Node.js, is included. There is no npm install, build, or first-launch download. You need internet only for provider requests after you explicitly connect or chat. Nothing is uploaded to Vizor or GitHub. Use a current browser.

## Choose the correct download

- `windows-x64.zip`: Windows 11 on Intel/AMD 64-bit PCs.
- `macos-arm64.tar.gz`: Apple silicon Macs, macOS 13.5 or later.
- `macos-x64.tar.gz`: Intel Macs, macOS 13.5 or later.
- `linux-x64.tar.gz`: Intel/AMD 64-bit Linux, glibc 2.28 or later (for example Ubuntu 22.04+); Alpine is unsupported.

These are unsigned portable packages, not installers. Windows or macOS may show a warning for downloaded software. Only proceed if you trust the release and its checksums. Managed computers may block unsigned apps. On macOS, use your system's normal security approval controls if required. On Linux, if execution permission was lost during extraction, run `chmod +x start-vizor.sh runtime/node`. Other operating systems and processors are not verified.

## Keep your information safe

Vizor listens only on this computer. Each extracted folder is a separate workspace. Its `.env` contains the permanent encryption key; `data/` contains conversations and encrypted provider keys. Never upload or share these files. Closing the browser does not stop the server; close the launcher or press Ctrl+C.

For a backup, stop Vizor and copy **both `.env` and the entire `data/` folder** to a private location. Losing `.env` makes saved API keys unreadable. Do not replace its master key. Store backups securely.

## Update an existing workspace

Stop the old Vizor. Back up its `.env` and `data/` together. Extract the new package into a new folder, copy your `.env` and `data/` into that new folder, then start it. This also works when upgrading from v0.5.0. Keep the old folder until you confirm the upgrade. Database upgrades create a pre-upgrade backup automatically. Do not run two copies against the same database or use an older version against an upgraded database.

If port 3000 is already occupied, stop the other copy or set `APP_ORIGIN="http://127.0.0.1:3001"` in `.env`. If the browser doesn't open automatically, visit that address manually.

Vizor's code is rights reserved; see LICENSE. Third-party components retain their own licenses in THIRD-PARTY-LICENSES and runtime/LICENSE. Automatic updates, code signing, hosted accounts and autopilot are not included.
