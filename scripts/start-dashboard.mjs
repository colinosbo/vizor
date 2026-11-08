import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(root, "data");
mkdirSync(data, { recursive: true });
const configFile = resolve(data, "dashboard-host.env");
const env = {
  ...(existsSync(resolve(root, ".env"))
    ? parse(readFileSync(resolve(root, ".env")))
    : {}),
  ...(existsSync(configFile) ? parse(readFileSync(configFile)) : {}),
  ...process.env,
};
const token = () => randomBytes(32).toString("hex");
const settings = {
  VIZOR_SHARED_OWNER_KEY: env.VIZOR_SHARED_OWNER_KEY || token(),
  VIZOR_SHARED_WORKER_KEY: env.VIZOR_SHARED_WORKER_KEY || token(),
  VIZOR_DASHBOARD_PASSWORD: env.VIZOR_DASHBOARD_PASSWORD || token(),
  VIZOR_DASHBOARD_ORIGIN: env.VIZOR_DASHBOARD_ORIGIN || "http://127.0.0.1:4387",
  VIZOR_SHARED_PORT: env.VIZOR_SHARED_PORT || "4387",
  VIZOR_SHARED_DB: env.VIZOR_SHARED_DB || resolve(data, "vizor-shared.db"),
};
if (!existsSync(configFile)) {
  writeFileSync(
    configFile,
    Object.entries(settings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
const accessFile = resolve(data, "dashboard-login.txt");
writeFileSync(
  accessFile,
  `Dashboard: ${settings.VIZOR_DASHBOARD_ORIGIN}/\nUsername: owner\nPassword: ${settings.VIZOR_DASHBOARD_PASSWORD}\n\nKeep this file private.\n`,
  { mode: 0o600 },
);
const url = `http://127.0.0.1:${settings.VIZOR_SHARED_PORT}/`;
const headers = {
  Authorization:
    "Basic " +
    Buffer.from("owner:" + settings.VIZOR_DASHBOARD_PASSWORD).toString(
      "base64",
    ),
};
async function available() {
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(1500) }))
      .ok;
  } catch {
    return false;
  }
}
if (!(await available())) {
  const log = openSync(resolve(data, "dashboard-host.log"), "a");
  const child = spawn(
    process.execPath,
    [resolve(root, "scripts/shared-relay.mjs")],
    {
      cwd: root,
      env: { ...env, ...settings },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  child.on("error", () => {
    console.error("Dashboard startup failed. Check data/dashboard-host.log.");
    process.exitCode = 1;
  });
  child.unref();
  for (let attempt = 0; attempt < 30 && !(await available()); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 300));
  if (!(await available()))
    throw Error(
      "Dashboard did not become available. Check data/dashboard-host.log.",
    );
}
console.log(`Dashboard ready: ${url}\nLogin details: ${accessFile}`);
