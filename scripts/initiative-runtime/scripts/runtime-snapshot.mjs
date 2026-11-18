import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const snapshotPath = (file) => resolve(file) + ".snapshot.json";
export function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, file);
}
export function readRuntimeSnapshot(
  file,
  {
    now = Date.now(),
    maxAge = 150000,
    alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  } = {},
) {
  try {
    const snapshot = JSON.parse(readFileSync(snapshotPath(file), "utf8"));
    if (
      snapshot.schema !== "vizor.scheduler/1" ||
      typeof snapshot.startId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(snapshot.startId) ||
      snapshot.queue !== resolve(file)
    )
      throw Error("Wrong scheduler snapshot");
    const ageMs = now - Date.parse(snapshot.updatedAt);
    const stale = !Number.isFinite(ageMs) || ageMs < -5000 || ageMs > maxAge;
    const processAlive =
      Number.isSafeInteger(snapshot.pid) && alive(snapshot.pid);
    return {
      snapshot,
      stale: stale || !processAlive,
      ageMs,
      processAlive,
      missing: false,
    };
  } catch {
    return {
      snapshot: null,
      stale: true,
      missing: true,
      processAlive: false,
      ageMs: null,
    };
  }
}

export function validArtifactEvidence(body = "") {
  // An immutable repository blob/commit or explicit validator receipt is required.
  // A mutable branch link or bare done marker is insufficient.
  return (
    /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|commit)\/[a-f0-9]{40}(?:[\/#\s)]|$)/i.test(
      body,
    ) ||
    /^Vizor evidence: validated schema=vizor\.artifact\/1 sha256=[a-f0-9]{64} reference=https:\/\/[^\s]+$/m.test(
      body,
    )
  );
}

export function logLine(value) {
  return `${new Date().toISOString()} ${String(value).replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)/gi, "[redacted]")}`;
}
