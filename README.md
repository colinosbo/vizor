# Vizor

A private workspace for running AI conversations side by side. **Stages three and four, plus spending limits**, add a main orchestrator conversation, compact agent context, editable proposals, human approval and audit history. Claude/OpenAI chats, saved panel layouts, templates and archive/restore remain available. **Autopilot is off.**

## Windows quick start

Use Node.js **24.11 or later in the Node 24 line** and npm 11+.

```powershell
npm ci
npm run setup
npm run dev
```

Open **http://127.0.0.1:3000**. Use this exact address rather than `localhost`: API requests check the configured host. Start commands bind only to this computer.

Setup creates `.env` only if it does not exist, generates a permanent encryption key, creates SQLite storage, generates the Prisma client, and applies checked-in migrations. It never overwrites an existing master key. No provider key is required to start Vizor.

For a production build:

```powershell
npm run build
npm start
```

For optional **Writing partner** and **Code reviewer** demo configurations, run `npm run db:seed`. This repeatable seed does not overwrite existing agents or create messages or provider keys. Demo configurations make normal provider calls after you connect a key.

### Upgrade from an earlier stage

Stop the old app and back up the database and `.env`. Run `npm ci`, `npm run setup`, `npm run build`, then `npm start`. Migrations preserve users, credentials and conversation history and import existing run costs into the new ledger. This implementation saved a database backup at `data/backups/pre-orchestrator.db`; retain the original `.env` with it to decrypt saved credentials. Previous connection-test charges were not recorded and cannot be recovered automatically.

## Connect a provider

Connect either provider alone or both. Each card supports testing, replacement and deletion; existing agents retain their provider/model until you explicitly edit them. These are **API keys**, billed per use, separately from ChatGPT Plus / Claude Pro subscriptions.

### Claude / Anthropic

