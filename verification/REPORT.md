# Stage-one verification

Verified locally on Windows with Node 24.15.0. Report date: October 27, 2026 (America/Chicago).

## Passed

- TypeScript checking and optimized Next.js production build.
- **29 automated tests** across provider contracts, cryptography, and real SQLite integration.
- **5 Chromium browser tests**, running the production build with isolated local databases and mocked Anthropic HTTP transport.
- Encryption uses distinct nonces and rejects tampering, a different owner/provider, a missing master key, and an incorrect master key.
- Argon2id passwords, hashed session tokens, expiration and revocation; cross-origin mutation and unexpected-host rejection.
- Cross-account attempts to read or modify agents, send messages, discover models, remove credentials, or stop another account’s run are denied or limited to the caller’s own records.
- Incremental SSE, split CRLF and UTF-8 frames, normalized provider errors, actual usage events, unsupported temperature omission, and minimal connection validation.
- Duplicate submission protection, one active generation per conversation, destructive edit confirmation, regeneration, stopped responses, and durable partial output.
- Client disconnection and key removal abort active runs; stored credentials are actually deleted. No subsequent chat is allowed without a connection.
- Browser onboarding, failed/successful replacement, removal, settings, Markdown/code, Enter submission, Escape dismissal, and login/logout.
- A real server process is killed during a generation and restarted against the same SQLite file/master key: completed history and saved credentials survive; checkpointed partial text remains, interrupted status is set, and the conversation lock is released.
- Axe checks against WCAG A/AA rules on desktop/mobile onboarding and the empty chat workspace; visible keyboard focus and narrow-screen overflow checks. No automated violations in those checked states. This is not a comprehensive accessibility certification.
- Remote Markdown images and raw HTML cannot load tracking pixels; no browser JavaScript exceptions occurred during the main workflow.
- Fresh-database setup and repeatable seeding create exactly two demo agents, no messages, and no provider credentials.
- npm dependency audit reports no known vulnerabilities in the installed lockfile.

## Visual evidence

Screenshots use invented test credentials and mock responses, not live Claude output.

| Artifact                                         | What it demonstrates                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [Desktop onboarding](onboarding-desktop.png)     | Initial disconnected workspace at 1440 × 900                                                |
| [Empty desktop chat](workspace-desktop.png)      | Agent conversation and composer at 1440 × 900                                               |
| [Desktop conversation](conversation-desktop.png) | Markdown/code and a stopped partial response                                                |
| [Mobile conversation](conversation-mobile.png)   | 390 × 844 chat with navigation collapsed and no horizontal page overflow                    |
| [Mobile onboarding](onboarding-mobile.png)       | Provider reconnection form at 390 × 844; guide continues inside the scrollable content area |
| [Errors and fallback](error-and-partial.png)     | Provider failure, retained conversation and labelled model-discovery fallback               |
| [Account workspace](account-workspace.png)       | Separate authenticated account workspace                                                    |

## Not verified / boundaries

- **No live Anthropic key was supplied.** Real billing eligibility, model access and live inference remain untested. Connect your key through the app to perform that check; its test request may incur a small charge.
- Costs are dated estimates for the known models, not an invoice or a monthly spending cap. Unknown and partial usage is labelled. Connection tests are outside conversation totals.
- Hard crashes can lose the most recent uncheckpointed text (normally up to 250 ms); the restart test waits for a durable checkpoint before killing the process.
- Browser coverage is Chromium on this Windows machine, not Safari/Firefox, assistive-technology testing, or a full penetration test.
- Hosted PostgreSQL, multi-process execution, public deployment, OpenAI, orchestration, proposals, audit history, budgets, and autopilot are outside stage one.
- Production CSP uses per-request nonces. Development additionally permits the inline styles/evaluation required by the development server. Neither mode permits browser connections to external providers; those requests run on the server.

Stage two remains stopped for user review.
