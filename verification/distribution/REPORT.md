# Downloadable Vizor v0.5.0

October 28, 2026. A source download with automatic local setup for Node.js 24 LTS. Rights reserved; downloading/running a personal or internal workspace is permitted by the included LICENSE. Autopilot remains off.

## Download experience

- Extract the release ZIP, then open the Windows/macOS launcher or use the Linux shell launcher. The shared launcher checks Node, installs pinned dependencies, prepares an independent encryption key/database, builds the production app, waits for readiness, and opens the local browser.
- Node.js 24 is the only manually installed runtime prerequisite for the supported targets. No Git, Codex, Docker or database server is required. The initial install/build needs internet; later runs reuse the cached installation/build. This is not a signed native installer.
- Existing data without its encryption key and invalid existing configuration fail safely. Busy ports are not taken over. A local process lock prevents two launchers from modifying the same installation. Configuration/data are retained by repair; documented updates preserve the matching `.env` and database.
- The health endpoint exposes only app name, version and readiness, retaining host/origin checks. Provider keys still enter through masked in-app onboarding and are encrypted locally. Each new installation starts without keys, agents, messages or chosen spending caps.

## Verified locally on Windows x64

- A clean ZIP was extracted into a new temporary folder **with spaces**, without `.env`, data, installed modules, build output or Git metadata. Its launcher installed dependencies without C++ build tools, generated/migrated SQLite, built Next.js, and served the production app at a separate loopback port.
- The clean app returned an empty self-hosted workspace, no connected credentials, no spend/limits, and `autopilot:false`. After stopping it, repeat setup kept the exact original `.env` key and applied no extra migrations.
- A second launcher run reused the dependency/build caches and preserved the same encryption key. The app became ready without reinstalling or rebuilding.
- **85 automated tests and 7 Chromium browser checks pass against the extracted installation and its pinned dependency set.** Type checking and production build pass. The Windows wrapper's help entry works from outside the app folder. Existing browser coverage includes onboarding/key lifecycle, chats/stop/edit/regenerate, accounts, layouts/templates, a real process restart, both-provider orchestration, human approval/audit and spending guards.
- The clean-install check caught an unwanted native rebuild in SQLite 13. Dependencies are now pinned consistently to **better-sqlite3 12.11.1**, which provides the Node 24 prebuilt binaries and matches the Prisma driver's 12.x API. Fresh setup/migrations, the app and all tests pass using this pin; npm reports no known production dependency vulnerabilities.
- The existing personal workspace was backed up before the dependency upgrade. Its `.env` and original database records are checked for preservation. It is not packaged in the release.

## Platform checks

The checked-in [download workflow](https://github.com/colinosbo/vizor/actions/workflows/download-check.yml) performs a clean launcher smoke test, type checking, all 85 automated tests and formatting on standard Windows, macOS and Ubuntu runners using Node.js 24. All three jobs passed in [run 40738257357](https://github.com/colinosbo/vizor/actions/runs/40738257357), testing application commit `4d9dfef`. The release adds only documentation after that tested commit. The initially queued Apple Silicon job was replaced by a standard Intel Mac job; no Apple Silicon pass is claimed.

| Platform    | Local / hosted result                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Windows x64 | Local clean ZIP, 85 tests and 7 browser checks passed; hosted fresh launch/type checks/tests/formatting passed |
| macOS Intel | Hosted fresh launch/type checks/tests/formatting passed on macos-15-intel                                      |
| Linux x64   | Hosted fresh launch/type checks/tests/formatting passed on ubuntu-latest                                       |

## Release boundaries

- No real-provider inference, account eligibility, billing or live tool behavior has been tested with a user's key. Mocked checks make no paid provider calls. API usage and connection tests are charged by the user's provider account.
- Platform checks cover the named runner architectures, not every OS version/CPU or Linux distribution. Apple Silicon, Windows ARM, Linux ARM, old OS releases, unusual Linux libc versions, physical-phone use and browser auto-open handlers are not separately certified. Standard prebuilt-native dependency support is required.
- Public downloads keep the existing loopback binding and self-host defaults. This release does not provide hosted PostgreSQL, public multi-user hosting, a signed installer, automatic app updates or autopilot.
- The archive contains committed project files only. `.env`, databases, local credentials, caches, native build output, `node_modules` and personal workspace data are excluded. Release assets include a SHA-256 checksum for integrity checking.

See [START-HERE.md](../../START-HERE.md) for exact installation, backup, upgrade and recovery steps.
