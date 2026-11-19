# Vizor decisions

- Vizor is a background runner, a CLI and a local web dashboard. There is no desktop app. The runtime lives in `scripts/initiative-runtime/` and uses only Node.js 24 built-ins.
- GitHub owns issues, code, PRs and CI. Vizor owns assignments, dispatch receipts, runner activity and the activity log.
- One durable project state (`.vizor/` in the project folder) is shared by the runner, CLI and dashboard. Only the scheduler dispatches; the dashboard and CLI never start a second scheduler.
- The Orchestrator works from a user-approved, versioned plan: phases and issues with acceptance criteria, dependencies and expected file scope. Overlapping work is sequenced before dispatch; each worker gets its own branch.
- Dispatch is local by default: the scheduler polls GitHub and calls the saved worker directly, with no public listener. Webhook mode is optional and uses an operator-supplied public HTTPS URL that exposes only the webhook route. Vizor does not start tunnels.
- Code is accepted only when the configured checks pass on the exact merged commit. Successors are released only after acceptance.
- Ambiguous provider starts are reconciled, never blindly retried. Receipts survive restarts.
- Blocker investigation is core. When a worker reports `blocked`, one read-only Claude investigation decides: route a repair, return the worker to its same chat, or hold the task for the owner with a report. `vizor investigator` sets it up, and `doctor` fails without it.
- Autonomy is the owner's choice: Supervised, Standard or braZy (`vizor autonomy`). Every level keeps the same rails, and braZy only removes human approval steps, never safety checks.
- Project configuration, queue state, logs and credentials stay outside Git. Pilot-specific data belongs in synthetic examples.

See [how Vizor works](docs/automation-plan.md) and the [roadmap](docs/ROADMAP.md).
