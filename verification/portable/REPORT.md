# Vizor v0.6.0 portable distribution

October 28, 2026. Precompiled, per-platform downloads include Node.js 24.22.1. No user-installed Node, npm, Git, Docker, compiler or database service is required. Rights reserved. Autopilot remains off.

## Package and first launch

- Named Windows x64 ZIP, macOS Intel and Apple silicon tarballs, and Linux x64 tarball. The bundled runtime archive is downloaded from nodejs.org and verified against that exact version's official SHA-256 before extraction.
- Next.js standalone server, local static assets, native SQLite/Argon2 libraries, SQL migrations, start guide and third-party license notices are included. All symlinks are dereferenced so packages can be relocated. Node and launch scripts retain executable permissions on Unix.
- The launcher uses its own runtime, creates a permanent local encryption key on a fresh install, migrates SQLite without Prisma CLI, binds only to 127.0.0.1, waits for readiness and opens the browser. It never installs, builds or downloads code at runtime.
- Database history remains compatible with Prisma. Checks cover migration checksums, unfinished upgrades, newer databases/downgrades, foreign-key integrity and transactional rollback. Existing populated databases are backed up before pending migrations. Windows CRLF and LF migration checksums are recognized. Prisma CLI independently reports a database created by the portable launcher as up to date.
- Packaging excludes configuration and database files and scans output for the build master key. Each user's `.env` and `data/` are created locally. CI fixtures and network guards stay outside the archive.
- A native-library load check runs using bundled Node before archive creation. This caught the need to ship Intel Mac Argon2's compiled `build/Release` binary, including Next's relocated module copies.

## Verification

Application/package source commit: `e335a2ce7d71ab068c87d3d4f29e6d4ad26607f4`.

The [portable workflow](https://github.com/colinosbo/vizor/actions/runs/40743890382) builds on each target system, runs type checking, **90 automated tests**, formatting, native-library checks, packaging and extracted-package smoke checks. Packages are uploaded to a matching draft only after their checks pass. Earlier failed attempts were not published.

| Package                     | Native runner  | Final result |
| --------------------------- | -------------- | ------------ |
| Windows x64 ZIP             | windows-latest | Passed       |
| macOS Apple silicon tarball | macos-15       | Passed       |
| macOS Intel tarball         | macos-15-intel | Passed       |
| Linux x64 tarball           | ubuntu-latest  | Passed       |

All four jobs passed before [v0.6.0 was published](https://github.com/colinosbo/vizor/releases/tag/v0.6.0). The release includes four platform packages, individual checksum files and [SHA256SUMS.txt](https://github.com/colinosbo/vizor/releases/download/v0.6.0/SHA256SUMS.txt).

After publication, the release was verified visible without authentication, all four package links returned HTTP 200, and the complete public Windows ZIP was downloaded and matched its published SHA-256. That downloaded ZIP then passed the extracted-package check locally with Node/npm absent from PATH. GitHub's latest-release endpoint points to v0.6.0.

The extracted-package check runs its actual platform launcher from a directory containing spaces with **Node and npm absent from PATH**. Real outbound fetch/HTTP requests are blocked; explicit provider operations use test fixtures. It checks:

- Empty, self-hosted first launch without provider keys or chosen budgets.
- Local HTML, JavaScript and CSS assets.
- Mocked Anthropic connection, streaming, saved messages and key removal.
- Real process restart preserving the exact encryption configuration, encrypted provider credentials, messages and spending cap.
- Account-mode registration using the shipped native Argon2 library, an HttpOnly cookie and an authenticated workspace request.
- Autopilot off throughout.

The [source-launch workflow](https://github.com/colinosbo/vizor/actions/runs/40743844367) separately passes fresh source setup, build, launch, type checking, all 90 tests and formatting on Windows, Intel macOS and Ubuntu.

Local Windows verification also passes **7 Chromium browser tests** covering onboarding/key lifecycle, chat controls, accessibility, desktop/mobile layouts, templates, real process restart, accounts, orchestration approvals/audit and spending guards. Production build and type checking pass. The existing local workspace was backed up; its exact `.env` fingerprint and database table counts were preserved when restarting v0.6.0.

## Boundaries

- Provider verification is mocked. No live paid inference, billing eligibility, or provider account configuration is claimed; users supply their own keys through the app.
- Runner checks cover Windows x64, macOS x64/arm64 and Ubuntu x64. They do not certify every OS version, distribution, CPU, browser auto-open handler or managed-device policy. Windows ARM, Linux ARM and Alpine are not verified targets.
- Packages are unsigned. Consumer Windows/macOS download-warning and Gatekeeper flows are not certified by hosted runner tests. Code signing, notarization, installers and automatic updates are not included.
- The Node runtime supports macOS 13.5+ and glibc Linux 2.28+/kernel 4.18+. Actual app checks use the named current hosted runners; compatibility with the oldest supported runtime OS versions has not been separately exercised.
- GitHub's automatic source archives still require Node. Choose a named platform release asset for the bundled version. Stop Vizor and preserve both `.env` and `data/` when updating; see [START-HERE.md](../../START-HERE.md).
