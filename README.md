# Vizor

Vizor is a background runner and a local web dashboard. It dispatches an approved GitHub plan to coding agents, verifies their results, and keeps going after you close the dashboard tab.

- **Runner:** the scheduler, relay and recovery paths in [`scripts/initiative-runtime/`](scripts/initiative-runtime/). On Windows it is supervised by per-user scheduled tasks.
- **Dashboard:** served on loopback. It reads the same durable project state as the runner, so you see the same queue, worker status, PR checks and blockers when you reopen it.
- **CLI:** `node scripts/initiative-runtime/scripts/vizor.mjs` for setup and troubleshooting (`init`, `doctor`, `status`, `schedule --preview`, `dashboard`).

Dispatch is local by default and needs no public endpoint. Webhook mode is optional and uses a public HTTPS URL you supply.

Setup, commands and current limits are in the [runtime README](scripts/initiative-runtime/README.md). Decisions are in [AGENTS.md](AGENTS.md) and remaining release work in the [roadmap](docs/ROADMAP.md).

## Development

Requires Node.js 24. The runtime has no npm dependencies; `npm install` only adds Prettier.

```sh
npm test
npm run format:check
```

Project configuration, queue state, logs and credentials live in each project's `.vizor/` folder and the OS credential helper. Never commit them here.
