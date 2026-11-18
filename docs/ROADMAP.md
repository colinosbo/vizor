# Vizor roadmap

Remaining work to turn the runtime that ran the Vision pilot into a release a new user can install. Derived from the Vision POC handoff (November 18, 2026) and adjusted for two decisions made after it:

- **No desktop app.** The product is the background runner, CLI and local dashboard. Desktop items in the handoff (VZ-06 import, Desktop/CLI/dashboard agreement) now apply to the dashboard only.
- **No Cloudflare tunnel.** Local outbound dispatch is the default; webhook mode is optional with an operator-supplied public URL.

Status labels: **Done** = merged and tested in this repo. **Runtime present** = code and tests exist; packaging or live proof is open. **Open** = capability still missing.

## Release order

| Order    | Work package                                                                                                                                                                                                         | Completion evidence                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 · P0   | **Package the runtime.** Versioned install outside the source checkout, setup walkthrough, upgrade/rollback, uninstall, credential replacement, status/start/stop/restart (VZ-01, 10, 11, 18, 23).                   | A fresh Windows account connects its own private repo and workers, sees the live queue, and restarts/restores without duplicate dispatch.  |
| 2 · P0   | **Delivery policy and recovery.** Provider error categories, ambiguous-start reconciliation, stale-PR handling, exact-SHA checks, same-chat context (VZ-03, 04, 05, 07, 08, 09, 12, 13, 14, 16, 17, 20, 22, 24, 25). | A protected test repo shows normal CI progress, one stale-PR alert, safe recovery, merged-commit check and exactly one successor dispatch. |
| 3 · P0   | **Planning and worker instructions.** Approval preview, phase generation, workload balancing, reusable worker templates (VZ-21, 26, 27, 28).                                                                         | Three workers run independent ready work with a real dependency and a review exception; rebalancing never touches active receipts.         |
| 4 · Gate | **Independent onboarding rehearsal.** Someone who did not build Vision installs from the release on another repo and account.                                                                                        | Release tag, platform/mode coverage, sanitized logs, issue/PR/check evidence and stated limits.                                            |

## Shipped in 0.12.0: runtime packaging

**Implemented**

- `npm run package` builds `vizor-<version>.zip`. It contains `setup.mjs`, `INSTALL.md` and the runtime with a SHA-256 manifest, and excludes tests. A `v*` tag publishes it as a release.
- `node setup.mjs` installs to `%LOCALAPPDATA%\Vizor\versions\<version>`, adds `vizor` shims to PATH, and reuses an identical installed version. An upgrade switches every registered project (stop, install from the target version, heartbeat check) and returns all of them to the previous version on any failure. `vizor rollback` does the same in reverse. An install lock prevents concurrent installs; tampered versions are refused.
- **Queue lease:** only one scheduler dispatches a project's queue. A second one exits before touching GitHub or the provider. A dead holder is taken over immediately, and an unrenewed lease expires after 3 minutes. Every round and every dispatch re-checks the lease.
- **One user path:** `vizor connect`, `labels`, `doctor`, `start`, `open`, `stop`, `restart`, `versions` and `rollback`. Windows `stop.ps1`/`start.ps1` reuse the existing tasks and exact-process matching. Doctor passes on a new project before its first start, and the CLI uses the runner's recorded `gh` and Git credential.

**Verified (synthetic data, isolated install home, no source checkout)**

- Install from the extracted zip (unzip on Linux, Expand-Archive on Windows in CI) with the download deleted afterwards. Then connect, dispatch #7 (confirmed) and #8 (provider reply lost).
- An upgrade leaves project files unchanged. Two restarts on the new version: **#7 and #8 each fired once**, with identical delivery IDs, sessions and claims. A second runner is refused while the first holds the queue.
- Rollback while the holder is alive, then a hard kill: the old version takes over and recovers the same receipts with no new fire. A locked install and a tampered version are both refused.
- Windows CI: `stop.ps1` stops only this project's supervisor and runtime process, leaves another project running, and disables the tasks. `start.ps1` re-enables them. The Task Scheduler cmdlets are mocked; the processes are real.

**Not verified (needs a real Windows account)**

- Task Scheduler registration through `vizor start`, a live upgrade and rollback of a running project, reboot, sign-out/in, and the user PATH change made by `setup.mjs`.
- Uninstall and credential replacement have no command yet. Credentials are edited in `.vizor\secrets.json`.

