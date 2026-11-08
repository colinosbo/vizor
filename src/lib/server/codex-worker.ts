import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { codexUsage, type UsageWindow } from "./runner-usage";
import { AppError } from "./errors";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

function codexEnvironment() {
  const helper = join(
    process.env.VIZOR_NATIVE_HOST ?? resolve("desktop/terminal-host"),
    "claude-runtime.cjs",
  );
  const env: NodeJS.ProcessEnv = require(helper).subscriptionEnvironment();
  for (const key of Object.keys(env))
    if (/^OPENAI_|^CODEX_API_KEY$/i.test(key)) delete env[key];
  return env;
}

const binary = process.platform === "win32" ? "codex.exe" : "codex";

export async function readCodexUsage(): Promise<UsageWindow[]> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      env: codexEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (windows: UsageWindow[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
      resolve(windows);
    };
    const timer = setTimeout(finish, 5000);
    child.once("error", () => finish());
    child.once("close", () => finish());
    child.stdin.on("error", () => finish());
    const send = (request: object) =>
      child.stdin.write(JSON.stringify(request) + "\n");
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id === 1) {
          if (!message.result) return finish();
          send({ method: "initialized" });
          send({
            id: 2,
            method: "account/read",
            params: { refreshToken: false },
          });
        }
        if (message.id === 2) {
          if (message.result?.account?.type !== "chatgpt") return finish();
          send({ id: 3, method: "account/rateLimits/read" });
        }
        if (message.id === 3) finish(codexUsage(message.result));
      } catch {}
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "vizor", version: "0.1.0" } },
    });
  });
}

export async function runCodexWorker(prompt: string, schema: string) {
  const env = codexEnvironment();
  const auth = await execute(binary, ["login", "status"], {
    env,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16000,
  }).catch(() => null);
  if (!auth || !/\bLogged in using ChatGPT\b/.test(auth.stdout + auth.stderr))
    throw new AppError(
      "codex_login",
      "Sign in to Codex using your ChatGPT account.",
      409,
    );

  // The model sees only the supplied task, skills and approved file snapshots.
  const folder = await mkdtemp(join(tmpdir(), "vizor-codex-"));
  const schemaPath = join(folder, "schema.json");
  const resultPath = join(folder, "report.json");
  try {
    await writeFile(schemaPath, schema, { flag: "wx", mode: 0o600 });
    const child = execute(
      binary,
      [
        "-a",
        "never",
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--disable",
        "shell_tool",
        "-c",
        'web_search="disabled"',
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        resultPath,
        "--json",
        "-",
      ],
      {
        cwd: folder,
        env,
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 2_000_000,
      },
    );
    child.child.stdin?.on("error", () => {});
    child.child.stdin?.end(prompt);
    try {
      await child;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      if (
        /\busage_limit_reached\b|\bsubscription_sharing_usage_limit_exceeded\b|\busage limit\b/i.test(
          (failure.stdout ?? "") + " " + (failure.stderr ?? ""),
        )
      )
        throw new AppError(
          "codex_usage_limit",
          "Codex subscription usage is unavailable.",
          429,
        );
      throw new AppError(
        "codex_failed",
        "Codex could not return a worker report.",
        502,
      );
    }
    const report = await readFile(resultPath, "utf8");
    if (Buffer.byteLength(report) > 2_000_000)
      throw new AppError(
        "codex_output",
        "Codex returned too much worker output.",
        502,
      );
    return JSON.parse(report) as unknown;
  } finally {
    await Promise.all(
      [schemaPath, resultPath].map((path) => unlink(path).catch(() => {})),
    );
    await rmdir(folder).catch(() => {});
  }
}
