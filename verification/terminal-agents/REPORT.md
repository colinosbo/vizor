# v0.9.0 — local terminal agents

## Implemented

- Windows desktop panels host the real, unmodified Claude Code and Codex CLIs through separate native ConPTY processes using bundled Node. Existing API panels, keys, conversations and spending controls remain available.
- Native folder selection, tool detection, checksum-verified official setup, independent input/resize/interrupt/stop, native session resume, rename/pause/archive, persisted board layout, shared-project warnings and eight-process capacity limit.
- Owner-scoped engine/project/session metadata and additive migration from the API-only schema. Restart recovery records stopped terminals and never launches or sends tasks automatically.
- Narrow, origin-checked desktop bridge; opaque per-session tokens; no generic process-launch or executable-path interface. Vizor API/release/master keys are removed from tool environments. Native authentication stays with each CLI.
- Terminal clipboard/file-transfer/link escapes are consumed. Remote images and automatic links are not enabled. Terminal text is not parsed to invent task state or cost. Footer totals are explicitly API-only.
- Native permission prompts stay enabled. Terminal agents are excluded from orchestrator context, proposals and API send routes. Autopilot remains off. Quit confirmation and update deferral account for live terminals.

## Passed locally

- Type checking, production build and formatting checks.
- **115 automated tests** across 17 files. Provider transports and terminal processes are mocked where stated: ownership, encryption/session protections, streaming/errors, API spending controls, input/stop isolation, stale-token rejection, start deduplication, shared-project confirmation, interruption, bounded replay, native permission arguments, secret environment stripping and rejection of tampered native downloads.
- **10 browser checks** cover existing onboarding/API functionality, concurrency, approvals, account isolation, saved layout, desktop/mobile accessibility, plus a mocked desktop bridge for terminal creation, independent input, stop, keyboard movement and native terminal font rendering. The terminal check additionally verifies paste routing and suppression of clipboard-writing/file-transfer/link escapes.
- Extracted portable package starts with Node/npm removed from PATH; offline initial boot, local assets, mocked provider streaming, key removal, restart persistence, registration and autopilot-off checks pass. Portable downloads retain API functionality.
- Real Windows ConPTY checks use the **packaged helper and bundled Node**, with an empty PATH: concurrent fixture shells, input/resize/stop isolation, Ctrl+C, subsequent input and owned-process cleanup. These fixture shells make no model calls.
- Official Claude Code 2.1.308 executable and complete Codex 0.165.0 native package downloaded and checked against pinned SHA-256 values. Codex's full package layout includes its code host, command runner, sandbox helper and search tool; a bare executable was insufficient for editing.
- Both actual CLIs opened concurrently in a separate packaged-app workspace with Node removed from PATH. Claude Code displayed its native project trust/login interface. Native account tokens and terminal transcripts were not logged or published.
- A signed-in **real Codex** session created the requested proof file in an isolated verification project through its native coding tools. This was a live account request, separate from mocked tests.
- Real Codex stop/resume reused the exact native session ID and replayed its own saved history. Stopping one actual CLI left the other alive. Killing only the isolated app's main process cleaned up all 18 owned descendant processes. Reopening restored its two-panel board with all terminals stopped; explicit resume recovered Codex history again.

## Release checks

The Windows workflow builds an exact committed revision, validates packaged helper/native resources, runs real ConPTY with bundled Node, installs/launches/reinstalls/uninstalls the real NSIS package on a clean Windows runner with no Node on PATH, checks shortcuts/data retention, and tests a two-version automatic update using separate private fixture apps. Installer upload is blocked unless those exact-build checks pass. Portable Windows/macOS/Linux jobs separately compile and test their API packages. See the release's workflow links for final outcomes.

The v0.8.0-to-v0.9.0 schema change is additive; existing agents default to `api`. Migration tests retain populated messages, users and credential ciphertext and verify foreign keys and pre-upgrade backups. Native CLI histories remain in the tools' own profiles rather than Vizor's database.

## Not verified / limits

- **Claude Code authenticated coding and saved-conversation resume remain unverified:** no signed-in Claude Code account was available for the live check. Sign in inside the normal CLI interface to use it. The existing Anthropic API connection is separate.
- Fresh browser-based subscription sign-in for either provider and OS-native folder-picker interaction still require an interactive account/user check. Existing Codex account reuse and native Claude trust/login UI were checked; these are not claims of fresh sign-in testing.
- Model approval prompts depend on the native tool and the requested action. Native permission flags and trust prompts were checked; an elevated command-approval flow was not exercised against a live account.
- Custom user hooks can require additional runtimes; Vizor preserves those hooks rather than silently changing them. Selecting a project is a working directory, not a guarantee that every native CLI operation is confined there. Windows Claude Code has no OS sandbox.
- Windows ARM, terminal agents outside the Windows desktop app, hosted/multiuser terminal access, orchestrator control of terminals and autopilot are outside this release. CLI costs/limits are managed by the tool/account; Vizor's API dollar caps do not cover them.
- Installer publisher signing remains out of scope. The existing permanent updater signature is preserved; Windows publisher warnings can still occur.
