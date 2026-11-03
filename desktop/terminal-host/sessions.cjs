const { randomUUID } = require("node:crypto");
const { realpathSync, statSync, existsSync, readdirSync } = require("node:fs");
const { isAbsolute } = require("node:path");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { Terminal } = require("@xterm/headless");
const MAX_TERMINAL_BUFFER_CHARS = 4 * 1024 * 1024;
const READY_WAIT_MS = 45000;
function environment(source = process.env) {
  const env = { ...source, TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const key of Object.keys(env))
    if (
      /^(MASTER_KEY|DATABASE_URL|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|GH_TOKEN|GITHUB_TOKEN|VIZOR_UPDATE_SIGNING_KEY|VIZOR_TERMINAL_TOKEN|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|APP_ORIGIN|VIZOR_WORKSPACE|VIZOR_TERMINALS)$/i.test(
        key,
      )
    )
      delete env[key];
  return env;
}
function projectPath(path) {
  if (!isAbsolute(path) || path.includes("\0"))
    throw Error("Choose a local project folder.");
  const canonical = realpathSync(path);
  if (canonical.startsWith("\\\\") || !statSync(canonical).isDirectory())
    throw Error("Choose a local project folder.");
  return canonical;
}
function bootstrapCodex(file, cwd, env, name = "Vizor agent") {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ["app-server", "--listen", "stdio://"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let pending = "",
      done = false;
    const timer = setTimeout(
      () => finish(Error("Sign in with Codex using Set up, then try Resume.")),
      45000,
    );
    function finish(error, id) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      error ? reject(error) : resolve(id);
    }
    const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
    child.once("error", () =>
      finish(Error("Codex could not start. Run Set up and try again.")),
    );
    child.once("exit", () => {
      if (!done)
        finish(Error("Codex setup is incomplete. Open Set up to sign in."));
    });
    child.stdout.on("data", (bytes) => {
      pending += bytes.toString();
      if (pending.length > 2000000)
        return finish(Error("Codex returned an invalid setup response."));
      let line;
      while ((line = pending.indexOf("\n")) >= 0) {
        const raw = pending.slice(0, line);
        pending = pending.slice(line + 1);
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        if (message.error)
          return finish(
            Error(
              "Codex could not prepare a session. Run Set up and try again.",
            ),
          );
        if (message.id === 1) {
          send({ method: "initialized" });
          send({
            id: 2,
            method: "thread/start",
            params: {
              cwd,
              approvalPolicy: "on-request",
              sandbox: "workspace-write",
            },
          });
        }
        if (message.id === 2) {
          const id = message.result?.thread?.id;
          if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
            finish(
              Error(
                "Codex could not prepare a session. Open Set up to sign in.",
              ),
            );
          else {
            // Codex defers saving zero-turn threads. Naming the thread materializes
            // its native history without sending a prompt or making a model call.
            send({
              id: 3,
              method: "thread/name/set",
              params: { threadId: id, name: name.slice(0, 100) },
            });
            child.vizorThreadId = id;
          }
        }
        if (message.id === 3) finish(null, child.vizorThreadId);
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "vizor", title: "Vizor", version: "0.9.0" },
      },
    });
  });
}
class Sessions {
  constructor({
    pty,
    notify,
    findTool,
    bootstrap = bootstrapCodex,
    env = environment(),
    persist = async () => {},
    terminate = (terminal) => terminal.kill(),
    claudeConfigDir = null,
  }) {
    Object.assign(this, {
      pty,
      notify,
      findTool,
      bootstrap,
      env,
      persist,
      terminate,
      claudeConfigDir,
    });
    this.sessions = new Map();
    this.pending = new Set();
  }
  list() {
    return [...this.sessions.values()].map((s) => this.view(s));
  }
  view(s) {
    return {
      agentId: s.agentId,
      engine: s.engine,
      token: s.token,
      state: s.state,
      nativeSessionId: s.nativeSessionId,
      projectPath: s.projectPath,
      exitCode: s.exitCode ?? null,
      sequence: s.sequence,
      inputReady: s.inputReady === true,
    };
  }
  async start(
    agent,
    confirmShared = false,
    setup = false,
    claudeApiKey = null,
  ) {
    const old = this.sessions.get(agent.id);
    if (old?.state === "running") return this.view(old);
    if (this.pending.has(agent.id))
      throw Error("This agent is already starting.");
    if (
      this.list().filter((s) => s.state === "running").length +
        this.pending.size >=
      8
    )
      throw Error(
        "Stop an open terminal before starting another (eight at a time).",
      );
    if (agent.archived || agent.paused)
      throw Error("Restore or resume this agent before starting it.");
    const cwd = projectPath(agent.projectPath);
    const same = (s) =>
      s.state === "running" &&
      s.projectPath.toLowerCase() === cwd.toLowerCase();
    if (!setup && !confirmShared && this.list().some(same))
      return { conflict: true };
    const file = this.findTool(agent.engine);
    if (!file) throw Error("This tool is not installed. Choose Set up.");
    this.pending.add(agent.id);
    try {
      let nativeSessionId = agent.nativeSessionId;
      if (!setup && agent.engine === "codex" && !nativeSessionId)
        nativeSessionId = await this.bootstrap(file, cwd, this.env, agent.name);
      if (!nativeSessionId) nativeSessionId = randomUUID();
      let hasClaudeHistory = false;
      if (agent.engine === "claude-code" && agent.terminalStarted) {
        const projects = join(
          this.claudeConfigDir ||
            this.env.CLAUDE_CONFIG_DIR ||
            join(this.env.USERPROFILE || "", ".claude"),
          "projects",
        );
        try {
          hasClaudeHistory = readdirSync(projects, {
            withFileTypes: true,
          }).some(
            (entry) =>
              entry.isDirectory() &&
              existsSync(
                join(projects, entry.name, `${nativeSessionId}.jsonl`),
              ),
          );
        } catch {}
      }
      const args = setup
        ? agent.engine === "codex"
          ? ["login"]
          : []
        : agent.engine === "claude-code"
          ? [
              hasClaudeHistory ? "--resume" : "--session-id",
              nativeSessionId,
              "--permission-mode",
              ["default", "acceptEdits", "auto"].includes(agent.permissionMode)
                ? agent.permissionMode
                : "acceptEdits",
            ]
          : [
              "resume",
              nativeSessionId,
              "--sandbox",
              "workspace-write",
              "--ask-for-approval",
              "on-request",
              "--no-daemon",
            ];
      // Recheck after asynchronous preparation: another agent may have claimed this project.
      if (!setup && !confirmShared && this.list().some(same))
        return { conflict: true };
      const terminalEnv =
        agent.engine === "claude-code" &&
        typeof claudeApiKey === "string" &&
        claudeApiKey.length > 0
          ? {
              ...this.env,
              ...(this.claudeConfigDir
                ? { CLAUDE_CONFIG_DIR: this.claudeConfigDir }
                : {}),
              ANTHROPIC_API_KEY: claudeApiKey,
            }
          : this.env;
      const terminal = this.pty.spawn(file, args, {
        name: "xterm-256color",
        cols: 100,
        rows: 28,
        cwd,
        env: terminalEnv,
        useConpty: true,
        useConptyDll: true,
      });
      const session = {
        agentId: agent.id,
        token: randomUUID(),
        state: "running",
        nativeSessionId,
        projectPath: cwd,
        terminal,
        buffer: "",
        inputReady: false,
        screen: new Terminal({
          cols: 100,
          rows: 28,
          scrollback: 0,
          allowProposedApi: true,
        }),
        engine: agent.engine,
        sequence: 0,
      };
      this.sessions.set(agent.id, session);
      this.notify({ ...this.view(session), type: "state" });
      terminal.onData((data) => {
        session.sequence++;
        session.buffer = (session.buffer + data).slice(
          -MAX_TERMINAL_BUFFER_CHARS,
        );
        session.screen.write(data, () => {
          if (session.state !== "running" || session.submitting) return;
          const buffer = session.screen.buffer.active;
          const line =
            buffer
              .getLine(buffer.baseY + buffer.cursorY)
              ?.translateToString(true) || "";
          const viewport = Array.from(
            { length: session.screen.rows },
            (_, row) =>
              buffer.getLine(buffer.baseY + row)?.translateToString(true) || "",
          ).join("\n");
          const setupPrompt =
            /Syntax theme:|choose[^\n]*theme|select[^\n]*login method|Do you trust this folder/i.test(
              viewport,
            );
          const permissionMenu = /^\s*[❯›>]\s*\d+[.)]/u.test(line);
          const ready =
            !setupPrompt && !permissionMenu && /^\s*[❯›>](?:\s|$)/u.test(line);
          if (ready !== session.inputReady) {
            session.inputReady = ready;
            this.notify({ ...this.view(session), type: "state" });
          }
        });
        this.notify({ ...this.view(session), type: "data", data });
      });
      terminal.onExit(({ exitCode }) => {
        session.sequence++;
        session.state = "stopped";
        session.exitCode = exitCode;
        session.screen.dispose();
        this.notify({ ...this.view(session), type: "state" });
        if (!setup && this.sessions.get(agent.id) === session)
          void this.persist(agent.id, nativeSessionId, "stopped").catch(
            () => {},
          );
      });
      if (!setup)
        await this.persist(agent.id, nativeSessionId, "started").catch(() => {
          this.stop(agent.id, session.token);
          throw Error("Session could not be saved. Try Resume.");
        });
      this.notify({ ...this.view(session), type: "state" });
      return this.view(session);
    } finally {
      this.pending.delete(agent.id);
    }
  }
  owned(id, token) {
    const s = this.sessions.get(id);
    if (!s || s.token !== token || s.state !== "running")
      throw Error("This terminal session has stopped. Refresh its panel.");
    return s;
  }
  input(id, token, data) {
    if (typeof data !== "string" || data.length > 65536)
      throw Error("Invalid terminal input");
    const session = this.owned(id, token);
    session.terminal.write(data);
    if ((data.includes("\r") || data.includes("\n")) && session.inputReady) {
      session.inputReady = false;
      this.notify({ ...this.view(session), type: "state" });
    }
  }
  async sendTask(id, token, text) {
    if (typeof text !== "string" || !text.trim() || text.length > 65536)
      throw Error("This assignment is invalid or too large to send.");
    const safeText = text
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const session = this.owned(id, token);
    const deadline = Date.now() + READY_WAIT_MS;
    while (!session.inputReady) {
      if (session.state !== "running")
        throw Error("The terminal stopped before its task prompt was ready.");
      if (Date.now() >= deadline)
        throw Error(
          "The terminal opened, but its task prompt was not ready. Check the terminal for sign-in or permission prompts; the assignment was not sent.",
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Use bracketed paste so multi-line plans arrive as one editor paste rather
    // than being interpreted as a sequence of terminal commands.
    session.submitting = true;
    try {
      session.terminal.write(`\x1b[200~${safeText}\x1b[201~`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (session.state !== "running")
        throw Error(
          "The terminal stopped before the assignment was submitted.",
        );
      session.terminal.write("\r");
      session.inputReady = false;
    } finally {
      session.submitting = false;
    }
    this.notify({ ...this.view(session), type: "state" });
  }
  resize(id, token, cols, rows) {
    if (
      ![cols, rows].every(Number.isSafeInteger) ||
      cols < 2 ||
      cols > 400 ||
      rows < 2 ||
      rows > 200
    )
      throw Error("Invalid terminal size");
    const session = this.owned(id, token);
    session.screen.resize(cols, rows);
    session.terminal.resize(cols, rows);
  }
  interrupt(id, token) {
    this.input(id, token, "\x03");
  }
  stop(id, token) {
    const s = this.owned(id, token);
    s.terminal.write("\x03");
    const ending = this.terminate(s.terminal);
    s.state = "stopped";
    s.sequence++;
    this.notify({ ...this.view(s), type: "state" });
    if (!s.agentId.startsWith("setup-"))
      void this.persist(s.agentId, s.nativeSessionId, "stopped").catch(
        () => {},
      );
    return ending;
  }
  snapshot(id) {
    const s = this.sessions.get(id);
    return s
      ? { ...this.view(s), data: s.buffer }
      : { agentId: id, state: "stopped" };
  }
  dispose() {
    for (const s of this.sessions.values())
      if (s.state === "running") {
        try {
          this.stop(s.agentId, s.token);
        } catch {}
      }
  }
}
module.exports = { Sessions, environment, projectPath, bootstrapCodex };
