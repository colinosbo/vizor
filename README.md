# Vizor

Vizor is a background runner and a local web dashboard. It dispatches an approved GitHub plan to coding agents, verifies their results, and keeps going after you close the dashboard tab.

- **Runner:** the scheduler, relay and recovery paths in [`scripts/initiative-runtime/`](scripts/initiative-runtime/). On Windows it is supervised by per-user scheduled tasks.
- **Dashboard:** served on loopback. It reads the same durable project state as the runner, so you see the same queue, worker status, PR checks and blockers when you reopen it.
- **CLI:** `node scripts/initiative-runtime/scripts/vizor.mjs` for setup and troubleshooting (`init`, `doctor`, `status`, `schedule --preview`, `dashboard`).

Dispatch is local by default and needs no public endpoint. Webhook mode is optional and uses a public HTTPS URL you supply.

## Requirements

**Computer**

- Windows 10 or 11, left on with your user signed in. The runner works in the background while you're signed in. macOS and Linux can run the CLI, doctor and dashboard, but there the runner only runs in a terminal you keep open.

**Software** (the setup agent can install these)

- Node.js 24. Other major versions are refused.
- Git.
- GitHub CLI (`winget install --id GitHub.cli`), signed in with `gh auth login`.
- Optional: Claude Code CLI, signed in. It lets a blocked worker get the investigator's answer in the same chat.

**Accounts**

- A GitHub account and a repository for the project (the setup agent can create one), with admin rights for the signed-in account (Vizor creates labels and merge rules).
- Merge rails for Standard and braZy autonomy use GitHub rulesets. On GitHub Free those only apply to public repositories; private repositories need GitHub Pro, Team or Enterprise.
- A Claude account that can create Claude Code routines: one routine per worker, plus one for the blocker investigator. INSTALL.md step 6 shows how to create each one.

## Install

Download `vizor-<version>.zip` from [Releases](https://github.com/colinosbo/vizor/releases), extract it, and run `node setup.mjs`. Then, in your project folder:

```powershell
vizor init        # guided: repo, workers, autonomy, secrets, then everything else
```

[packaging/INSTALL.md](packaging/INSTALL.md) is the full guide: stop, restart, upgrade, roll back, diagnosing a failed start, and an [agent setup checklist](packaging/INSTALL.md#agent-setup) an AI agent can follow end to end. [packaging/FIRST-PLAN.md](packaging/FIRST-PLAN.md) takes a running project to its first dispatched task (plan format, approval, gates, merging, troubleshooting), with a tested example in [packaging/examples/](packaging/examples/vizor-plan.json). Agent skills ship with the runtime ([scripts/initiative-runtime/skills/](scripts/initiative-runtime/skills/)): `vizor-setup`, `vizor-plan` and `vizor-operate` for the operator, and `vizor-accept`, `vizor-deliver` and `vizor-blocked` for the workers. `vizor skills` installs them, and `vizor autonomy supervised | standard | brazy` sets how much the agents do on their own. Runtime details and limits are in the [runtime README](scripts/initiative-runtime/README.md). Decisions are in [AGENTS.md](AGENTS.md) and remaining release work in the [roadmap](docs/ROADMAP.md).

## Development

Requires Node.js 24. The runtime has no npm dependencies; `npm install` only adds Prettier.

```sh
npm test               # runtime, lease and install-lifecycle tests
npm run format:check
npm run package        # dist/vizor-<version>.zip with a hash manifest
```

Releases are published by pushing a `v<version>` tag that matches `package.json`.

Project configuration, queue state, logs and credentials live in each project's `.vizor/` folder and the OS credential helper. Never commit them here.