1. Sign in at [console.anthropic.com](https://console.anthropic.com/).
2. Open **API Keys → Create Key** and copy the key starting with `sk-ant-`.
3. Set up API billing/credits under **Plans & Billing**.
4. Paste it into the masked **Claude** card and choose **Test connection**.

### ChatGPT / OpenAI

1. Sign in at [platform.openai.com](https://platform.openai.com/).
2. Open **API keys → Create new secret key** and copy the key starting with `sk-`.
3. Add a payment method or credits under **Billing**.
4. Paste it into the masked **ChatGPT** card and choose **Test connection**.

Testing fetches available models and makes one capped inference request: at most eight output tokens for Claude or sixteen for OpenAI. **The provider can charge for this test.** Authentication, billing, rate-limit and temporary provider failures are distinguished. Save occurs only after success; a failed replacement preserves the working key. The same instructions are available under **API keys**.

Only the key's last four characters are returned to the browser. Entered keys remain in component memory while being submitted and are cleared after the attempt; they are never put in browser storage. **Remove key** deletes stored ciphertext and stops only that provider's runs. It does not revoke the key at the provider or delete conversations.

## Your workspace

- Choose **1**, **2**, **4** or **6** panels, or **Tabs**. Larger workspaces have previous/next controls; the sidebar can select any agent. Narrow screens stack panels and preserve touch scrolling.
- Drag using a panel's grip; resize from its lower-right corner. Keyboard alternatives: focus the grip and press Left/Right to reorder, or focus the resize handle and use arrow keys to resize. Pointer drag/resize is disabled on narrow screens.
- Pin agents to prioritize them in the sidebar, tabs and visible groups. Collapse a panel to its header or use Focus to open it alone. Hiding/collapsing a panel, switching tabs or opening settings does not cancel its generation.
- Positions, sizes, mode, order, pins, collapse state and selected agent are saved per user in SQLite and survive restarts. Positions are separate for each mode. Reset panel positions returns the current mode to a fitted grid. The latest save wins if two tabs edit a layout simultaneously.
- Each agent has its own history, provider, model, system prompt, temperature where supported, output cap, colour/icon, composer, stop control and usage. Status distinguishes Ready, Thinking, Waiting for you, Paused, Stopped and Error.
- Agent settings support rename/edit, duplicate, pause/resume, archive and **Save as template**. Duplicate copies setup into an empty conversation. Pause/archive cancels that agent's current run. Archive retains history; restore from **Archive**.
- Templates capture the setup currently shown in the settings form. Use one to create a fresh agent. Deleting a template leaves existing agents/conversations intact.
- Enter sends; Shift+Enter adds a newline. Stop keeps partial output, regenerate replaces the latest assistant response, and edit-and-resend confirms removing the edited message and subsequent active branch. Prior run usage remains accounted for.
- Tokens, status and estimated usage push over one authenticated SSE feed per browser tab. Another tab for the same account sees the updates too. Reconnection reloads the saved snapshot; while disconnected, Vizor shows Reconnecting and checks saved state every three seconds. Up to eight live browser connections per account are supported.
- Closing or reloading the tab that submitted a message still cancels that tab's generation. Closing a tab that is only observing does not cancel another tab's work. Cancellation cannot undo tokens already billed.

## Orchestrator and approvals

1. Connect a provider, create your agents, then open **Orchestrator → Set up orchestrator**. Choose its provider, model and output cap. Configuring it makes no inference request.
2. Select the agents to include in context (up to 20). Ask a question, choose **Summarize progress**, or choose **Draft next steps**. Each explicit turn uses at most three model calls. Every call is metered; continuation stops when a spending limit blocks it.
3. Review drafts beside the conversation or under **Proposals**. Edit a draft's text, target or proposed agent configuration; then approve or reject it. Bulk approval reviews up to 20 pending items at a time and reports individual failures. Older pending drafts remain available as the oldest 100 are reviewed; the recent-decisions view shows the latest 50.
4. **Audit history** records who proposed an action, who approved it, changes to drafts, sends, agent changes, provider connections, spending settings and failures. Load older events with the page control. History is read-only through the app, owner-scoped, and local database text; it is not a tamper-proof external audit service.

The orchestrator receives each selected agent's name, model, role (up to 2,000 characters), local rolling excerpts (up to 4,000 characters), and four recent message excerpts (up to 1,800 characters each). It also sees a bounded recent orchestrator conversation and proposal metadata. Rolling excerpts are an extractive cache, **not a complete semantic memory**. They can omit older details. Editing an earlier branch resets its cache. Agent output is explicitly marked untrusted reference data.

Only native, structured provider tool calls can create proposals. Available tools read summaries or propose messages, creating/renaming/pausing/archiving agents. Prose, Markdown and action-looking JSON cannot execute anything. Even a native `send_message` call only creates a draft. The server requires your approval before any send or management change, checks ownership, validates the stored payload, and rejects stale edit versions. Approval is recorded transactionally; repeated approvals do not repeat the action.

Approved messages are labelled **Orchestrator · Approved by you** in the target conversation. After approval, that message's response continues in the local Node process even if you leave the approval page; use the target agent's **Stop** control to cancel. Provider removal and pause/archive also cancel it. Restart recovery never automatically re-delivers an uncertain approved message: review its target history before proposing another one.

**Autopilot remains disabled in the UI and server.** No scheduled replies, message-triggered loops, agent-triggered actions or background model summaries run. The bounded native-tool continuation within a turn happens only after an explicit user submission.

## Spending limits

Open **Spending limits**, enable a monthly limit for either provider, enter a USD amount and save. Limits are optional and start disabled; no dollar amount has been chosen for you. **$0 blocks new generations** for that provider. The same balance covers all your agent chats, orchestrator calls and new connection tests. Key replacement/removal does not reset the ledger. Each account and provider has a separate balance.

Before a protected generation, Vizor calls the provider's input-token counter and reserves the cost of those tokens plus a 10%/256-token safety buffer and the full output-token cap. The reservation and balance check are one database transaction, so concurrent requests cannot spend the same remaining balance. Final complete usage replaces the reservation with the reported token cost. At 80% used or reserved, a warning appears. Requests whose maximum estimate will not fit are blocked before inference. Unknown model prices, unavailable token counting or unresolved unpriced usage also block protected requests.

Budgets use **UTC calendar months**, integer microdollars and a dated standard-text price table. They protect this account's Vizor usage at those listed rates; they are not an exact provider invoice or an organization-wide billing cap. They do not discover spending in other apps. Price changes, taxes, negotiated pricing and provider accounting differences are outside the guard. Unknown costs stay unavailable. The recent request ledger shows the latest 50 calls/adjustments, including connection tests that are outside chat totals.

Interrupted requests without complete usage retain a conservative maximum estimate rather than freeing possibly spent money. Crash recovery does the same for abandoned reservations. Known authentication/billing/rate-limit rejections release their hold. You must stop or finish current provider requests before changing its limit.

If earlier usage has no reliable price/complete usage, **Reconcile earlier usage** accepts a conservative month-to-date total from your provider account. This is an explicit manual reconciliation recorded in the audit log, cannot lower Vizor's already recorded spend, and clears the unresolved-usage block. An opening-balance adjustment is added to the ledger. It can also include spending outside Vizor. A new UTC month starts with a new balance while retaining prior records.

## Privacy and storage

- SQLite lives at `data/vizor.db`. WAL/SHM sidecars can exist while running.
- Provider credentials use AES-256-GCM with fresh nonces and owner/provider identity as authenticated data. The required 32-byte base64 `MASTER_KEY` comes from `.env`; decryption occurs server-side for the chosen provider's calls only. Missing or changed master keys never trigger a silent reset.
- Messages, prompts, summaries, proposals, audit events and templates are ordinary local database text. Direct agent chats send that agent's history to its provider. Orchestrator submissions also send the selected agents' compact context to the orchestrator's chosen provider; the context selector explains this sharing.
- OpenAI uses the Responses API with `store: false`; no remote conversation resource is created. This does not override the provider's own service retention policies.
- Vizor cannot execute code, browse websites or contact external tools on a model's behalf. Native tools are limited to read-only summaries and reviewable proposals; mutations require approval. Raw HTML and automatically loaded remote Markdown images remain disabled. Production CSP uses per-request nonces. Development additionally permits the style/evaluation operations required by Next's development server.
- Runtime connections are limited to the local app and selected Anthropic/OpenAI APIs. Console links open when clicked. No analytics, paid infrastructure, cloud database, remote fonts or background AI calls are installed. Next.js telemetry is disabled in the generated environment.
- npm installation downloads dependencies; browser-test setup downloads Chromium. These development operations do not upload conversations or API keys.

Stop the app before backing up **both `.env` and the database**, including any remaining WAL/SHM sidecars. Restore them together. Losing `MASTER_KEY` makes saved provider keys unreadable; restore it or reconnect providers. Protect `.env` and backups with Windows account/file permissions: someone who can read both the database and master key can decrypt the credentials.

## Accounts and deployment boundaries

Default configuration:

```dotenv
DATABASE_URL="file:./data/vizor.db"
SELF_HOST="true"
APP_ORIGIN="http://127.0.0.1:3000"
MASTER_KEY="<32 random bytes encoded as base64>"
NEXT_TELEMETRY_DISABLED="1"
CHECKPOINT_DISABLE="1"
```

`SELF_HOST=true` skips signup and uses one local owner. It requires a loopback origin. Keep the local-only start commands; do not expose this mode through a proxy or tunnel.

`SELF_HOST=false` enables local email/password registration, login and logout. Passwords require 12–128 characters and use Argon2id. Sessions use hashed random tokens and expiring HttpOnly, SameSite=Strict cookies (Secure on HTTPS). Every query and live event feed is scoped to its owner. Cross-origin API requests are rejected. There is no email delivery, password recovery, OAuth or verification service. Switching modes retains separate local-owner and email-account workspaces. Restart after configuration changes.

Execution and live-event coordination support **one Node process**. Startup marks abandoned runs interrupted, clears their locks, conservatively settles abandoned spending reservations and fails uncertain in-progress approvals without retrying them. Text is checkpointed during streaming and finalized on normal cancellation; a hard crash can lose the latest uncheckpointed text (normally up to 250 ms). One active generation is allowed per conversation; different agents run independently. Idempotent submission IDs and unique approval-to-run links prevent duplicate paid generations.

**Hosted PostgreSQL remains outside this handoff.** The portable relational data model still needs a PostgreSQL driver, provider configuration and database-specific migrations. Changing `DATABASE_URL` alone is insufficient. Public signup controls, multi-process hosting and deployment hardening require separate work.

## Models, usage and extensions

Models are fetched live after connection and on Refresh. A discovery failure exposes a labelled fallback list and never silently changes an existing selection. OpenAI discovery excludes incompatible audio, image, embedding and realtime models. Temperature is sent only for known compatible model families.

Reported usage comes from provider events. Per-agent and workspace totals use dated standard-text prices for known models; unknown prices remain unavailable. Incomplete usage is marked partial, and totals show a known subtotal plus unknown usage where needed. Chat totals and the spending ledger have different scopes: connection tests, opening balances and conservative interrupted-call reservations are in the ledger. Chat estimates alone are not spending caps; enable the separate provider limit to protect new requests.

Providers implement `send`, `stream`, `listModels`, `validateKey`, optional `countTokens`, metadata and model compatibility in one adapter file under `src/lib/providers`. Native tool calls/results use normalized types across providers. Export a named `Provider` constant like the existing adapters. `scripts/providers.mjs` discovers it and regenerates the registry before development, build, tests and type checks. Onboarding/provider selection use adapter metadata. New providers/models need an explicit price and token counter to support protected generations; unknown prices stay unavailable.

## Verification

```powershell
npm run format:check
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Tests use invented credentials and mocked provider HTTP transport; they make no billable calls. Browser servers use isolated databases on ports 3100, 3101, 3102 (restart check), 3103 and 3104. The test preload is never imported by the app, and production has no mock-provider switch. See [current verification](verification/orchestration/REPORT.md) for actual results, screenshots and limitations. Earlier stage reports are historical snapshots.

Live inference, billing eligibility and model access require your own key entered through the app and remain untested unless explicitly recorded in that report.

## Later stages

Stages three/four and provider spending limits are delivered here. Bounded autopilot, hourly/loop limits and a global kill switch for autonomous activity remain future work. User preference for that stage: bounded agent-triggered replies may be automatic; agent-management actions require approval. Its provenance/permission design still needs review before implementation. Hosted PostgreSQL and public deployment also remain separate work.

References: [Anthropic models](https://platform.claude.com/docs/en/api/models/list), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI Responses](https://developers.openai.com/api/docs/guides/text?api-mode=responses), [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list), [OpenAI GPT-4.1 mini pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Prisma SQLite](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/sqlite).
