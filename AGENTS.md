# Vizor decisions

- Keep Vizor a standalone development app. GitHub owns issues, code, PRs, and CI. Vizor owns assignments, runner activity, and the live activity log.
- The Orchestrator works from a user-approved plan. Break it into phases and issues with acceptance criteria, dependencies, and expected file scope.
- Sequence overlapping work before dispatch. Give each worker its own branch and worktree.
- Dispatch on the agreed GitHub event. Verify the webhook, match the saved assignment, and handle duplicate deliveries in code. The runner waits for work and invokes the model on demand.
- Keep the dashboard local. Use a Cloudflare Quick Tunnel for the first webhook test and expose only the webhook route. Keep secrets in private configuration.
- Verify one approved issue through a real worker, a PR, and dashboard updates before expanding automation.

See [the automation plan](docs/automation-plan.md) for the workflow and open decisions.
