# Projects release verification — 0.10.20

Implemented project creation and separate project conversations/boards; dynamic Claude coding teams; shared-folder path coordination; GitHub pull-request verification and automatic merge; executive progress instructions; notification tones and saved mute; chat reopening at the latest message; GitHub device sign-in with a verified bundled CLI; fresh-account full auto defaults.

Bugs fixed during validation:
- Sidebar project groups needed a valid accessibility role.
- Old responses from a project switch could reset the selected project.
- Clearing one project's conversation disabled automation for every project.
- Shared-folder coding tasks were unnecessarily serialized; overlapping scopes now wait.
- Completed worker reports and follow-up questions could route to another project's Orchestrator.
- Package file tracing could include local build artifacts; build tracing and package copying now exclude them.
- Browser scenarios shared project data and a restart check could reconnect to an old test server; their fixtures are isolated.

Privacy: no workspace database, credentials, projects, or conversations are shipped. Tracked screenshots were visually checked and contain synthetic demonstration content. A historical public commit (7fd4a50) contains a project name in a test fixture; current fixtures use a generic example. History has not been rewritten. This audit does not prove that every historical Git object or old external download is free of private content.

Verification boundaries: automated GitHub merge tests use controlled command results for passing, failed, missing, changed-commit and uncertain-merge cases. No customer's repository was merged as a test. Subscription authentication and real Claude usage depend on the user's account and its allowance; automated tests do not consume paid inference. File scopes are coordination rules for coding workers, not an OS security boundary. GitHub checks must be configured as required checks for automatic merging.
