---
name: vizor-setup
description: Use when asked to install, set up or connect Vizor on a Windows PC for a GitHub repository. Asks how much autonomy the agents get, sends the human one message of what they must do, then installs, connects, checks and starts the runner and installs the worker skills.
---

# Set up Vizor

Vizor is a background runner, a CLI and a local dashboard. It dispatches an approved GitHub plan to Claude Code worker routines. You do the setup; the human only signs in, supplies the worker secrets and approves. The authoritative step list is **Agent setup** in `INSTALL.md` (package root). This skill adds the questions to ask and the order to work in.

## 1. Ask two things before anything else

Ask in one message, as a multiple-choice question if you can.

**a) How much should the agents do on their own?**

| Option                              | What it means                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supervised**                      | You see and approve everything. Workers open draft PRs; you review, mark them ready and merge each one; you accept every research/review result; blockers wait for you.                                                                                                     |
| **Standard** (recommended to start) | Results with pinned evidence are accepted automatically; you merge PRs, or GitHub auto-merges once the required checks pass; blockers wait for you.                                                                                                                         |
| **Go braZy**                        | Full release inside the rails: workers do whatever their approved task says without asking, merge their own PR once every required check passes, and failed verifications get automatic repair. They stop only for credentials, spending, real data or outside commitments. |

The rails at every level, including braZy: work stays inside the approved plan and each task's allowed files; secrets never leave `.vizor\secrets.json`; nothing force-pushes or bypasses checks; and code counts as done only when the plan's checks pass on the merged commit. braZy means more automation, not fewer safety checks.

**b) How much should _you_ (this setup agent) check in?**

- **Supervised:** confirm each step before running it.
- **Standard / braZy:** run the steps straight through and stop only for the human-only items in step 2.

## 2. Send the human the "what I need from you" message

Use Step 0 of **Agent setup** in `INSTALL.md`, filled in, and add the autonomy level they picked. Don't start installing until they've answered.

## 3. Do the setup

The fastest path is `vizor init` in the project folder. Pass answers as flags (`--repo`, `--manager`, `--worker id=Name`, `--autonomy`) so it doesn't stop to ask, and have the human paste the secrets when it pauses. Otherwise, follow **Agent setup** steps 1–8 in `INSTALL.md` exactly: prerequisites, GitHub sign-in, `node setup.mjs`, project folder, `vizor connect`, worker credentials (the human pastes them), `vizor labels`, `vizor investigator`, `vizor doctor --json` until `"healthy": true`, then `vizor start` and `vizor health`.

Blocker investigation is a core part of Vizor; don't skip `vizor investigator`. Without it, a task that reports `blocked` stays held until someone steps in. Prefer an **investigator routine**: have the human create a Claude Code routine with the prompt "You are the Vizor blocker investigator. Follow the vizor-investigate skill in this repository." and paste its Fire URL and token under `"orchestrator"` in `secrets.json`. Then nothing extra has to be installed on the PC.

## 4. Apply the autonomy level and install the worker skills

In the project folder:

```powershell
vizor autonomy supervised            # or: standard
vizor autonomy brazy --repair-agent <builder id> --repair-check <check name>   # braZy with automatic repair
vizor skills
```

- `vizor autonomy` sets the queue's acceptance and repair settings and records the level in `vizor.config.json`. Workers read it from there. For Standard and braZy it also applies the GitHub merge rails (Allow auto-merge plus a ruleset requiring the plan's checks). If GitHub refuses, tell the human what it said. After the plan PR merges, run `vizor rails` so its checks are required.
- `vizor skills` puts the worker skills (`vizor-accept`, `vizor-deliver`, `vizor-blocked`) in `.claude\skills` and the operator skills in the user's Claude Code skills folder.
- Then open a PR that adds `.claude/skills/` and `vizor.config.json` (it holds no secrets), and have the human merge it. Worker routines load the skills from the repository.

Each worker routine's own prompt should be the one in `INSTALL.md` step 6. If the human has no worker routines yet, send them that step's instructions to create one per worker.

## 5. First plan

Use the `vizor-plan` skill. It ends with the first phase published.

## 6. Report

Send **Step 10** of **Agent setup** in `INSTALL.md`, including the autonomy level. Keep it short. Lead with anything the human still has to do.

## Never

- Ask for, print or move worker tokens. The human pastes them into `.vizor\secrets.json` themselves.
- Touch another Vizor project's folder, tasks or queue.
- Claim a step passed without seeing its expected output.
