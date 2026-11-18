# Vision / Vizor workflow review

Reviewed against the supplied Nov 17, 2026 run-readiness list. This is an audit of the existing workflow, not authorization for a replacement architecture. Existing subscriptions and included usage only; no additional paid services. Colin is handling account billing limits; those settings were not verified here.

## Readiness judgment

The existing workflow has working parts, but complete unattended operation is not yet proven. A passing local test is not a deployed fix. In particular, new issue numbers still encounter the current merge allowlist, an empty queue has no next-phase publisher, and the complete live repair-to-original-verifier loop remains unverified.

## Actual workflow

1. The manager records an approved task in GitHub and binds its assignment in Vizor.
2. The scheduler checks dependencies and reserves a dispatch before contacting the provider. Local dispatch does not require a public tunnel.
3. The worker uses its branch, posts evidence and a result, and opens a PR for code changes.
4. GitHub runs tests. The current merge workflow also checks the task, report, allowed files and exact tested commit. Passing tests alone do not admit an unknown task number.
5. Vizor accepts review evidence or waits for the PR and required checks on the merge commit. Accepted work closes automatically and releases queued dependents.
6. A routine blocker can enter investigation or repair/recheck handling. Capacity pauses retain the original assignment. External decisions remain held.
7. Queued ready work can continue. Creating the next phase's issues is a separate missing step.

## Checklist findings

| Item | Finding and evidence | Status |
|---|---|---|
| 1 API exhaustion | Persistent conditional requests, accepted-task caching and shared snapshots implemented in Vizor commit `0fe367f`. Simulated 25-task hour: 127 charged requests, 2,133 conditional responses, 4,873 remaining. Actual one-hour hosted measurement still required. | Tested locally; not deployed |
| 2 Misleading API errors | The same commit distinguishes status, remaining budget, reset and retry time; forced 403/429 tests pass. | Tested locally; not deployed |
| 3 New task numbers cannot merge | Vision main's merge script still contains a literal issue allowlist and issue-specific paths. Existing tests pass within those limits. | Confirmed open bug |
| 4 Next phase creation | Current queue contains only completed #57. No automatic next-phase issue publisher is installed. Finishing queued dependencies and creating future tasks are different operations. | Confirmed missing behavior |
| 5 Codex availability | Live host still uses the Codex investigator. A separate Claude subscription probe succeeded, but that does not prove integrated blocker recovery or automatic usage reset. Draft provider work is not deployed. | Open integration and live verification |
| 6 Shared identity | Both manager and workers post as the same GitHub login. The current heading/author checks cannot distinguish them. Worker instructions are a convention, not enforced identity separation. | Confirmed limitation |
| 7 Untracked live runtime | Host configuration still points inside the dirty original Vizor checkout. Canonical code is committed on main, but live execution has not moved to a clean pinned checkout. | Open deployment fix |
| 8 Duplicate scheduler | Vision's main branch still contains its separate scheduler implementation. | Confirmed maintenance risk |
| 9 Restart and health | `0fe367f` adds project-scoped serialized restart and health commands. Windows integration tests verify concurrent callers and other-project isolation. Existing live parent recovery was separately demonstrated. New command is not installed live. | Tested locally; deployment pending |
| 10 Heartbeat/logging | Atomic snapshots and timestamped UTF-8 logs are implemented in `0fe367f`; stale/missing/error tests pass. Live host still runs the older implementation. | Tested locally; not deployed |
| 11 Pruned prerequisites | Accepted task metadata outside the queue is supported and tested in `0fe367f`. | Tested locally; not deployed |
| 12 Closed prerequisites | Closed/not-planned unaccepted prerequisites now produce explicit dependent holds in local tests. They are not silently treated as successful work. | Tested locally; not deployed |
| 13 Tunnel dependency | Live host and queue both select local mode; webhook task disabled. Recorded #60 control run dispatched, completed, was accepted and closed without a tunnel. | Live evidence recorded |
| 14 Prompt editing | Short skill-based prompts reduce editing needs. Supported editing of the actual installed provider routines was not re-verified during this audit. Do not recreate their Fire credentials speculatively. | Verification outstanding |
| 15 Main-before-dispatch | Workers use main, but no future-phase publisher exists to enforce that ordering automatically. | Planner enforcement outstanding |
| 16 Protected scope | Existing merge tests reject unrelated workflows, policy edits, changed heads and out-of-scope renames. New task scope remains tied to the hard-coded policy in item 3. | Existing protection tested; dynamic scope open |
| 17 Weak artifact acceptance | `0fe367f` requires immutable evidence links for automatic review acceptance. This rejects bare result markers, but a link is not substantive independent review. | Local guard tested; quality limitation remains |
| 18 Ambiguous starts | Provider metadata, lost-response reconciliation and exact-session sending tests pass. New dashboard wording separates confirmed start from unknown present activity. | Local regression tests pass |
| 19 Usage pauses | Tests verify the original slot/session remain occupied and no replacement is fired. An actual live pause/reset cycle was not forced during this audit. | Tested; live reset not re-verified |
| 20 Repair/recheck loop | Tests cover repair creation, required merge/check dependencies and recheck in the original verifier chat without another Fire. The complete live chain has not been demonstrated. | Critical live test outstanding |
| 21 Branch clutter | Artifact/feature branches remain. No branch was deleted during this review; preservation and merged-branch inventory must precede cleanup. | Cleanup outstanding |
| 22 Old worktrees | Current Vision inventory contains 15 worktrees, including the active policy checkout; the document's count of 13 is stale. No unpushed-work audit or deletion completed. | Cleanup outstanding |
| 23 Planning docs | Original Vision checkout still has its modified PLAN and four untracked planning/handoff documents. They were preserved untouched. | Archival/commit outstanding |
| 24 Windows CI/Node | Node 24 required by the new host commands/installer; meaningful Windows timeout tests pass in the full 37-test local run. Hosted cross-platform checks have not run for this commit. | Local pass; hosted checks pending |
| 25 Dashboard duplication | `0fe367f` makes the dashboard consume the scheduler snapshot rather than perform its own GitHub reconciliation. | Tested locally; not deployed |

## Checks run during this review

- All 37 runtime tests pass on the isolated `codex/readiness-core` checkout at `0fe367f`, including Windows restart tests.
- All 6 existing Vision auto-merge tests pass at main revision `5ffb08a`. They confirm current gates, not support for arbitrary future issue numbers.
- GitHub currently reports no open Vision PRs and #57 closed as completed. #58 and #59 are merged; that document's waiting section is stale.
- Installed relay, scheduler and dashboard tasks report running; the old webhook task is disabled. Task Scheduler state alone is not a heartbeat or proof that work is advancing.
- Existing private verification records show #60's no-tunnel control and automatic Node child recovery under its hidden parent. These were not repeated as new live repair-loop evidence.

## Finish criteria

Keep the original workflow. Deploy the reviewed operational fixes through normal checked PRs, remove the task-number merge restriction through an approved versioned scope policy, verify next-phase creation and routine blocker handling, then run one controlled repair -> checked merge -> original-chat recheck -> dependent release. Record each result separately. Do not declare all 25 items fixed merely because the local suite passes.
