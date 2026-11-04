# Vizor: install, connect, and start

## What you need

A 64-bit Windows 11 PC, internet, a Claude account with access to Claude Code, and a folder for your project. Claude subscription limits apply. To use GitHub pull requests and automatic merges, also install [Git for Windows](https://git-scm.com/download/win), have access to a GitHub repository, and configure at least one required GitHub check on its default branch. GitHub CLI is included in the Windows app.

## 1. Install

Open [the latest release](https://github.com/colinosbo/vizor/releases/latest), expand **Assets**, and download **Vizor-Setup-<version>-x64.exe**. Run it and open Vizor. Windows can show an unknown-publisher warning because the installer is unsigned. Only run a download you trust.

## 2. Create your first project

Select **Create project**, name the feature or piece of work, and choose its folder. You can create another project for a different feature even if it uses the same repository. Each project has its own Orchestrator, agents, tasks, and conversation.

## 3. Connect Claude

Open the project's **Orchestrator**, select **Set up orchestrator**, and choose **Claude Code subscription**. Select **Set up Claude subscription** and finish Claude's sign-in in the terminal/browser, choosing your subscription account. Save the settings. Vizor installs Claude Code if needed and uses the same subscription sign-in for the Orchestrator and its coding workers. No Anthropic API key is needed for this mode. Claude's own usage limits apply.

## 4. Connect GitHub

In **Orchestrator settings**, select **Connect GitHub**. Follow the device sign-in instructions and authorize your own GitHub account in your browser. Your repository must have an `origin` pointing to GitHub, and your account needs permission to push branches and create and merge pull requests. Install Git for Windows first; reopen Vizor after installation so it can find Git.

## 5. Give it work

Tell the Orchestrator what you want built and the outcome you expect. It chooses a suitable coding team with separate assignments. New accounts start with **Full auto approval** and **Run approved queue** enabled. Turn these controls off in **Approvals** if you want to approve tasks yourself. Existing accounts retain their saved settings. Claude Code may still ask you to trust the folder or approve a command; open the worker if it needs attention.

Workers in the same folder can run together when their declared file scopes do not overlap. Those scopes are coordination instructions, not an operating-system sandbox. Avoid making conflicting changes manually while they work.

For a GitHub-backed project, the Orchestrator can have a coding worker prepare and push a feature branch, then request a normal pull request. Vizor checks the branch, reported work and required GitHub checks before merging. It reports missing checks, authentication problems, conflicts, failures, or uncertain merge results as blockers. Other approval controls still apply; the requested merge is automatic once its checks pass.

## Notifications and troubleshooting

- The sound button in the sidebar mutes or unmutes message and approval sounds. Your choice is saved on this PC.
- If Claude reports a billing or login problem, repeat **Set up Claude subscription** with the subscribed account. Subscription mode does not fall back to API billing.
- If a worker is waiting, open its terminal and handle any Claude setup or permission prompt.
- If GitHub verification is blocked, confirm Git is installed, GitHub is connected, the repository has required checks configured, and the feature branch is pushed. Read the specific blocker in Vizor.
- Use **Help → Check for updates** to update. Stop active coding sessions first.

Your new installation starts with its own empty workspace; it does not include the developer's projects, conversations, credentials, or agents. Keep your own backups private. See [WINDOWS.md](WINDOWS.md) for backup and uninstall details. Never share credentials, `.env`, databases, or private project files in an issue.
