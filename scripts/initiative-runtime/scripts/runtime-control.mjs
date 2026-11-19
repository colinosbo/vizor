import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRuntimeSnapshot } from "./runtime-snapshot.mjs";

export function requireNode24(version = process.versions.node) {
  if (Number(version.split(".")[0]) !== 24)
    throw Error(
      "Vizor runtime requires Node.js 24. Install Node 24 and reinstall the runtime host.",
    );
}
export function runtimeHealth({ project, file, now, alive }) {
  const host = JSON.parse(
    readFileSync(resolve(project, ".vizor/runtime-host.json"), "utf8"),
  );
  const queue = resolve(project, file || host.queue);
  if (
    host.project &&
    resolve(host.project).toLowerCase() !== resolve(project).toLowerCase()
  )
    throw Error("Installed host belongs to another project.");
  const data = readRuntimeSnapshot(queue, { now, alive });
  const s = data.snapshot;
  return {
    healthy: !data.stale && !s?.errors?.length,
    ...data,
    summary: data.missing
      ? "Scheduler heartbeat missing"
      : data.stale
        ? "Scheduler stopped or heartbeat stale"
        : s.errors?.length
          ? "Scheduler alive, holding with errors"
          : "Scheduler heartbeat current",
  };
}
export function restartRuntime({
  project,
  executable,
  execute = spawnSync,
  platform = process.platform,
}) {
  if (platform !== "win32")
    throw Error("Installed runtime restart is supported on Windows only.");
  const result = execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-File",
      fileURLToPath(new URL("../windows/restart.ps1", import.meta.url)),
      "-ProjectPath",
      resolve(project),
      "-ExpectedExecutable",
      resolve(executable),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      env: windowsPowerShellEnv(),
    },
  );
  if (result.error || result.status !== 0)
    throw Error(
      "Runtime restart failed: " +
        (
          result.stdout ||
          "verify installed task paths and restart lock; check runtime health"
        ).trim(),
    );
  return result.stdout;
}

// Give CLI commands the same GitHub access the installed runner has: the GitHub
// CLI recorded at install time, and the Windows user's Git credential when gh
// itself is not signed in. The token stays in this process's environment only.
export function useRunnerGitHub({
  host,
  env = process.env,
  execute = spawnSync,
  exists = existsSync,
}) {
  if (host?.gh && exists(host.gh)) {
    const key =
      Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[key] = dirname(host.gh) + delimiter + (env[key] ?? "");
  }
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return "environment";
  const options = { encoding: "utf8", windowsHide: true, timeout: 15000, env };
  const auth = execute("gh", ["auth", "token"], options);
  if (auth.status === 0 && auth.stdout?.trim()) return "gh";
  const git = execute(
    host?.git && exists(host.git) ? host.git : "git",
    ["credential", "fill"],
    {
      ...options,
      input: "protocol=https\nhost=github.com\n\n",
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    },
  );
  const line = git.stdout
    ?.split(/\r?\n/)
    .find((l) => l.startsWith("password="));
  if (git.status === 0 && line) {
    env.GH_TOKEN = line.slice(9);
    return "git-credential";
  }
  return null;
}

// Environment for launching Windows PowerShell 5.1. When Vizor runs from
// PowerShell 7, PSModulePath points at PS7 module builds (Archive, Management)
// that 5.1 cannot load correctly; without it, 5.1 uses its own defaults.
export function windowsPowerShellEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
  );
}
