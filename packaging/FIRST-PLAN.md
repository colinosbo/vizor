# Your first plan

This guide takes a connected, running Vizor project from "runner is up, nothing to do" to "the first task was dispatched". Do [INSTALL.md](INSTALL.md) first: `vizor doctor` must pass and `vizor health` must report `"healthy": true`.

A ready-to-edit example is in `examples/vizor-plan.json` (`packaging/examples/` in the repository). Copy it and change it rather than starting from a blank file.

## How work flows

1. **You write a plan** (`.github/vizor-plan.json`): phases of tasks, each with an owner (a worker), instructions, a completion gate, checks, dependencies and the files it may change.
2. **You approve it by merging it into the default branch.** Vizor reads the plan only from the default branch, so nothing unreviewed is ever published.
3. **You point the project's queue at it** (`"planFile"` in `.vizor\queue.json`).
4. **The runner publishes the first phase.** For each task it creates one GitHub issue (labelled with the worker) and one assignment comment headed `### Task for <worker name>`, then adds the issue numbers to the queue.
5. **The runner dispatches ready tasks.** A task is ready when its dependencies are accepted and its worker is free. Vizor calls the worker's Claude Code routine with a link to the assignment comment. One task per worker runs at a time; different workers run in parallel.
6. **The worker does the task** and posts a result comment on the issue: `Vizor result: done`, `Vizor result: done (PR #N)` or `Vizor result: blocked`.
7. **The gate decides acceptance.** A review task is accepted from its evidence. A merge task is accepted only once its PR is merged and every named check has passed on the merged commit.
8. **Accepted tasks release their dependents.** When every task in a phase is accepted, the runner publishes the next phase. When every phase is accepted, the plan is complete and Vizor invents nothing more.

Vizor never merges PRs. You merge them, or your repository merges them automatically (see "Who merges").

## Before you write the plan

- **Worker IDs and names.** These come from `vizor.config.json`. Each task's `agent` must be a worker ID (for example `builder`). The assignment heading uses the worker's display name (`### Task for Builder`), and Vizor writes it for you.
- **Workers can reach the repository.** Each worker is a Claude Code routine connected to GitHub with access to this repository.
- **Results are posted by a trusted login.** A result counts only if it is posted after the assignment comment by a login in that worker's `trustedManagers` (normally your own GitHub account, which the routine posts as).
- **Check names.** For merge tasks, find the exact check names your CI reports on a PR: open any PR, then Checks, and use the job names (for example `test`). They are case-sensitive, and each name must match exactly one check on the commit.
- **Post-merge checks.** Merge tasks are verified on the merge commit, so the named checks must also run on pushes to the default branch (`on: push: branches: [main]` in GitHub Actions). `examples/vizor-checks.yml` is a starter workflow that does this, and `vizor doctor` fails while a named check has not run on the default branch. If a bot account using `GITHUB_TOKEN` merges, GitHub does not start push workflows, so dispatch the check workflow explicitly or merge as a user.

## The plan file

Path: `.github/vizor-plan.json` on the default branch. It is JSON, and Vizor rejects the whole plan if any rule below is broken.

| Field            | Rules                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`         | Always `"vizor.plan/1"`.                                                                                                                                                                                                                      |
| `repository`     | `owner/repo`, exactly as in `vizor.config.json`.                                                                                                                                                                                              |
| `id`             | Plan ID: lowercase letters, digits, `.`, `_`, `-`; starts with a letter or digit; up to 80 characters. **Never change it after publishing**: published tasks are tracked by plan ID and task key, and a new ID is a new plan with new issues. |
| `phases`         | 1–32 phases, run in order.                                                                                                                                                                                                                    |
| `phases[].id`    | Same format as the plan ID, unique in the plan.                                                                                                                                                                                               |
| `phases[].tasks` | 1–64 tasks.                                                                                                                                                                                                                                   |
| `key`            | Same format as the plan ID, unique across the whole plan. Never rename a published task.                                                                                                                                                      |
| `agent`          | A worker ID from `vizor.config.json`.                                                                                                                                                                                                         |
| `title`          | The GitHub issue title.                                                                                                                                                                                                                       |
| `body`           | The issue description: the outcome and context. Must not contain a ` ```vizor ` block (Vizor adds its own).                                                                                                                                   |
| `assignment`     | Instructions for the worker: what to do, where, and what to deliver. Must not contain `### Task for` (Vizor writes the heading). Vizor appends the reporting rules for the task's gate.                                                       |
| `gate`           | `"review"`: done when the worker posts evidence and the result is accepted. `"merge"`: done when the worker's PR is merged and the checks pass on the merged commit.                                                                          |
| `checks`         | Review tasks: must be `[]`. Merge tasks: at least one check name.                                                                                                                                                                             |
| `paths`          | Files the task may change: repository-relative, forward slashes, no `..`, and no bare `*` or `**`; `dir/**` covers a folder. Merge tasks need at least one; review tasks usually use `[]`.                                                    |
| `dependsOn`      | Keys of tasks **listed earlier in the plan** (the same phase or an earlier one). Forward references and cycles are rejected.                                                                                                                  |
| `priority`       | Whole number of 0 or more. Among ready tasks for the same worker, the lower number goes first.                                                                                                                                                |

