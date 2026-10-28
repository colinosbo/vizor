# Stage-two verification

Verified locally on Windows with Node 24.15.0. Date: October 27, 2026 (America/Chicago).

## Checks

- **46 automated tests:** both provider adapters with mocked HTTP, encryption/tampering, accounts/sessions, data isolation, duplicate sends, per-conversation locks, cancellation, partial output, templates/layouts, populated database migration and live-state reconciliation.
- **6 Chromium browser checks** against the production build. They cover the original onboarding/chat/account workflows, accessibility, a real server kill/restart, and the new multi-agent workflow.
- TypeScript, production build, formatting and dependency audit pass. The installed lockfile has no known vulnerabilities reported by npm audit.
- A populated stage-one fixture retains its password hash, encrypted key, role, conversation, messages and charged run usage after the migration. Foreign-key checks pass. The actual local database was backed up before applying the migration.

## Stage-two behaviour exercised

- OpenAI alone connects, creates an OpenAI agent and streams a response with no Anthropic key. Claude-only operation remains covered by the original workflow. Both providers can then be connected simultaneously.
- Separate Claude/OpenAI agents stream concurrently. A second browser tab observes their incoming tokens without reloading. Stopping one leaves the other running.
- Changing tabs and collapsing a panel retain the submitting tab's active requests. Each run has independent errors, stop controls and usage; workspace totals update from live provider usage events.
- Real pointer dragging, pointer resizing and keyboard resizing persist panel coordinates and dimensions. Pin/collapse preferences survive reload. A real process restart restores the layout mode and pin along with histories/credentials and frees the interrupted run lock.
- 1/2/4/6-up controls and tab mode work. Four agents render simultaneously. Mobile views keep page width within the viewport; grid panels stack and scroll independently.
- Current settings can be saved as a template, instantiated as a new agent, duplicated with empty history, renamed, switched to the other connected provider, archived/restored and paused/resumed.
- Cross-account attempts to access agents, layouts, credentials, templates, runs and event subscriptions remain scoped or denied. Expired/revoked subscriptions stop receiving user events. Removing one provider's key cancels only that provider's runs.
- Stale live events cannot resurrect a completed/stopped canonical run; replayed cumulative text does not duplicate messages.
- Axe A/AA rule checks pass for desktop/mobile onboarding, empty chat and the active two-panel workspace. Keyboard focus, Escape dismissal and responsive overflow are checked. This is not a comprehensive accessibility certification.
- No browser JavaScript exceptions occurred during the multi-agent workflow. Markdown HTML/images remain restricted.

## Screenshots

All screenshots contain invented fixture credentials and mocked output.

- [Concurrent providers at 1440 × 900](concurrent-desktop.png)
- [Four-agent grid at 1440 × 900](four-agent-desktop.png)
- [Tabs at 390 × 844](tabs-mobile.png)
- [Stacked grid at 390 × 844](grid-mobile.png)

## Limits

- **Real provider inference/billing has not been verified with a user's key.** Provider tests intercept HTTP in isolated test processes; production has no mock switch. Connect a key through the app for live verification. Testing a key can incur a small charge.
- Tokens/costs are provider-reported usage plus dated estimates. Unknown/partial costs are labelled. Connection tests, cached-token discounts, taxes and negotiated pricing are outside these totals; there is no spending guard yet.
- Execution and live events require one Node process. Eight live connections per user are supported; reconnect reloads the saved snapshot. The latest layout save wins across tabs.
- Closing/reloading the submitting tab cancels its requests. Hiding a panel or closing an observer tab does not. A hard crash may lose uncheckpointed text (normally up to 250 ms).
- Browser coverage is Chromium on this Windows machine. Hosted PostgreSQL, multi-process hosting, orchestrator summaries, proposals, audit history, budgets and autopilot are not delivered in stage two.

Stage three remains stopped for review.
