# Vizor

A private workspace for focused AI conversations. **Stage one:** one visible Claude conversation at a time, local persistence, encrypted provider credentials, streaming, configurable agents, and optional local account authentication.

## Windows quick start

Use Node.js **24.11 or later in the Node 24 line** and npm. In PowerShell, from this folder:

```powershell
npm ci
npm run setup
npm run dev
```

Open **http://127.0.0.1:3000**. The server binds only to the local computer. Use this exact address rather than `localhost`; the configured host is checked on every API request.

`setup` creates a local `.env` only if it does not exist, generates a permanent encryption key, creates SQLite storage, generates the Prisma client, and applies checked-in migrations. It never overwrites an existing master key. Keep `.env` out of source control. No provider key is required to start the app.

For a production build on this computer:

```powershell
npm run build
npm start
```

For optional demo agent configurations:

```powershell
npm run db:seed
```

The seed adds **Writing partner** and **Code reviewer**, with no messages or provider keys. It is repeatable and does not overwrite an existing configuration. Only one conversation is displayed at once. These agents call Claude normally after you connect a key; they are not simulated conversations.

## Connect Claude

1. Open [console.anthropic.com](https://console.anthropic.com/) and sign in.
2. Open **API Keys → Create Key** and copy the key starting with `sk-ant-`.
3. Set up billing or credits under **Plans & Billing**.
4. Paste the key into Vizor’s masked field and select **Test connection**.

Testing fetches the available models and makes one capped inference request (maximum eight output tokens). **The provider can charge for this test.** API billing is separate from Claude Pro. Vizor distinguishes authentication, billing, rate-limit, and temporary provider failures. It saves the key only after a successful test; a failed replacement retains the working key.

Select **Open workspace** to create the first assistant. Configure its model and prompt under **Agent settings**. Use the sidebar plus button for another configuration. Only the selected conversation is displayed; simultaneous dashboards and orchestration are later stages.

The same key instructions are available under **API keys**. **Remove key** deletes the encrypted credential and cancels affected running generations. It does not revoke the key at Anthropic or delete conversations. Keys are held only in component memory while being entered and are cleared after submission; only their last four characters are returned from the server. No key is stored in browser storage.

### OpenAI — later stage

OpenAI is not connected in this stage. When support is implemented: sign in at [platform.openai.com](https://platform.openai.com/), open **API keys → Create new secret key**, copy the key starting with `sk-`, and add a payment method under **Billing**. OpenAI API billing is separate from a ChatGPT subscription. Do not paste an OpenAI key into the Claude field.

## Storage and privacy

- SQLite: `data/vizor.db`, relative to the workspace. WAL sidecars can exist while the app runs.
- Provider keys: AES-256-GCM, fresh 12-byte nonces, authenticated with owner/provider identity. The 32-byte base64 `MASTER_KEY` comes from `.env`. Decryption occurs server-side only for the chosen provider’s requests.
- Messages and system prompts: stored locally as ordinary database text. Full agent chat history is sent to Claude when you submit a message. Vizor does not execute model output, request provider tools, load remote Markdown images, or render raw HTML.
- Sessions: hashed random tokens in the database; expiring HttpOnly, SameSite=Strict cookies in the browser. HTTPS origins also set Secure.
- Runtime network traffic: only same-origin app requests and the selected Anthropic API. External console links open only when clicked. No analytics, telemetry, cloud database, remote fonts, or background AI calls are installed. Next.js telemetry is disabled in the generated environment.
- Dependencies are downloaded from npm during installation; browser test installation downloads Chromium from Playwright. Those development operations do not send conversations or provider keys.

Back up **both the database and `.env`**. Stop the app first, then copy `data/vizor.db` and any remaining WAL/SHM sidecars together. Restore them together before restarting. Losing or changing `MASTER_KEY` makes saved credentials unreadable; reconnect them or restore the original master key. An incorrect master key never triggers a silent reset. Protect backups and `.env` with Windows account/file permissions; someone who can read both can recover the provider credentials.

## Self-host and account modes

Default `.env` settings:

```dotenv
DATABASE_URL="file:./data/vizor.db"
SELF_HOST="true"
APP_ORIGIN="http://127.0.0.1:3000"
MASTER_KEY="<32 random bytes encoded as base64>"
NEXT_TELEMETRY_DISABLED="1"
```

`SELF_HOST=true` skips signup and uses one local owner. It requires a loopback origin. Keep the supplied local-only start commands; do not expose this mode through a proxy or tunnel.

`SELF_HOST=false` enables email/password registration, login and logout, still on localhost for stage one. Passwords require 12–128 characters and use Argon2id. Each account owns its credentials, agents, conversations, messages, and runs. There is no email delivery, password recovery, OAuth, or email verification in this stage. Stop and restart the server after environment changes. Switching modes retains the existing data; the local owner and email accounts have separate workspaces.

**Hosted PostgreSQL deployment is not delivered in stage one.** The data model uses portable relational fields; PostgreSQL will require its own provider configuration, driver and SQL migrations. Changing `DATABASE_URL` alone is insufficient. Public signup controls, deployment hardening and multi-process execution are future work.

## Chat behaviour

- Enter sends; Shift+Enter inserts a newline. Buttons also support keyboard navigation.
- **Stop** cancels the upstream request and keeps partial output. Cancellation cannot undo tokens already billed by the provider.
- **Regenerate** replaces the latest assistant response. Previous run usage remains in the accounting total.
- **Edit & resend** explicitly confirms deleting the edited message and subsequent active history. It retains prior generation usage records because those costs were already incurred.
- Client submission IDs prevent duplicate generations; a database lock allows one active run per conversation.
- A disconnected browser cancels its active request. Text is checkpointed while streaming and finalized on cancellation. A hard process crash can lose the last uncheckpointed text (normally up to 250 ms). Startup marks abandoned runs interrupted and frees their conversation locks.
- Execution/cancellation coordination is designed for **one Node process**. Do not run multiple instances against the same database in this stage.
- Models are fetched live after connection and on Refresh. If discovery fails, the settings panel labels the fallback list. Existing model selections are never silently changed. Temperature is sent only for known supported model families; unknown/new models omit it.
- Token counts come from provider usage events. Costs use a dated standard-text pricing table for known models. Unknown model costs display **Unavailable**; incomplete runs remain marked partial. Totals show a known subtotal plus unknown usage when appropriate. Connection-test charges are not included in conversation totals. This is an estimate, not a provider billing reconciliation or spending guard.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite starts separate local test servers on ports **3100** and **3101**, using isolated SQLite files and a Node preload that mocks **only** the Anthropic transport. That fixture is never imported by the app. Production code has no mock-provider switch. Tests use invented fixture keys and make no billable API calls. Test databases remain under ignored `data/` for inspection.

Automated coverage includes provider discovery/streaming/errors, fragmented UTF-8 events, aborts, encryption/tampering, authentication/session expiry, cross-account access, duplicate sends, concurrent-run locking, edits, and partial persistence. Browser checks exercise onboarding, conversation controls, provider replacement/removal, errors, responsive layouts and account login/logout. See [verification/REPORT.md](verification/REPORT.md) for the actual results and limits.

## Next stages — awaiting review

2. OpenAI, simultaneous agent status, draggable/resizable grids, saved layouts, templates, and full agent lifecycle.
3. Orchestrator summaries with compact context.
4. Structured proposals, editable approval queue and audit history.
5. Budgets, bounded autopilot, hourly/loop limits and a global kill switch. User preference: agent-triggered replies may send automatically within enforced limits; agent-management actions still need approval. The provenance and permission design must be reviewed before that stage.

No further stage is implemented automatically after this handoff.

API references: [model discovery](https://platform.claude.com/docs/en/api/models/list), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Prisma SQLite](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/sqlite).
