// Detached supervisor: survives scheduler restarts; never retries an ambiguous start.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "summary",
    "nextStep",
    "evidence",
    "externalRequirements",
  ],
  properties: {
    action: {
      type: "string",
      enum: ["return", "repair", "external", "capacity"],
    },
    summary: { type: "string" },
    nextStep: { type: "string" },
    evidence: {
      type: "array",
      items: { type: "string", pattern: "^[1-9][0-9]*$" },
    },
    externalRequirements: { type: "array", items: { type: "string" } },
  },
};

export function atomicJson(file, data) {
  const temporary = file + ".tmp";
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  renameSync(temporary, file);
}

export function codexArguments(request, directory) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--json",
    "--skip-git-repo-check",
    "--disable",
    "shell_tool",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "memories",
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "--output-schema",
    join(directory, "schema.json"),
    "--output-last-message",
    join(directory, "decision.json"),
  ];
  if (request.session) args.push("resume", request.session, "-");
  else args.push("--sandbox", "read-only", "-");
  return args;
}

export function claudeArguments(request, session) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(request.schema ?? decisionSchema),
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--permission-mode",
    "plan",
    "--permission-prompts",
    "none",
  ];
  args.push(request.session ? "--resume" : "--session-id", session);
  return args;
}

export async function supervise(directory) {
  const request = JSON.parse(
    readFileSync(join(directory, "request.json"), "utf8"),
  );
  const statusFile = join(directory, "status.json");
  const provider = request.provider ?? "codex";
  const proposedSession = request.session ?? randomUUID();
  let session = request.session ?? null;
  let state = "starting";
  let usage = false;
  let timedOut = false;
  const status = () =>
    atomicJson(statusFile, {
      state,
      session,
      pid: process.pid,
      at: Date.now(),
      provider,
      retryAt:
        state === "usage_paused"
          ? Date.now() +
            Math.min(3600000, 300000 * 2 ** Math.min(request.attempt ?? 0, 4))
          : null,
    });
  status();
  writeFileSync(join(directory, "schema.json"), JSON.stringify(decisionSchema));
  // Do not pass GitHub tokens, API keys, or provider credentials to the model process.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOME|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(
        key,
      ),
    ),
  );
  const args =
    provider === "claude"
      ? claudeArguments(request, proposedSession)
      : codexArguments(request, directory);
  const child = spawn(request.executable, args, {
    cwd: provider === "claude" ? dirname(directory) : directory,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let tail = "";
  const consume = (chunk) => {
    tail = (tail + chunk.toString()).slice(-32768);
    if (
      /usage.limit|usage_limit|rate.limit|rate_limit|quota.exceeded|quota_exceeded|hit your (?:usage )?limit/i.test(
        tail,
      )
    )
      usage = true;
  };
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    consume(chunk);
    buffer += chunk.toString();
    const rows = buffer.split("\n");
    buffer = rows.pop();
    if (buffer.length > 1024 * 1024) buffer = "";
    for (const row of rows) {
      try {
        const event = JSON.parse(row);
        if (
          provider === "claude" &&
          event.session_id === proposedSession &&
          event.type === "system" &&
          event.subtype === "init"
        ) {
          session = proposedSession;
          state = "running";
          status();
        }
        if (
          provider === "claude" &&
          event.type === "result" &&
          event.session_id === proposedSession &&
          !event.is_error &&
          event.structured_output
        ) {
          atomicJson(join(directory, "decision.json"), event.structured_output);
        }
        if (
          event.type === "thread.started" &&
          /^[a-f0-9-]{36}$/i.test(event.thread_id)
        ) {
          session = event.thread_id;
          state = "running";
          status();
        }
      } catch {
        /* Non-JSON diagnostics are never treated as control instructions. */
      }
    }
  });
  child.stderr.on("data", consume);
  child.stdin.on("error", () => {});
  child.stdin.end(request.prompt);
  const heartbeat = setInterval(status, 5000);
  const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32" && child.pid)
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => {});
    else child.kill("SIGTERM");
  }, request.timeoutMs);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    state = timedOut
      ? "timeout"
      : usage && code !== 0
        ? "usage_paused"
        : code === 0 && existsSync(join(directory, "decision.json"))
          ? "completed"
          : "uncertain";
  } catch {
    state = "uncertain";
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    status();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await supervise(process.argv[2]);
