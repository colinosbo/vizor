# Install and run Vizor

Vizor is a background runner, a CLI and a local web dashboard. It dispatches an approved GitHub plan to your coding agents and keeps working after you close the dashboard tab.

**Requirements:** Windows 10/11 for the supervised background runner, plus Node.js 24 (exactly major version 24; other versions are refused), Git and the GitHub CLI (`winget install --id GitHub.cli`), signed in with `gh auth login` or Git's credential manager. On macOS and Linux the CLI, doctor and dashboard work, but you run the runner in a terminal you keep open.

**Setting up with an AI agent?** Give it this package and point it at [Agent setup](#agent-setup) below. **Next, after the runner is up:** [FIRST-PLAN.md](FIRST-PLAN.md) takes you from an idle runner to the first dispatched task.

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

## Agent setup

These steps are for an AI agent with a PowerShell terminal on the user's Windows PC. The agent does the work; the human only signs in, supplies the secrets and approves. Follow the steps in order. Don't skip a check, and don't continue past a failure without fixing it.

**Ground rules**

- Never print, log, copy or ask the human to paste worker tokens into chat. The human puts them straight into `.vizor\secrets.json`.
- Never touch another Vizor project's folder, scheduled tasks or queue.
- Run every `vizor` command from the project folder.
- In a terminal opened before setup, use the full path `& "$env:LOCALAPPDATA\Vizor\bin\vizor.cmd"` instead of `vizor`.
- After each command, compare its output with the **Expect** line. On a mismatch, stop and fix it (see [When the runner does not start](#when-the-runner-does-not-start)) or ask the human.

### Step 0: Tell the human what you need, in one message

Send this before you start, filled in:

```text
I'll set up Vizor on this PC. Here's everything I need from you; I'll do the rest:
1. Stay signed in to Windows on this PC, and leave it on afterwards so the runner keeps working.
2. OK for me to install anything missing: Node.js 24, Git and the GitHub CLI (via winget).
3. Sign in to GitHub when a browser window opens. Use an account that can write to <owner/repo>.
4. Tell me the repository (owner/repo) and your workers: an ID and display name for each, e.g. builder = Builder.
5. When I open .vizor\secrets.json, paste each worker's Claude Code routine Fire URL and token, save, and tell me "done". Don't send them to me.
6. Review and merge the first-plan PR I'll open. Merging it is your approval.
```

### Step 1: Prerequisites

```powershell
node --version; git --version; gh --version
```

**Expect:** `v24.x.x`, a git version and a gh version. If any are missing, and the human said OK:

- `winget install --id Git.Git -e`
- `winget install --id GitHub.cli -e`
- Node.js 24 from https://nodejs.org (choose the v24 line). Don't use a winget "LTS" package, which may be a newer major version.

Open a new terminal after installing and re-run the check.

### Step 2: GitHub sign-in

```powershell
gh auth status
```

**Expect:** `Logged in to github.com account <login>`. If not, run `gh auth login --web --git-protocol https` and have the human complete the browser sign-in. Record the login: `gh api user --jq .login`.

### Step 3: Install Vizor

From the extracted package folder:

```powershell
node setup.mjs
```

**Expect:** `Installed Vizor <version> at …\Vizor\versions\<version>` (or `Upgraded …`). Open a new terminal, then `vizor version` prints the version.

### Step 4: Project folder

```powershell
git clone https://github.com/<owner>/<repo>.git <folder>; cd <folder>
```

(Or `cd` to the user's existing clone.) **Expect:** a folder whose `git remote -v` shows that repository.

### Step 5: Connect

```powershell
vizor connect --repo <owner/repo> --manager <login from step 2> --worker <id>=<Display Name> [--worker …]
```

**Expect:** `Connected <owner/repo> with N worker(s).` Use lowercase IDs (`builder`). Display names are what workers see in `### Task for <Display Name>`.

### Step 6: Worker credentials (human)

```powershell
notepad .vizor\secrets.json
```

Ask the human to fill in `fireUrl` and `token` for each worker, save and reply "done". A Fire URL looks like `https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`.

### Step 7: Labels and doctor

```powershell
vizor labels
vizor doctor --json
```

**Expect:** `labels` prints `Created GitHub labels: …` or `All configured GitHub labels already exist.`. `doctor --json` returns `"healthy": true` and exit code 0. If it doesn't, fix each check with `"status": "fail"` using its `detail`:

| Failing check                          | Fix                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Node.js`                              | Install Node.js 24 (step 1).                                                                            |
| `Worker <id>`                          | The human hasn't filled that worker's credentials (step 6).                                             |
| `GitHub CLI` / `GitHub authentication` | Step 1 or step 2.                                                                                       |
| `Repository access`                    | The signed-in account can't read the repo; check `--repo` and the account.                              |
| `Trusted manager`                      | The `--manager` login differs from the signed-in account; fix `trustedManagers` in `vizor.config.json`. |
| `GitHub label …`                       | Run `vizor labels` again.                                                                               |
| `Credential file excluded from Git`    | Add `.vizor/` to `.gitignore`.                                                                          |

### Step 8: Start and verify

```powershell
vizor start
vizor health
vizor open --print
```

**Expect:**

- `vizor start`: `Runner is up (pid N). Dashboard: http://127.0.0.1:<port+1>`
- `vizor health`: `"healthy": true` and `"summary": "Scheduler heartbeat current"`
- `vizor open --print`: the dashboard URL

### Step 9: First plan

Follow [FIRST-PLAN.md](FIRST-PLAN.md):

1. Write `.github/vizor-plan.json` from the example.
2. Run `vizor check-plan`.
3. Open a PR for the human to merge.
4. Set `planFile` in `.vizor\queue.json`.
5. Confirm that `vizor health` shows the plan `published` and `vizor status` lists the first tasks.

### Step 10: Report to the human

Keep it this short:

```text
Vizor is set up and running for <owner/repo>.
- Runner: healthy (vizor health). It keeps working with the dashboard closed and restarts when you sign in.
- Dashboard: http://127.0.0.1:<port+1>  (or run: vizor open)
- Workers: <ids>. Doctor: all checks pass.
- Plan: <plan id>, phase <phase> published as issues #<n>, #<n>.  [or: waiting for you to merge PR #<n>]
What I need from you now: <nothing | merge PR #n | review results on #n>
To stop: vizor stop.  To check it: vizor health.
```
