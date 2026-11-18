# Vizor initiative runtime

The initiative runtime connects an approved GitHub backlog to configured cloud workers and exposes one local queue dashboard. It uses the project's existing vizor.config.json and private .vizor state. Start it from the initiative folder.

## Windows setup

Install a release package and follow `INSTALL.md` (package root; `packaging/INSTALL.md` in the repository): `node setup.mjs`, then `vizor connect`, `vizor doctor`, `vizor start` and `vizor open` in the project folder. Requirements are Node 24, Git and the GitHub CLI, under the Windows user that will run Vizor.

`vizor start` runs this version's `windows/install.ps1` for the project. That script resolves program paths, creates a project-specific task group, and records runtime paths in the ignored `.vizor/runtime-host.json`. The tasks run under the signed-in user and restart after that user signs in following a reboot. Paths with spaces are supported. Credentials stay in `.vizor/secrets.json` or the OS Git credential helper. If `gh` is not on PATH, the installer reuses the GitHub CLI already recorded for the project. The CLI uses the same `gh` and Git credential as the runner, so `doctor` reports what the runner sees.

Installed versions live in `%LOCALAPPDATA%\Vizor\versions\<version>` and are verified against the package's SHA-256 manifest. Upgrades (`node setup.mjs` from a newer package) and `vizor rollback` hold an install lock and switch every registered project: `windows/stop.ps1`, then `install.ps1` from the target version, then a heartbeat check from the target runtime. A failure returns all projects to the previous version. Project state is never copied or rewritten.

The scheduler holds a lease on the project's queue (`runner_lease` in the project database). A second scheduler for the same project exits with "Another Vizor runner owns this project's queue" until the holder exits; a dead holder on the same PC is taken over immediately, and an unrenewed lease expires after three minutes. Every round and every dispatch re-checks the lease, so a runner that lost it stops without dispatching.

In local mode both the saved host mode and the queue select `local`; `doctor` checks their agreement and does not require webhook configuration or a listener. GitHub eligibility and result checks run every 45 seconds; ready assignments call the saved worker directly and keep the same durable duplicate protection. The scheduler and dashboard restart after Windows sign-in. When switching an already-running scheduler between modes, stop its exact Node scheduler process before starting the logon task once: updating the task action or stopping only its PowerShell wrapper does not reload that process. Disconnect the project's saved GitHub webhook after switching to local. Do not touch another project's webhooks or worker sessions.

The runtime also supports automatic artifact acceptance and automatic repair/reverification policies from the queue. These settings are project decisions.

### Optional webhook mode

Webhook mode is for operators who already run a public HTTPS endpoint (a reverse proxy or a tunnel they manage) that forwards to the local relay port. Vizor does not start or manage that endpoint.

```powershell
vizor start --webhook-url "https://hooks.example.com"
```

Run `vizor start` without the flag later to keep the saved URL. Switching back to local means setting `"dispatchMode": "local"` in the queue, running `vizor start --reinstall` and then `vizor disconnect`.

The webhook supervisor starts the relay, registers `<WebhookUrl>/webhooks/github` in GitHub and verifies a signed ping through the public URL before switching the queue to webhook dispatch. It re-verifies about every five minutes and re-registers after a failure; the scheduler holds dispatch while the endpoint is unreachable. Failures leave a diagnostic stage in .vizor/webhook-supervisor.log.

## Commands

Run these in the project folder. `vizor` with no arguments lists every command. From a source checkout, use `node <checkout>/scripts/initiative-runtime/scripts/vizor.mjs` instead.

```text
vizor doctor
vizor status
vizor schedule --preview
vizor dashboard
```

The dashboard is served on loopback at the configured webhook port plus one by default. It reads agent names, repository, issues, receipts and scheduler decisions from the same project. It never launches another scheduler.

## Verification and current limits

Run `npm test` from a source checkout. The tests exercise the install lifecycle (package, clean install, upgrade, rollback, restart, queue lease), duplicate suppression, signed webhooks, dependency gates, automatic acceptance and repair/recheck progression. The Windows health regression test exercises PowerShell 5.1's wrapped HTTP exception.

The supervised runner is Windows-only. On macOS and Linux, run `vizor schedule` and `vizor dashboard` in a terminal. Logon startup requires the PC to be on, connected and signed in. A successful logon-task installation does not establish a tested reboot.

A provider routine must stay enabled. An ambiguous provider response is retained for reconciliation to avoid duplicate sessions. End-to-end webhook restart recovery must be verified in the user's permitted environment before declaring unattended webhook operation ready.

