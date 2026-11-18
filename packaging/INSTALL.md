# Install and run Vizor

Vizor is a background runner, a CLI and a local web dashboard. It dispatches an approved GitHub plan to your coding agents and keeps working after you close the dashboard tab.

**Requirements:** Windows 10/11 for the supervised background runner, plus Node.js 24, Git and the GitHub CLI (`winget install --id GitHub.cli`), signed in with `gh auth login` or Git's credential manager. On macOS and Linux the CLI, doctor and dashboard work, but you run the runner in a terminal you keep open.

## 1. Install

Extract this package anywhere and run:

```powershell
node setup.mjs
```

Vizor installs to `%LOCALAPPDATA%\Vizor\versions\<version>` and adds `%LOCALAPPDATA%\Vizor\bin` to your user PATH. Open a new terminal afterwards. You can delete the extracted folder.

## 2. Connect your repository and workers

In your project folder (a clone of the repository Vizor will manage):

```powershell
vizor connect --repo <owner/repo> --manager <your GitHub login> --worker builder=Builder --worker reviewer=Reviewer
```

Then paste each worker's routine `fireUrl` and `token` into `.vizor\secrets.json`. That file, the queue and all receipts stay in `.vizor\`, which is added to `.gitignore`.

## 3. Check, start and open

```powershell
vizor labels   # creates the dispatch and worker labels in GitHub
vizor doctor   # every line should say PASS; nothing is dispatched
vizor start    # installs and starts the background runner for this project
vizor open     # opens the dashboard at http://127.0.0.1:<port+1>
```

Dispatch is local by default: the runner polls GitHub and calls workers directly, with no public endpoint. Closing the dashboard tab does not stop the runner. Reopening it shows the same queue, workers, checks and blockers.

## Day to day

| Task                                | Command                        |
| ----------------------------------- | ------------------------------ |
| Status and receipts                 | `vizor status`, `vizor health` |
| Stop (stays stopped across sign-in) | `vizor stop`                   |
| Start again                         | `vizor start`                  |
| Restart the scheduler only          | `vizor restart`                |
| Installed versions                  | `vizor versions`               |

## Upgrade and roll back

**Upgrade:** extract the new package and run `node setup.mjs`. Each registered project is stopped, switched to the new version and must report a heartbeat from it. If any project fails, every project is returned to the previous version.

**Roll back:** run `vizor rollback`, which switches back to the previous version the same way.

Upgrades and rollbacks never copy or change project configuration, credentials, the queue or dispatch receipts. Only one runner can dispatch a project's queue at a time. A second runner (an overlapping old version, a manual `vizor schedule`) refuses to start until the first one has exited.

## When the runner does not start

1. Run `vizor doctor` in the project folder and fix every `FAIL` line.
2. Run `vizor health`. "Scheduler heartbeat missing" or "stopped" means no runner is alive.
3. Read `.vizor\host-scheduler.log`. A line saying "Another Vizor runner owns this project's queue" means an older process is still running. Run `vizor stop`, then `vizor start`.
4. Run `vizor start --reinstall` to re-register this project's tasks from the current version.
5. The runner needs the PC on and your Windows user signed in.
