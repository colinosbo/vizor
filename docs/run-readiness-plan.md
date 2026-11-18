# Vizor unattended run readiness

Colin approved fixing the supplied 25-item run-readiness list on November 17, 2026. This implements that existing request; routine fixes, bounded test assignments, checked merges and deployment do not need another approval.

## Outcome and constraints

Colin explicitly confirmed zero additional spending: existing subscriptions and their included allowances only. Do not add paid API keys, paid hosting, larger billed runners or a paid service. He will handle account-level billing/overage limits himself; those settings were not verified or changed here. Local validation is preferred, and existing included GitHub Actions remains the publication check.

An approved finite plan advances through its phases without a chat acting as a permanent manager. Workers receive one task/chat, capacity pauses retain that chat, and ordinary software blockers are investigated through the existing Claude subscription and returned through the supported same-chat interface. GitHub checks remain deterministic. No new paid service, API key, live customer integration or pilot is authorized. Vision stays synthetic with a $0 spending limit. Completing an approved plan ends the run; an empty queue does not authorize invented work.

## Deliverables

| ID | Scope | Readiness items | Acceptance |
|---|---|---|---|
| R1 | API cache, completion cache, shared snapshot/heartbeat and diagnostics | 1, 2, 10, 11, 12, 17, 18, 19, 24, 25 | Authenticated conditional requests, bounded rate/backoff, no dashboard GitHub calls, dependencies survive queue pruning, explicit stale/closed/unconfirmed/capacity states; 25-issue budget verification |
| R2 | Versioned signed plan/task/merge policy and manager assignment authority | 3, 6, 15, 16 | A new approved task number needs no merge-script edit; copied/forged worker headings cannot assign work; approvals and skills are on main before dispatch |
| R3 | Finite phase publisher and Claude blocker investigator | 4, 5, 14 | Phase completion publishes only the next approved tasks; no idle model polling; routine blocker round trip works without Codex; model pauses are durable |
| R4 | Clean pinned runtime and operational commands | 7, 8, 9, 13 | Runtime is clean/tracked and matches main, Vision uses a compatibility entry point, local dispatch needs no tunnel, health and safe restart report one scheduler |
| R5 | Live repair/recheck and rollback evidence | 20 | A labelled isolated synthetic defect goes through worker report, Claude investigation, checked repair and the original verifier chat; no duplicate starts |
| R6 | Preserve and reconcile local work | 21, 22, 23 | Inventory unpushed changes; commit/archive preservation copies before removing clean redundant worktrees/branches; retain referenced research artifacts |

## Already verified before this change

Local dispatch, disabled Cloudflare/webhook startup, Windows sign-in startup, hidden parent child-process recovery, accepted issue closure and worker skills are installed. Vision PRs 58 and 59 are merged; issue 57 and controlled local-dispatch issue 60 closed automatically. These fixes must be retained. The live scheduler is in the original dirty Vizor checkout until a clean pinned replacement is verified. Do not pull, switch branches or discard changes in that original checkout.

## Authority and identity

Workers currently share the owner's GitHub connector identity. A name or `### Task for` heading alone cannot be manager authority. A private local signing key and versioned public verification policy will bind approved plans, issue scopes and exact assignment records. Workers never receive the manager private key. This enforces the manager/worker boundary without requiring another paid account; it does not falsely claim the GitHub connector identity itself has changed. Separate bot/App credentials remain an optional credential migration and must not be fabricated.

## Verification and rollout

Implement in clean engineering checkouts, run meaningful unit/process tests and GitHub CI, then deploy from a clean checkout pinned to a merged revision. Preserve private state and receipts. Measure real API consumption separately from simulated budgets; record start/end/reset and concurrent account usage. Test a controlled finite phase transition and full synthetic repair/recheck. Stop the controlled verification plan after success. Log unresolved external prerequisites or retained dirty work explicitly instead of claiming they were cleaned up.
