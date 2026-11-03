const { Sessions } = require("./sessions.cjs");
const { findTool, installTool } = require("./tools.cjs");
const home = process.env.VIZOR_TOOLS_HOME;
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
mkdirSync(join(home, "setup"), { recursive: true });
mkdirSync(join(home, "claude-config"), { recursive: true });
mkdirSync(join(home, "claude-subscription"), { recursive: true });
const origin = process.env.VIZOR_TERMINAL_ORIGIN;
const token = process.env.VIZOR_TERMINAL_TOKEN;
if (
  !process.send ||
  !home ||
  !token ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || "")
)
  throw Error("Private desktop IPC is required");
const notify = (event) => {
  if (process.connected) process.send({ event });
};
async function api(id, body) {
  const response = await fetch(
    `${origin}/api/terminal-agents/${encodeURIComponent(id)}`,
    {
      method: body ? "PATCH" : "GET",
      headers: { origin, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok)
    throw Error(
      "This agent is unavailable. Restore it or reopen the desktop workspace.",
    );
  return response.json();
}
async function claudeApiKey() {
  const response = await fetch(`${origin}/api/terminal-credentials/anthropic`, {
    headers: { origin, authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw Error(
      "Connect Anthropic in Vizor Settings before starting this Claude Code terminal.",
    );
  const result = await response.json();
  if (typeof result.apiKey !== "string" || result.apiKey.length < 1)
    throw Error(
      "Connect Anthropic in Vizor Settings before starting this Claude Code terminal.",
    );
  return result.apiKey;
}
const pty = require("./isolated-pty.cjs");
const sessions = new Sessions({
  pty,
  notify,
  findTool: (engine) => findTool(engine, home),
  claudeConfigDir: join(home, "claude-config"),
  subscriptionConfigDir: join(home, "claude-subscription"),
  persist: (id, nativeSessionId, event) => api(id, { nativeSessionId, event }),
});
let installing = false;
process.on("message", async (message) => {
  if (typeof message?.id !== "string") return;
  try {
    const { action, args = {} } = message;
    let result;
    if (action === "tools")
      result = ["claude-code", "codex"].map((engine) => ({
        engine,
        installed: !!findTool(engine, home),
      }));
    else if (action === "install") {
      if (
        sessions
          .list()
          .some((s) => s.state === "running" && s.engine === args.engine)
      )
        throw Error(
          "Stop this tool's terminals before installing its verified version.",
        );
      if (installing) throw Error("Another tool is being installed.");
      installing = true;
      try {
        await installTool(args.engine, home, (progress) =>
          notify({ type: "install", engine: args.engine, progress }),
        );
        result = { installed: true };
      } finally {
        installing = false;
      }
    } else if (action === "list") result = sessions.list();
    else if (installing && ["start", "setup"].includes(action))
      throw Error(
        "Wait for the tool installation to finish before opening another terminal.",
      );
    else if (action === "start") {
      const agent = await api(args.agentId);
      result = await sessions.start(
        agent,
        args.confirmShared === true,
        false,
        agent.engine === "claude-code" && agent.terminalAuthMode === "api"
          ? await claudeApiKey()
          : null,
      );
    } else if (action === "setup")
      result = await sessions.start(
        {
          id: `setup-${args.engine}`,
          engine: args.engine,
          projectPath: join(home, "setup"),
        },
        false,
        true,
        null,
      );
    else if (action === "snapshot") result = sessions.snapshot(args.agentId);
    else if (action === "sendTask") {
      await sessions.sendTask(args.agentId, args.token, args.text);
      result = { ok: true };
    } else if (["input", "resize", "interrupt", "stop"].includes(action)) {
      if (action === "input")
        sessions.input(args.agentId, args.token, args.data);
      else if (action === "resize")
        sessions.resize(args.agentId, args.token, args.cols, args.rows);
      else await sessions[action](args.agentId, args.token);
      result = { ok: true };
    } else throw Error("Unknown terminal action");
    if (process.connected) process.send({ id: message.id, result });
  } catch (error) {
    if (process.connected)
      process.send({
        id: message.id,
        error: error.message || "Terminal request failed",
      });
  }
});
process.on("disconnect", async () => {
  sessions.dispose();
  await pty.dispose();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  sessions.dispose();
  await pty.dispose();
  process.exit(0);
});
setInterval(async () => {
  for (const session of sessions
    .list()
    .filter((s) => s.state === "running" && !s.agentId.startsWith("setup-"))) {
    try {
      const agent = await api(session.agentId);
      if (agent.archived || agent.paused)
        sessions.stop(session.agentId, session.token);
    } catch {
      try {
        sessions.stop(session.agentId, session.token);
      } catch {}
    }
  }
}, 10000).unref();
