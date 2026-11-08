# Vizor development automation plan

**Status:** The one-issue webhook pilot is implemented. Issue #3 reached the worker through Cloudflare Quick Tunnel and produced PR #4 after a retry. The full workflow below describes the intended project automation.

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

## Run the first webhook pilot

1. In Vizor, approve the project and create a queued task with the exact GitHub issue URL in its references. Choose the named worker and start its runner with a dedicated checkout.
2. Start the local relay with `VIZOR_GITHUB_WEBHOOK_PORT`, `VIZOR_GITHUB_PROJECT_ID`, `VIZOR_GITHUB_TASK_ID`, and `VIZOR_GITHUB_AGENT_ID` set for the pilot. Set a private `VIZOR_GITHUB_WEBHOOK_SECRET` of at least 32 characters. The webhook listener has its own loopback port and serves only `POST /webhooks/github`.
3. Run `cloudflared tunnel --url http://127.0.0.1:<webhook-port>`. Create a GitHub repository webhook for **Issues**, with JSON content type and the same signing secret. Append `/webhooks/github` to the Quick Tunnel URL.
4. Apply `vizor:dispatch` to the bound issue. Set `VIZOR_GITHUB_DISPATCH_LABEL` if using a different label. Watch the named assignment and activity in Vizor. The task can only be dispatched once through this pilot binding.
5. Review the worker's checks and approve publication of its exact candidate commit in Vizor. Verify the PR link in the task, then remove the temporary repository webhook and stop the tunnel.