See docs/ROADMAP.md for the remaining productization work.

## On-demand blocker investigations

Enable `blockerOrchestrator: true` in the project's private queue after the project owner approves the plan. The existing deterministic scheduler ingests missed results and services saved investigations; it does not schedule model reviews. In webhook mode the signed webhook must subscribe to both `issues` and `issue_comment` (rerun `setup` with the public URL); local mode ingests these results by polling. External/manual/capacity blocker events are recorded too. With this setting enabled, the old automatic repair loop runs only when an investigation explicitly routes an eligible software repair.

Create private `.vizor/orchestrator-host.json` in the initiative repository:

```json
{
  "executable": "C:/absolute/path/to/installed/codex.exe",
  "timeoutMs": 300000,
  "preparationIssues": [],
  "endedSessions": []
}
```

Use the existing ChatGPT login (`codex login status`). No API key or extra paid service is required. The CLI's supported `exec --json --output-schema` interface saves a persistent session ID. It receives an evidence packet from the approved repository's default-branch commit, current issue comments, prerequisites and recorded acceptance. It runs read-only with shell, apps, plugins and subagents disabled; it cannot publish or grant access. The deterministic adapter checks the bound output before posting a report or routing work. Model explanations are displayed as data; successor instructions come from fixed runtime templates and the approved original scope.

`preparationIssues` is a trusted local allowlist for separately approved preparation while the original external gate remains held. It never accepts the original issue or invents missing facts. Ordinary returned tasks use the existing replacement dependency gate and normal review/PR checks. Recovery children cannot recursively create new repair chains.

