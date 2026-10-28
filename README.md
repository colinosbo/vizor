# Vizor

A private workspace for running AI conversations side by side. **Stage two** adds Claude and OpenAI, concurrent streaming, live status and usage, draggable/resizable panels, saved layouts, templates, and agent archive/restore. Orchestration is a later stage.

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

### Upgrade from stage one

Stop the old app and back up the database and `.env`. Run `npm ci`, `npm run setup`, `npm run build`, then `npm start`. The additive migration preserves users, credentials and conversation history. This implementation saved a database backup at `data/backups/pre-stage-two.db`; retain the original `.env` with it to decrypt saved credentials.

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

## Privacy and storage

- SQLite lives at `data/vizor.db`. WAL/SHM sidecars can exist while running.
- Provider credentials use AES-256-GCM with fresh nonces and owner/provider identity as authenticated data. The required 32-byte base64 `MASTER_KEY` comes from `.env`; decryption occurs server-side for the chosen provider's calls only. Missing or changed master keys never trigger a silent reset.
- Messages, prompts and templates are ordinary local database text. Only the selected agent's history is sent to its chosen provider when you submit a message. Agents do not share histories.
- OpenAI uses the Responses API with `store: false`; no remote conversation resource is created. This does not override the provider's own service retention policies.
- Vizor does not execute model output, request provider tools, render raw HTML or automatically load remote Markdown images. Production CSP uses per-request nonces. Development additionally permits the style/evaluation operations required by Next's development server.
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

Execution and live-event coordination support **one Node process**. Startup marks abandoned runs interrupted and releases their locks. Text is checkpointed during streaming and finalized on normal cancellation; a hard crash can lose the latest uncheckpointed text (normally up to 250 ms). One active generation is allowed per conversation; different agents run independently. Idempotent submission IDs prevent duplicate paid generations.

**Hosted PostgreSQL remains outside this handoff.** The portable relational data model still needs a PostgreSQL driver, provider configuration and database-specific migrations. Changing `DATABASE_URL` alone is insufficient. Public signup controls, multi-process hosting and deployment hardening require separate work.

## Models, usage and extensions

Models are fetched live after connection and on Refresh. A discovery failure exposes a labelled fallback list and never silently changes an existing selection. OpenAI discovery excludes incompatible audio, image, embedding and realtime models. Temperature is sent only for known compatible model families.

Reported usage comes from provider events. Per-agent and workspace totals use dated standard-text prices for known models; unknown prices remain unavailable. Incomplete usage is marked partial, and totals show a known subtotal plus unknown usage where needed. Connection-test charges are outside chat totals. Estimates do not reconcile provider invoices, caching discounts, taxes or negotiated rates, and are **not spending caps**.

Providers implement `send`, `stream`, `listModels`, `validateKey`, metadata and model compatibility in one adapter file under `src/lib/providers`. Export a named `Provider` constant like the existing adapters. `scripts/providers.mjs` discovers it and regenerates the registry before development, build, tests and type checks. Onboarding/provider selection use adapter metadata. Unknown model prices stay unavailable; adding an adapter does not require changing the chat routes or database schema.

## Verification

```powershell
npm run format:check
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Tests use invented credentials and mocked provider HTTP transport; they make no billable calls. Browser servers use isolated databases on ports 3100, 3101, 3102 (restart check) and 3103. The test preload is never imported by the app, and production has no mock-provider switch. See [stage-two verification](verification/stage-two/REPORT.md) for actual results, screenshots and limitations.

Live inference, billing eligibility and model access require your own key entered through the app and remain untested unless explicitly recorded in that report.

## Later stages

3. Orchestrator summaries with compact context.
4. Structured, editable proposals, approval flow and audit history.
5. Provider budgets, bounded autopilot, hourly/loop limits and a global kill switch. User preference: bounded agent-triggered replies may be automatic; agent-management actions require approval. The provenance/permission design must be reviewed before implementation.

Stage two stops here for review.

References: [Anthropic models](https://platform.claude.com/docs/en/api/models/list), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI Responses](https://developers.openai.com/api/docs/guides/text?api-mode=responses), [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list), [OpenAI GPT-4.1 mini pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Prisma SQLite](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/sqlite).
