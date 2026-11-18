import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    { encoding: "utf8", windowsHide: true, timeout: 120000 },
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
