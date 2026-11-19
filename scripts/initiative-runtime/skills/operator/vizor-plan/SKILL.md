---
name: vizor-plan
description: Use when turning an agreed goal into a Vizor plan, adding phases to one, or handling a material change to it. Captures the agreement, writes .github/vizor-plan.json, validates it with vizor check-plan, gets it approved by merge and starts publication.
---

# Write and approve a Vizor plan

The reference for every field and rule is `FIRST-PLAN.md` (package root), with a tested example in `examples/vizor-plan.json`. This skill is the procedure.

## 1. Capture the agreement

1. Read the conversation, the repo's `PLAN.md` (if any), `AGENTS.md`/`CLAUDE.md`, `vizor.config.json` (worker IDs, names, autonomy) and the existing open issues. Keep decisions already made.
2. Write down the outcome, deliverables, scope, constraints and exit criteria. Use a short stated assumption for a routine detail nobody specified.
3. If the conversation was exploratory, draft the plan but don't merge it until the human agrees to the goal. Agreement already given in chat is enough.
4. A change that would materially alter scope, cost, permissions or outside commitments needs one explicit decision from the human. Routine task details don't.

## 2. Break it into tasks

- **One outcome per task, small enough for one PR or one artifact.** Split when work has a different owner, can be accepted on its own, or unblocks something else.
- **`gate`:** `merge` for code (needs `checks` and `paths`); `review` for research, design, audits and verification (`checks: []`, evidence is a pinned link).
- **`checks`:** the exact check-run names your CI reports. Open a recent PR's Checks tab, or run `gh pr checks <n>`. They must also run on pushes to the default branch.
- **`paths`:** as narrow as the change. Tasks touching the same files must depend on each other, never run at the same time.
- **`dependsOn`:** only keys listed earlier in the plan. Put a `review` task by a different worker before risky `merge` tasks.
- **`assignment`:** what to do, which files, what tests to add, and what evidence to post. Vizor appends the reporting rules; never write `### Task for` yourself.
- **Balance the workers:** give independent work to different workers so they run in parallel, and keep each worker's queue short.
- **Phases** group work that must be fully accepted before the next group starts.
- At the **supervised** level, list review tasks the human must judge personally in the queue's `"manualReviewIssues"` once they're published.

## 3. Validate

```powershell
vizor check-plan
```

**Expect:** `Plan is valid: <id>, N phase(s), N task(s) (…)`. Fix every error it names.

## 4. Approve

Commit `.github/vizor-plan.json` on a branch and open a PR titled "Vizor plan: <id>". The description should list the phases and tasks, owner by owner, in plain words. The human merging it is the approval. Never merge your own plan PR, even at the braZy level.

## 5. Start publication

In `.vizor\queue.json`, set `"planFile": ".github/vizor-plan.json"` and `"paused": false`. Leave `"issues"` alone. Then:

```powershell
vizor health    # snapshot.plan.state: "published", then "running"
vizor status    # the first tasks appear as they are claimed and dispatched
```

## Changing an approved plan

- **Add tasks or phases** in a new PR, keeping the same plan `id` and every published task key unchanged. Run `vizor check-plan` again.
- **Editing a published task** changes nothing on GitHub. To change live instructions, post a new `### Task for <name>` assignment comment on that issue (see `vizor-operate`), or add a follow-up task.
- **Never reuse or change the plan `id`** unless the human wants a brand-new plan.