Text fields can be up to 30,000 characters.

### Writing good tasks

- **One outcome per task, small enough for one PR.** Split big work into dependent tasks.
- **Make `paths` as narrow as the change.** Two tasks that touch the same files should depend on each other, so they are never in flight at the same time.
- **Say what "done" looks like in `assignment`:** the files, the behaviour, the tests to add and the evidence to post.
- **Use a review task for research, audits and designs.** The evidence is a pushed commit or file linked by an immutable `https://github.com/<owner>/<repo>/commit/<sha>` or `/blob/<sha>/...` link. A branch link does not count.
- **Put an independent review task before risky merge tasks**, assigned to a different worker than the builder.

## Approve and start

1. **Write the plan.** Copy `examples/vizor-plan.json` to `.github/vizor-plan.json` in the project folder. Set `repository`, use your worker IDs, and replace the tasks with yours.
2. **Check it before committing.** In the project folder, run:
   ```powershell
   vizor check-plan
   ```
   You should see `Plan is valid: <id>, N phase(s), N task(s) (...)`. It runs the same validation as the runner, plus the repository match. An error names the first task that breaks a rule.
3. **Approve it.** Commit it on a branch, open a PR and review it. Merging it into the default branch is the approval.
4. **Point the queue at it.** In `.vizor\queue.json`, set `"planFile": ".github/vizor-plan.json"` and `"paused": false`, and leave `"issues"` as it is (Vizor adds to it). Optionally add `"autoAcceptReviews": true` (below).
5. **Watch the first phase publish** within about a minute:
   ```powershell
   vizor health    # snapshot.plan.state becomes "published", then "running"
   vizor status    # the new issues appear as they are claimed and dispatched
   vizor open      # dashboard: phase, tasks, workers, what happens next
   ```

You can also put the plan file in place before connecting. Nothing is published until `planFile` is set and the queue is unpaused.

## Accepting results

- **Merge tasks** are accepted automatically once the linked PR is merged and every named check passed on the merge commit. The worker's PR body must contain the line `Vizor issue: #<issue>`, and its result must be `Vizor result: done (PR #<number>)`. The assignment Vizor writes tells the worker both.
- **Review tasks** need acceptance:
  - Manually: `vizor accept <issue>` after you read the evidence.
  - Automatically: set `"autoAcceptReviews": true` in the queue. A done result with an immutable evidence link is then accepted. List issues that must always wait for you in `"manualReviewIssues": [12, 15]`.
- **Blocked tasks** (`Vizor result: blocked`) hold their dependents. Fix the cause, then reply on the issue, or set up the blocker investigation described in the runtime README.

## Who merges

Vizor waits for the merge; it does not perform it. Pick one approach:

- **You merge** each PR after review. This is the simplest and best for a first plan.
- **GitHub auto-merge.** Run `vizor rails` (Standard and braZy autonomy). It turns on "Allow auto-merge" and adds a `Vizor merge rails` ruleset requiring the plan's checks on the default branch. Then each PR merges itself once the checks pass. Run it again whenever a merged plan adds a check; `vizor doctor` fails until you do.
- **Your own checked-merge workflow**, as in the Vision pilot. Have it dispatch the post-merge checks explicitly if it merges with `GITHUB_TOKEN`.

## Changing the plan

- **Add phases or tasks** by merging an updated plan with the same `id`. New tasks in an unpublished phase publish when that phase's turn comes.
- **Editing a published task** changes nothing on GitHub: the issue and assignment already exist. Correct the issue or post a new assignment by hand, or add a follow-up task.
- **To stop work,** set `"paused": true` in the queue. Running tasks finish their current run, and nothing new is dispatched.

## Troubleshooting

`vizor health` shows the plan state and any errors. Common messages:

| Message                                                       | Fix                                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `No approved plan on the default branch.`                     | The file isn't merged yet, or `planFile` points at the wrong path.                                                                                           |
| `Invalid approved plan.` / `Invalid phase.`                   | `schema`, `repository`, `id` or the phases list breaks a rule above.                                                                                         |
| `Invalid, out-of-order or cyclic plan task: <key>`            | That task breaks a rule above. Usual causes: an unknown worker, a dependency listed later, checks on a review task, or a merge task missing checks or paths. |
| `Approved plan belongs to another repository.`                | `repository` differs from `vizor.config.json`.                                                                                                               |
| `GitHub account lacks assignment authority for <key>`         | The account the runner uses isn't in that worker's `trustedManagers`.                                                                                        |
| `Publication of plan task <key> is unconfirmed`               | A GitHub write timed out. Check the issue list for that task, then let the runner reconcile. Vizor never posts it twice.                                     |
| `Waiting for PR checks: …` / `PR checks failed: …`            | The check names don't match your CI, or the checks failed.                                                                                                   |
| `Merged PR is missing verified checks on the default branch.` | The checks didn't run on the merge commit (see "Post-merge checks").                                                                                         |
| `The PR branch is behind main. Sync it and rerun checks.`     | Update the PR branch from the default branch.                                                                                                                |