**Next release blocker:** run the live Windows rehearsal of 0.12.0 on a throwaway project. Then VZ-25 (stale-PR status and a single alert, from Vision #106's accepted spec), the first open item in work package 2.

## Status by item

| ID    | Item                                                                    | Status                                                                                                                                                                                     |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VZ-01 | Supervised install, restart, signed-out/reboot states                   | Package present (0.12.0): `vizor start/stop/restart/health`, tasks reused. Live Windows rehearsal (fresh account, reboot, sign-out, child kill) not run.                                   |
| VZ-02 | Outbound local dispatch by default; optional webhook                    | Done (tunnel removed). Live webhook check with a real public URL is open.                                                                                                                  |
| VZ-03 | Redacted provider error categories and next action                      | Open.                                                                                                                                                                                      |
| VZ-04 | Ambiguous start reconciliation and attempt history                      | Runtime present; operator UX open.                                                                                                                                                         |
| VZ-05 | Opt-in automatic acceptance with manual exceptions                      | Pilot verified.                                                                                                                                                                            |
| VZ-06 | Dashboard attaches to existing project config, queue and receipts       | Open: preview/import of an existing project and a clean new project from the dashboard or CLI.                                                                                             |
| VZ-07 | Distinct stale/scope/conflict/check/unmerged states with SHA and action | Open.                                                                                                                                                                                      |
| VZ-08 | Repo policy generated from the approved plan                            | Pilot verified; portability to a non-Vision repo open.                                                                                                                                     |
| VZ-09 | Separate manager and worker identities; no self-approval                | Runtime present; install and enforcement proof open.                                                                                                                                       |
| VZ-10 | Preflight with the daemon's identity and least privilege                | Partial (0.12.0): CLI and doctor use the runner's recorded `gh` and Git credential. Least-privilege token checks are open.                                                                 |
| VZ-11 | Versioned runtime outside the source tree                               | Done in package (0.12.0): hashed versions under `%LOCALAPPDATA%\Vizor`, upgrade/rollback with install lock and automatic revert. Verified on synthetic data; live Windows upgrade not run. |
| VZ-12 | Capacity pause and same-session resume                                  | Runtime present.                                                                                                                                                                           |
| VZ-13 | Start confirmed vs. observed state vs. uncertainty                      | Runtime present; visibility open.                                                                                                                                                          |
| VZ-14 | Idempotent close/reconcile; artifact vs. merged code                    | Pilot verified.                                                                                                                                                                            |
| VZ-16 | Validate generated workflow YAML and payloads                           | Pilot fixed.                                                                                                                                                                               |
| VZ-17 | Explicit exact-SHA post-merge verification                              | Pilot verified.                                                                                                                                                                            |
| VZ-18 | Snapshot age, sync health, next eligible work in the dashboard          | Runtime present; test with dead process, slow sync and idle queue.                                                                                                                         |
| VZ-19 | Readiness defined by a full chain through restart and recovery          | Open.                                                                                                                                                                                      |
| VZ-20 | Exact check identity, app, matrix naming, pagination                    | Open.                                                                                                                                                                                      |
| VZ-21 | Approved phase publishing with stable task IDs                          | Pilot verified.                                                                                                                                                                            |
| VZ-22 | Bounded repair and independent recheck                                  | Pilot verified.                                                                                                                                                                            |
| VZ-23 | Rate holds, ETag caching, transient errors                              | Runtime present.                                                                                                                                                                           |
| VZ-24 | Same-chat return, queued vs. completed vs. accepted                     | Runtime present; live proof partial.                                                                                                                                                       |
| VZ-25 | Stale-PR status, one alert per PR/base/head, clear on recovery          | Open (Vision #106 has the accepted specification).                                                                                                                                         |
| VZ-26 | Workload balancing by effort, readiness and skill                       | Open for permanent adoption.                                                                                                                                                               |
| VZ-27 | Reusable worker templates                                               | Pilot verified; ship templates.                                                                                                                                                            |
| VZ-28 | Independent evidence review as a first-class dependency                 | Pilot verified.                                                                                                                                                                            |

## New-user acceptance checklist

- Install on a fresh Windows account without a developer checkout. Verify startup, reboot, sign-out/in, child failure, upgrade, rollback and restored state.
- Connect a new private repo with the user's own providers and documented minimum access. Missing/expired credentials and paused routines produce distinct explanations.
- Approve a two-phase synthetic plan; publish once; run independent work concurrently; verify merge and artifact gates.
- Advance the default branch while a PR is open: one stale hold, one alert, recovery with fresh exact-SHA checks. Separately, healthy CI still running shows as progress.
- Exercise ambiguous starts, missing CI, lost publication response, a capacity pause and a restart: one receipt and one successor start.
- Trigger a reproducible defect and an external permission gate: bounded repair, independent recheck, downstream release, external work stays held.
- Close and reopen the dashboard tab: same project, state age, workers, hold reasons and next work as the CLI. Package and sample logs contain only synthetic data.
