# Claude Code and Codex in Vizor

Terminal agents are supported in the Windows 11 x64 desktop app from v0.9.0. Each friend installs Vizor on their own computer and signs in to their own tools. There is no shared cloud server or shared subscription.

1. Open Vizor and choose **New agent**.
2. Enter a name, choose **Claude Code** or **Codex**, then **Browse** for a local project folder. Engine and project stay fixed for that agent; create another agent to change them.
3. Choose **Set up / sign in**. Vizor detects an existing native executable. If missing, it downloads an official native release and verifies its pinned SHA-256 before installation. No Node installation or pasted command is needed. Finish the tool's normal sign-in prompts. Any browser login opens through the CLI's normal flow.
4. Choose **Resume**. Click inside the terminal to type, choose models, accept or reject permission prompts, and give the agent a task.

**Interrupt** sends Ctrl+C. **Stop** closes the terminal process and keeps its native session history. **Resume** reopens that session. Settings allow renaming, pausing, duplicating and archiving; archiving stops the terminal and hides it from the active board. Duplicates start a separate conversation. Restore archived agents from Archive. Deleting native CLI history outside Vizor can make resume unavailable; create a new agent if that history is gone.

Use the panel grip to drag, or focus it and press Left/Right to reorder. The bottom-right handle supports dragging and arrow keys to resize. Focus a terminal by clicking its surface or using Tab. Standard terminal paste uses the app's Edit → Paste or Ctrl+V. Select text and use **Copy selection**. Native Ctrl+C interrupts; it is not the copy shortcut. Clipboard-writing escape sequences, file-transfer escapes, remote images and automatic terminal links are disabled.

Up to eight terminal processes can run at once, including setup windows. Their input, resize, interrupt and stop controls are tied to an agent and a fresh session token. Closing or collapsing a panel does not stop its process. A warning appears before another coding terminal starts in the same canonical project folder; simultaneous edits can conflict. Separate projects or Git worktrees are safer for independent tasks.

The panel says **Running** when its process is alive and **Stopped** after it exits. These describe the terminal process, not whether the model is thinking or a task is complete. A failed process shows its exit code and can be resumed. Reopening Vizor restores the board and project/session metadata; it never automatically sends tasks or starts terminal agents. Closing with live sessions asks whether to stop them and quit. App updates wait for terminal sessions to close.

Each CLI controls its own authentication, conversation storage, models, limits, billing and native approval prompts. Vizor does not read login tokens or collect subscription passwords. Claude Code uses its default permission mode; Codex starts with workspace-write and on-request approvals. Existing tool configuration, project instructions and hooks still apply. Windows Claude Code does not provide an OS sandbox, and selecting a folder does not confine all tool access. Review native permission prompts before allowing commands.

API connections remain available as an engine. Their messages stream as Markdown with Vizor token/cost reporting and dollar caps. CLI usage is managed by the tool/account; **Vizor's API spending limits do not cap subscription or CLI API usage**. No fabricated cost or thinking status is shown for terminal agents.

The API-backed Orchestrator can include terminal agents in its planning context, but receives only their name, engine, project path and process state—never terminal text, native history or sign-in data. It can draft a terminal task for a specific Claude Code or Codex agent. You must approve that draft, then select **Start & send** in the Windows app. That second click starts the selected agent if needed and sends only the approved task to its session. Vizor never approves a native permission prompt, sends unapproved terminal input, or runs terminal work on autopilot.

The first setup pins Claude Code 2.1.308 from Anthropic and the complete Codex 0.165.0 native package from OpenAI, including its code host, command runner, sandbox helper and search tool. Tool binaries remain unmodified; subsequent tool behavior and updates follow their own settings. Use an existing compatible native installation or choose **Install verified version** inside setup to repair a missing/outdated tool after stopping its terminals. Setup requires internet. Your own custom CLI hooks may require additional runtimes; Vizor does not rewrite or disable those hooks. Missing CLI support never silently falls back to a paid API connection.

Supported integration references: [Claude Code hosting guidance](https://code.claude.com/docs/en/legal-and-compliance), [Codex integration options](https://developers.openai.com/blog/codex-as-a-platform). Verification boundaries are recorded in the [release report](verification/terminal-agents/REPORT.md).
