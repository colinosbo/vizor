# Vizor initiative runtime

The initiative runtime connects an approved GitHub backlog to configured cloud workers and exposes one local queue dashboard. It uses the project's existing vizor.config.json and private .vizor state. Start it from the initiative folder.

## Windows setup

Install Node 24, Git, GitHub CLI and cloudflared. Connect GitHub under the Windows user that will run Vizor, and configure the workers through the existing init/setup flow.

Run the installer from PowerShell, pointing to your project and queue.

```powershell
& "<Vizor checkout>\scripts\initiative-runtime\windows\install.ps1" -ProjectPath "<project folder>" -QueuePath ".vizor\queue.json" -Mode webhook
```

The installer resolves program paths, creates a project-specific task group and stores runtime paths in the ignored .vizor/runtime-host.json. It runs under the signed-in user and restarts after that user signs in following a reboot. It supports paths containing spaces. Runtime credentials stay in .vizor/secrets.json or the OS Git credential helper.

The webhook supervisor starts the local relay, starts a Quick Tunnel, registers its new URL in GitHub, and checks the signed connection before switching dispatch mode. The scheduler owns assignment eligibility. When it applies the dispatch label, the GitHub webhook calls the relay and the relay starts the saved worker assignment. Quick Tunnel URLs change on restart, and the supervisor updates GitHub before restarting the scheduler with the new endpoint. A tunnel exit causes reconstruction. Failed startup leaves a diagnostic stage in .vizor/webhook-supervisor.log.

Local mode is available with -Mode local. The runtime also supports automatic artifact acceptance and automatic repair/reverification policies from the queue. These settings are project decisions.

## Commands

Run these in the configured project directory, using this runtime's scripts/vizor.mjs.

```text
node <runtime>/scripts/vizor.mjs doctor
node <runtime>/scripts/vizor.mjs status
node <runtime>/scripts/vizor.mjs schedule .vizor/queue.json --preview
node <runtime>/scripts/vizor.mjs dashboard .vizor/queue.json
```

The dashboard is served on loopback at the configured webhook port plus one by default. It reads agent names, repository, issues, receipts and scheduler decisions from the same project. It never launches another scheduler.

## Verification and current limits

Run node --test scripts/initiative-runtime/tests/*.test.mjs from the Vizor checkout. The tests exercise duplicate suppression, signed webhooks, dependency gates, automatic acceptance and repair/recheck progression. The Windows health regression test exercises PowerShell 5.1's wrapped HTTP exception.

This is a source-integrated runtime. The desktop installer does not yet bundle or invoke these components through a setup screen. Installed paths must remain available. Logon startup requires the PC to be on, connected and signed in. A successful logon-task installation does not establish a tested reboot.

Quick Tunnels are temporary testing endpoints. A provider routine must stay enabled. An ambiguous provider response is retained for reconciliation to avoid duplicate sessions. End-to-end webhook restart recovery must be verified in the user's permitted environment before declaring unattended webhook operation ready.

See docs/vision-pilot-handoff.md for the broader productization work.
