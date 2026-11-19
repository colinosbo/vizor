---
name: vizor-operate
description: Use to run, check or recover a Vizor project day to day - status, accepting results, answering blocked workers, stuck or ambiguous dispatches, stale PRs, stop/start/restart, upgrade and rollback. Works from vizor doctor/health/status evidence, never guesses.
---

# Operate and recover Vizor

Work from evidence: `vizor health`, `vizor status`, `vizor doctor --json`, the dashboard (`vizor open`) and the GitHub issues and PRs. Run every command from the project folder.

## Daily check

```powershell
vizor health          # "healthy": true; snapshot.errors empty; snapshot.plan.state
vizor status          # receipts (started/unconfirmed) and claims (active, result, pull, accepted)
```

For each task in the snapshot, read its status line. It tells you exactly what Vizor is waiting for.

## Accept results

- **Review tasks:** read the evidence linked in the worker's `Vizor result: done` comment. If it meets the acceptance criteria, run `vizor accept <issue>`. At the Standard and braZy levels, these are accepted automatically unless listed in `manualReviewIssues`.
- **Merge tasks** accept themselves once the PR is merged and the named checks pass on the merge commit. If one isn't accepting, the status line says why: a draft PR, a review hold, a merge conflict, the branch behind the default branch, checks pending or failed, or checks missing on the merge commit.

## Answer a blocked worker

A `Vizor result: blocked` comment holds that task and everything that depends on it. How it resumes depends on the project's setup:

- **Blocker investigation enabled** (`"blockerOrchestrator": true` in the queue and `.vizor\orchestrator-host.json` set up, as described in the runtime README): Vizor investigates the blocker and posts a report on the issue. It routes defects to a repair task, and with same-chat return configured, sends the worker back into its original chat. For a decision only the human can make, post the answer as described below, then run `vizor orchestrator-status` to follow it.
- **Not enabled:** Vizor does **not** read a later result on a blocked task, so the task stays held. Tell the human, recommend enabling the blocker investigation, and stop. Don't try to unstick it by relabelling or re-firing. On review tasks, automatic repair (`vizor autonomy brazy --repair-agent …`) still handles reproducible defects without the investigation.

To answer the worker's question:

1. Read the worker's `## Blocked:` comment: type, question, options, recommendation and checkpoint.
2. Decide yourself only if it's a routine in-scope detail and the autonomy level allows it. Otherwise, ask the human the worker's exact question with its options.
3. Post a **new comment on the same issue, from a trusted manager login**, starting with the exact line `### Task for <worker display name>`. Then give the answer, any change in scope, and "Continue from your checkpoint on the same branch and PR." Workers ignore plain comments without that heading.

Never answer with work assigned to a different worker. Never widen scope without the human's decision.

## Stuck or ambiguous dispatch

- **`unconfirmed` receipt:** the provider may or may not have started the run. Check the worker's routine run history in Claude **before** doing anything. If a run exists, follow it. **Never** remove and re-add the dispatch label, and never re-fire. Vizor deliberately doesn't retry ambiguous starts.
- **Worker occupied:** each worker runs one task at a time. Independent tasks for other workers keep moving.
- **Capacity pause** (`Vizor blocker: capacity`): the assignment and chat stay reserved until usage resets. Do nothing.

## Stale or failing PRs

- **"The PR branch is behind …":** update the PR branch from the default branch (GitHub "Update branch", or ask the worker via a new assignment comment), then let the checks rerun.
- **"PR checks failed":** read the failing check. If it's the task's own change, send the worker a new assignment comment with the failure. If it's unrelated, tell the human.
- **"Merged PR is missing verified checks":** the named checks didn't run on the merge commit. Make sure the workflow runs on pushes to the default branch.

## Runner problems

| Symptom                                                   | Do                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `vizor health` says heartbeat missing or stale            | `vizor doctor --json`, fix each failing check, then `vizor start`.                |
| Log says "Another Vizor runner owns this project's queue" | An old process is still running: `vizor stop`, then `vizor start`.                |
| Tasks broken or pointing at an old version                | `vizor start --reinstall`.                                                        |
| Scheduler stuck, everything else fine                     | `vizor restart`.                                                                  |
| Need to pause everything                                  | `vizor stop` (stays stopped through sign-in and upgrades); `vizor start` resumes. |

## Upgrade and rollback

- **Upgrade:** extract the new release zip and run `node setup.mjs`. Every registered project switches, or all of them return to the previous version.
- **Roll back:** `vizor rollback`.
- **Check afterwards:** `vizor versions` and `vizor health` (the `executable` path shows the running version).

## Change autonomy

`vizor autonomy` shows the current level. `vizor autonomy supervised | standard | brazy` changes it. Commit `vizor.config.json` afterwards so the workers see the new level.

## Never

- Re-fire, relabel or duplicate an assignment to "unstick" it.
- Edit `.vizor\` database files or receipts by hand.
- Print or move worker tokens.
- Merge a PR at the Supervised or Standard level without the human's go-ahead.
