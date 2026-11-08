import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
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

export async function runCodexWorker(prompt: string, schema: string) {
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
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
        /\busage_limit_reached\b|\busage limit\b|\brate limit(?:ed| exceeded)?\b/i.test(
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
