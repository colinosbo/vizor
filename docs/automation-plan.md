# Vizor development automation plan

**Status:** Proposed workflow. GitHub webhook dispatch through Cloudflare still needs implementation and a live test.

Vizor is the standalone app for planning and coordinating development work. GitHub is the source of truth for issues, code, pull requests, and checks. Vizor records assignments, runner activity, blockers, and handoffs.

| Phase                        | Workflow                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Plan                      | The user brings a project goal to the Orchestrator. Together they fill gaps and break the plan into phases. Each task has acceptance criteria, dependencies, and an expected file scope.                                                                                        |
| 2. Approve and publish tasks | The user approves the plan and scope. Vizor creates GitHub issues and links them to their phases and dependencies.                                                                                                                                                              |
| 3. Release ready work        | The Orchestrator sequences dependent tasks and tasks with overlapping file scopes. It saves the assignment and applies the agreed GitHub dispatch label when the task is ready.                                                                                                 |
| 4. Dispatch on the event     | GitHub sends a signed event through Cloudflare Tunnel to Vizor's local webhook endpoint. Vizor verifies the signature, matches the issue to the saved assignment, and records the delivery once before dispatching it. The listener waits for work. The model runs when called. |
| 5. Build and review          | The worker reads the issue and relevant code, works in an isolated branch and worktree, and reports questions, blockers, and check results. It hands off a PR. Review and CI determine readiness under the project's merge rules.                                               |
| 6. Show progress             | The local dashboard shows phases, open issues and PRs, who is working, blockers, completed work, and a chronological log. GitHub supplies issue, PR, and check status. Vizor supplies queued work and runner-confirmed activity.                                                |

Planning skills guide decomposition and conflict checks before dispatch. Worker and reviewer skills guide what to inspect, test, and report. Vizor handles assignment rules and webhook verification in code.

For the first test, run `cloudflared` on the Vizor PC and expose only the GitHub webhook endpoint. Use the GitHub signing secret to verify deliveries and keep runner credentials separate. Store secrets in private configuration. The PC, listener, and tunnel need to be running for GitHub to deliver the event.

**First milestone:** One approved GitHub issue dispatches one real agent. The dashboard shows queued, working, and PR ready, with a link to the resulting PR. Resending the same delivery starts no additional run.

**Pilot evidence checklist:** Record these before marking the first milestone done.

- [ ] Delivery ID: the GitHub `X-GitHub-Delivery` value of the accepted webhook delivery.
- [ ] Observed dashboard states: queued, working, and PR ready, as shown for that run.
- [ ] PR link: the URL of the resulting pull request.
- [ ] Duplicate check: resending the same delivery ID started no additional run.

**Open decisions:** Finalize the dispatch label and how Vizor handles missed deliveries after downtime. Choose a stable tunnel hostname if the temporary Quick Tunnel URL becomes a daily setup burden.

Vizor can use a Codex worker with ChatGPT sign-in.