The Fire provider is start-only in this integration. [Its documented endpoint](https://code.claude.com/docs/en/routines#trigger-a-scheduled-task) returns a new session; manual continuation is documented, but a programmatic continuation or run-status endpoint is not configured. `endedSessions` contains exact original receipt URLs independently verified completed in the provider UI. A blocked marker alone does not prove termination. Without that evidence the dashboard shows `awaiting worker end`; other work continues. This is a limitation on fully unattended return for arbitrary future sessions. An operator can verify and record completion without asking the initiative owner. Never add an active or usage-paused session. Any automatic future run-state adapter must use a supported authenticated provider interface. A linked successor is explicitly a new task/chat, not a same-chat resume.

Investigations, session IDs, remote-write reservations, follow-ups and chronological activity are saved in the same project database and dashboard as the worker queue. Request/status/decision files live under ignored `.vizor/orchestrator/<run>/<attempt>`. The detached supervisor survives scheduler restarts and saves a heartbeat. Timeouts or missing acknowledgements are never retried automatically. A late status file reconciles the existing run without another launch. For a usage-paused Codex investigation with a saved session, run:

```text
node <runtime>/scripts/vizor.mjs orchestrator-status
node <runtime>/scripts/vizor.mjs orchestrator-resume <investigation-uuid>
```

Resume is on demand and uses `codex exec resume` with the same session. Worker capacity blockers retain their active original claim and are never reassigned or fired again. Unconfirmed GitHub writes reconcile using unique artifact markers. If no matching artifact is visible, retain the uncertain reservation and inspect GitHub rather than resending. Original gates remain unchanged throughout.

Windows logon actions use the non-console `wscript.exe` host and `windows/hidden-run.vbs` so PowerShell is created hidden rather than briefly showing a console. The wrapper waits and propagates the exit code, retaining Task Scheduler's restart policy. Reinstallation updates actions without interrupting running instances. A controlled runtime upgrade must separately verify and close its old Node processes; stopping only their PowerShell parent can leave a port occupied. Never terminate workers or unrelated PowerShell processes. The Windows regression test launches the wrapper with a path containing spaces and independently checks console visibility, arguments and exit propagation.

For pre-schema-tightening saved Codex runs, exact `comment ID` citations are normalized against that run's saved packet. Unknown references are rejected. This reconciliation uses the existing saved session/output and launches no second investigation.

## Supported same-cloud-chat returns (supersedes the earlier start-only return limitation)

Current official documentation supports [sending follow-ups from the CLI](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli) and [routine run history](https://code.claude.com/docs/en/routines#manage-scheduled-tasks-from-the-cli). The installed CLI was verified as 2.1.318. Sign in normally to the same Claude account (`claude auth login --claudeai`); Vizor does not extract/copy OAuth credentials or use an API key.

Add this private setting to `.vizor/orchestrator-host.json`, preserving the existing Codex executable, timeout and approved preparation issue list:

```json
{
  "cloudReturn": {
    "type": "claude-cloud-cli",
    "executable": "C:/Users/YOU/.local/bin/claude.exe",
    "triggers": {
      "research": "trig_EXISTING_RONALD_TRIGGER",
      "morgan": "trig_EXISTING_MORGAN_TRIGGER",
      "riley": "trig_EXISTING_RILEY_TRIGGER"
    }
  }
}
```

Use the existing trigger IDs from the configured Fire URLs. Remove `endedSessions` when this adapter is enabled: it is not consulted for ordinary continuation, preparation, or a repair's original-verifier return. No credentials belong in this file. `doctor` checks subscription sign-in and trigger bindings. `orchestrator-status` and the queue dashboard expose the same persisted provider observations, message receipts and result generations.

A blocked event starts at most one bounded, read-only CLI lifecycle observation per saved binding. Only actual RemoteTrigger tool results can establish a successful finish for the exact firing, agent and repository. Natural-language answers are ignored. Idle rows and another firing's last_run stay unknown. The latest-firing limitation is displayed, not hidden. Observation request/result files are private under `.vizor/provider-observations`. Deterministic reconciliation reads saved files without invoking AI on each tick.

Return uses `claude -p --cloud <exact-saved-id> --output-format json`. It queues in the existing chat, including when its prior turn is finishing, and does not start a new session or claim the prior turn ended. Only an `ok: true` response with the exact target session ID confirms delivery. The provider may display the equivalent session_/cse_ URL spelling; the returned session_id itself must match exactly. Auth failure, rejection, timeout, malformed output or mismatched identity stay held/reserved with a next step. The adapter never resends an ambiguous message or falls back to Fire.

A trusted manager comment defines the returned scope, and the worker must include the saved `Vizor return: UUID` line in its result. The new assignment threshold and return token prevent the prior turn's late comments from releasing the new claim. Explicit capacity pauses retain their session and occupied claim. Independent workers continue. A separate preparation result leaves the original live-pilot gate blocked/unaccepted.

For software findings, the original completed review remains blocked while the repair issue goes through normal worker capacity, PR merge and named checks. The dependent recheck is locally bound to the original verifier session. Its signed dispatch queues that checked assignment into the same cloud chat; no verifier Fire/new chat occurs. Recheck acceptance satisfies the existing replacement dependency gate. Repeated blocked recovery children do not spawn recursive repairs.

These are separate facts: provider firing observed completed, message provider-confirmed queued, and worker task result completed. A historical status can be unknown while a same-chat message is safely queued; provider serialization preserves one chat. This is not a generic termination detector for arbitrary cloud sessions. Failed/usage-paused runs and uncertain deliveries are never silently reclassified as completed.

## Runtime process recovery

The hidden PowerShell parent supervises each runtime child directly. An unexpected scheduler, dashboard or relay exit retries after two seconds, backing off to at most one minute on repeated failures; a healthy minute resets the delay. Configuration and GitHub credentials reload for each attempt. The saved SQLite reservations prevent a process restart from firing an existing worker twice. The webhook role exits immediately when the saved host mode is local. Windows logon tasks still restore the hidden parent after sign-in; their failure-restart setting is an additional fallback, not the only recovery mechanism.

## Approved phase publication

Set `"planFile": ".github/vizor-plan.json"` in the private queue to let the scheduler publish an approved plan phase by phase. The plan (`vizor.plan/1`: phases of tasks with owner, title, body, assignment, gate, named checks, earlier-task dependencies, priority and allowed file paths) is read from the repository's default branch, so only owner-reviewed plan changes apply. The next phase is published only after every task in all earlier phases is accepted. Publication creates each issue with its owner label, the vizor metadata block and one assignment comment, records both IDs in the project database and appends the issues to the queue. Lost responses are reconciled by unique markers and never re-sent. Only the recorded assignment comment can authorize a published task, so a copied `### Task for` heading from the shared GitHub identity is ignored. When every approved phase is accepted the dashboard reports the plan complete; no further work is invented. Publication errors hold publication only; queued work continues.

## Claude subscription blocker investigations

Set `"provider": "claude"` and the installed `claude.exe` path in `.vizor/orchestrator-host.json` to run blocker investigations with the signed-in Claude subscription instead of Codex. The CLI runs headless with no tools, no MCP servers, no setting sources and plan permission mode; API keys and GitHub tokens are not passed to it. Its session is bound by `--session-id` and only that session's structured output is saved as the decision. A usage limit records `usage_paused` with a bounded retry time; the scheduler later resumes the same session without starting another investigation. Codex remains the default when `provider` is absent.
