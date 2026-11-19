---
name: vizor-deliver
description: Use when a Vizor worker finishes its assignment. Covers code PRs (merge gate), research and verification artifacts (review gate), merging at the braZy autonomy level, and the exact result comment Vizor reads.
---

# Deliver a Vizor assignment

The `gate` in the issue's `vizor` block decides how you deliver. Vizor parses the marker lines below exactly, so copy them character for character, each on its own line.

## Merge gate (code)

1. Work on one task branch created from the current default branch. Change only the allowed files listed on the issue.
2. Add or update tests and run the project's tests (see `AGENTS.md`, `CLAUDE.md` or the README). Record the pass/fail counts.
3. Open **one** PR against the default branch. Put `Vizor issue: #<issue>` on its own line in the PR description. At the `supervised` level, open it as a **draft**.
4. If a check fails or the branch falls behind the default branch while you're still running, fix it and push to the same PR.
5. **Merging:**
   - `supervised` and `standard`: do not merge. The owner (or GitHub auto-merge) merges.
   - `brazy`: merge your own PR only when every check named in the issue's `vizor` block shows success on the PR's latest commit, the branch is up to date, and nothing is pending or failing. Use `gh pr merge <n> --squash`. If branch protection requires those checks, `gh pr merge <n> --auto --squash` is fine. Never use admin override, never merge with a failing or pending check, and never merge someone else's PR.
6. Post the result comment with `Vizor result: done (PR #<pr>)`. Vizor accepts the task only after the PR is merged and the named checks pass on the merge commit.

## Review gate (research, design, verification)

1. Commit the artifact to a task branch (for example `docs/<topic>.md`), or make the result comment itself the artifact if the assignment allows that.
2. Link the artifact with a link pinned to a commit: `https://github.com/<owner>/<repo>/blob/<sha>/<path>` or `/commit/<sha>`. Branch links don't count. Don't open a PR unless the assignment asks for one.
3. Post the result comment with `Vizor result: done`.

## Result comment format

Post **one** result comment per assignment, in this shape:

```
## <short title of what was delivered>

**Outcome:** one or two sentences.
**Evidence:** PR link or pinned artifact link; tests or checks run, with counts.
**Acceptance criteria:**
- <criterion>: where it is met
**Implemented / verified / unverified:** what was actually run and checked, and what was not.
**Limitations:** anything not done or still unknown, or "None".
**Assumptions:** in-scope assumptions you made instead of blocking, or "None".

Vizor return: <token>          (only if your assignment gave you a return token)
Vizor result: done (PR #<pr>)  (merge gate)
Vizor result: done             (review gate)
```

Rules:

- The marker goes on the last line. Never post `done` for unfinished work.
- Never claim that something was tested, verified or merged unless you saw it happen.
- If you can't finish, use `vizor-blocked` instead.
- After posting, end the run.
