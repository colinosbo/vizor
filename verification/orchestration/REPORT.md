# Stages three and four, plus spending limits

Verified on Windows, Node 24.15.0, October 27, 2026 (America/Chicago). Version 0.4.0. Autopilot is disabled.

## Passed

- **74 automated tests** across 10 files. The original 46 checks remain, plus 28 covering native tool transport, bounded context, approval isolation/versioning/idempotency, conservative budget reservations and settlement, concurrent requests, reconciliation and UTC monthly balances.
- **7 Chromium browser checks** against a production build. The new full workflow exercises Claude and OpenAI orchestration, read-only summaries, message drafts, editing before approval, duplicate approval, creating an agent, bulk rename/pause approval, rejection of archiving, audit history, budget controls and $0 generation blocks.
- The existing restart check now kills and restarts a real Node server and verifies that the orchestrator configuration, pending proposal, audit entries, provider limit, preserved histories and encrypted credential survive. The abandoned run is interrupted, its lock clears and its reserved maximum cost is retained conservatively. No pending proposal is approved automatically.
- Type checking, production build and formatting pass. `npm audit --omit=dev` reports zero known production dependency vulnerabilities.
- Populated migration fixture preserves account/password hash, encrypted provider credential, agent role, messages and existing run cost, and backfills the spending ledger and monthly balance. SQLite foreign-key checks pass.
- The actual local database was backed up before migration at `data/backups/pre-orchestrator.db`. Comparison of all original columns in users, credentials, agents, conversations, messages, runs and templates confirms unchanged data. This particular local database had one owner and no connected credentials or conversations; the populated fixture supplies the upgrade-data coverage.
- Axe A/AA checks pass on desktop/mobile orchestrator, mobile audit history and spending controls, alongside original onboarding and workspace accessibility checks. Navigation, labelled forms, Escape dismissal and the composer are keyboard accessible. This is not a complete assistive-technology certification.
- Visual inspection at 1440 × 900 and 390 × 844. Fixed a mobile long-history sizing issue; the composer remains reachable, context and proposals scroll below the chat, and document width/height stay within the narrow viewport. Budget cards stack; request tables scroll within their section. No browser JavaScript exceptions occurred in the new workflow.

## Safety and accounting exercised

- Native `send_message` and management calls create pending drafts only. Tool-shaped prose and malicious instructions inside agent output cannot execute actions. Tool calls require an owned orchestrator run; summaries and targets are owner scoped. The turn loop is bounded to three model calls, eight calls per response and 20 proposals per turn.
- Editing uses version checks. Stale approval/edit attempts fail. Concurrent/repeated approval produces one delivery/run, and repeated create approval creates one agent. The exact edited/approved payload is retained in audit snapshots; approved target messages have server-assigned origin and approval labels.
- Another owner cannot read compact context, approve/edit proposals, target foreign agents or use a foreign audit cursor. Client fields cannot forge message provenance or enable autopilot. Audit history has no mutation endpoint.
- Concurrent budget reservations compete for one transactional balance. Final complete provider usage settles the hold exactly at the listed rate; cancellation and restart retain a conservative estimate. Repeated settlement cannot double charge.
- $0 limits block before token counting or generation; UI and route checks cover direct chat, orchestrator and key testing. Failed replacement preserves the existing connection. Unpriced models and failed/invalid token counting block protected calls. The current policy is rechecked after preflight.
- Connection tests, orchestrator continuation and agent chat share the provider balance. Owners/providers remain separate. Opening balances cannot reduce recorded spending; reconciliation clears explicitly unknown earlier usage and records an adjustment/audit event. Earlier months remain stored.

## Screenshots

All credentials and conversation content in these images are invented fixtures.

- [Orchestrator and approval queue, desktop](orchestrator-desktop.png)
- [Long conversation and reachable composer, mobile](orchestrator-mobile.png)
- [Proposal review, mobile](proposals-mobile.png)
- [Budget warning and provider controls, desktop](budget-desktop.png)
- [Budget controls, mobile](budget-mobile.png)
- [Audit history, desktop](audit-desktop.png)
- [Audit history, mobile](audit-mobile.png)

## Untested and remaining boundaries

- **No live inference or billing check with a real provider key.** Provider HTTP is intercepted only in isolated test processes; production contains no mock switch. Real model eligibility, token-counter availability and native tool behavior with your account remain unverified. A key entered through the app is required; connection tests may incur a small charge.
- Spending protection uses dated prices and provider token counts plus a safety buffer, rather than enforcing an exact provider invoice. Other apps, taxes, price changes and account-specific billing terms are outside its scope. Optional caps start disabled until you choose dollar amounts. Unknown costs remain unavailable, and incomplete costs are explicitly conservative estimates.
- Local excerpts omit some older details and are not a complete semantic memory. Context selections are held for the current browser session; agent/configuration, summaries, proposals and ledger records persist in SQLite.
- The audit history is append-only through the app, not cryptographically tamper-proof against someone who can alter the local database. Back up the database and `.env` together.
- One Node process is supported. Explicitly approved message responses continue locally if the approval page closes; direct chat/orchestrator streams stop when their submitting connection closes. A hard crash can lose the latest uncheckpointed text. Uncertain approval delivery is never automatically retried.
- Chromium coverage on this Windows machine; no physical-phone, Safari, Firefox or hosted PostgreSQL verification. Public hosting, multi-process execution and autopilot are outside this handoff.

Autopilot remains off. Its later permission/provenance design and autonomous-loop controls have not been implemented.
