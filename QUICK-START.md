# Vizor: download, sign in, start working

**For Windows 11, Intel/AMD 64-bit.** You need internet and your own Claude account with a subscription that includes Claude Code. No API key, Node installation, or commands are needed. Claude's normal subscription usage limits still apply.

## 1. Install Vizor

Open **[the latest GitHub release](https://github.com/colinosbo/vizor/releases/latest)**. Under **Assets**, download **`Vizor-Setup-<version>-x64.exe`**. Run it, accept the license, and open **Vizor** from your desktop or Start menu.

Choose the **EXE installer**, not GitHub's **Source code** ZIP or a portable archive. The installer is unsigned, so Windows may show an unknown-publisher warning. Only proceed if you trust this project's release; a managed PC may block unsigned apps.

## 2. Connect your Claude subscription

Open **Orchestrator → Set up orchestrator** (or its settings if already configured). Choose **Claude Code subscription**, then **Set up Claude subscription**.

Vizor downloads the official Claude Code tool if needed and opens its native login. Complete the browser sign-in using the Claude account that has your subscription. If asked for an account type, choose your **Claude subscription**, not Anthropic Console/API billing. Return to Vizor when Claude confirms login, choose **Sonnet** to start, and save the Orchestrator settings.

Vizor keeps a separate Claude login profile, so you may need to sign in here even if you already use Claude elsewhere. Your Claude password and sign-in tokens are handled by Claude Code, not pasted into Vizor's API key settings. The Orchestrator and subscription workers share this profile.

## 3. Add a coding agent

Choose **New agent → Claude Code**. Give it a name, use **Browse** to choose the project folder it should work in, and leave billing on **Claude subscription**. Save it, then use **Set up / sign in** or **Resume** to open its terminal. Complete any Claude theme, trust, or permission prompts shown there.

Start with a simple task: **“Read this project and explain what it does. Do not change files yet.”** You can type directly in that agent's terminal. Claude can edit files and run commands when you allow it, so choose the project folder carefully.

## 4. Use the Orchestrator

Tell it what you want done and which project to use. Review and approve its proposed agents or tasks. Approved tasks are delivered to the workers; Claude's own permission prompts may still need your attention.

Manual approval is the default. Leave **full auto approval** and the **approved-task queue** off until you understand how they work. Subscription mode does not fall back to paid API requests. Vizor's API dollar caps do not measure Claude subscription usage.

## If something gets stuck

- **Login or “credit balance too low”:** repeat **Set up Claude subscription** and sign in with the correct subscribed Claude account. Do not add an API key to fix subscription login.
- **Usage limit:** wait for your Claude allowance to reset or check your plan in Claude. Vizor cannot bypass it.
- **Worker waiting:** open its terminal and answer any setup, trust, or permission prompt. Use **Interrupt** to stop a response or **Stop** to close that agent's terminal.
- **Update Vizor:** use **Help → Check for updates**. Close running agent sessions before restarting to install it.

Still stuck? [Open an issue](https://github.com/colinosbo/vizor/issues) with your Windows version, Vizor version, and the error text. Never share passwords, tokens, `.env`, databases, or private project files.

Want the browser-only portable app or an API connection instead? See [START-HERE.md](START-HERE.md). Backups and uninstall steps are in [WINDOWS.md](WINDOWS.md). Claude's account requirements and login behavior are documented in its [authentication guide](https://code.claude.com/docs/en/iam) and [CLI reference](https://code.claude.com/docs/en/cli-reference).
