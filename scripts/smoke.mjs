// End-to-end first launch for a clean download/CI checkout. No provider calls.
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env")) || existsSync(join(root, "data/vizor.db")))
  throw new Error(
    "Run the download smoke check only in a fresh checkout/extracted download, never your personal workspace.",
  );
const port = process.env.VIZOR_SMOKE_PORT ?? "3200";
const origin = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  APP_ORIGIN: origin,
  NEXT_TELEMETRY_DISABLED: "1",
  CHECKPOINT_DISABLE: "1",
};
for (const name of ["MASTER_KEY", "DATABASE_URL", "SELF_HOST"])
  delete environment[name];
const child = spawn(
  process.execPath,
  [join(root, "scripts/launch.mjs"), "--no-open"],
  {
    cwd: root,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  },
);
let childFailure;
child.on("error", () => {
  childFailure = new Error("The launcher could not start.");
});
child.on("exit", (code) => {
  childFailure ??= new Error(`The launcher stopped early (${code}).`);
});
async function stop() {
  if (child.exitCode !== null) return;
  const ended = new Promise((resolveExit) => child.once("exit", resolveExit));
  if (process.platform === "win32")
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await ended;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 480; attempt++) {
    if (childFailure) throw childFailure;
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const value = await response.json();
      if (response.ok && value.app === "vizor" && value.version === "0.5.0") {
        ready = true;
        break;
      }
    } catch {
      /* First install/build in progress. */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  assert(ready, "Fresh download did not become ready within eight minutes.");
  const response = await fetch(`${origin}/api/workspace`);
  assert.equal(response.status, 200);
  const workspace = await response.json();
  assert.equal(workspace.selfHost, true);
  assert.equal(workspace.autopilot, false);
  assert.equal(workspace.agents.length, 0);
  assert.equal(workspace.orchestrator, null);
  assert(
    workspace.providers.every(
      (provider) => !provider.connected && provider.last4 === null,
    ),
  );
  assert(
    workspace.budgets.every(
      (budget) => budget.limit === null && budget.spent === 0,
    ),
  );
  assert((await (await fetch(origin)).text()).includes("Vizor"));
  const keyBefore = readFileSync(join(root, ".env"), "utf8");
  await stop();
  const setup = spawnSync(process.execPath, [join(root, "scripts/setup.mjs")], {
    cwd: root,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
    timeout: 120000,
  });
  assert.equal(setup.status, 0);
  assert.equal(readFileSync(join(root, ".env"), "utf8"), keyBefore);
  console.log(
    "DOWNLOAD SMOKE PASSED: fresh install, production startup, empty private workspace, no keys, autopilot off, and repeat setup preserves the encryption key.",
  );
} finally {
  await stop();
  // An interrupted Windows launcher leaves a stale lock; next launch safely reclaims it.
}
