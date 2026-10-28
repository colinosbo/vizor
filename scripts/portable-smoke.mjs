// Exercises the extracted release, using its wrapper and runtime with no Node/npm on PATH.
// Provider fixtures and the outbound-network guard live OUTSIDE the shipped archive.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = JSON.parse(
  readFileSync(join(root, "artifacts/portable-result.json"), "utf8"),
);
const folder = join(
  root,
  "artifacts",
  `portable check with spaces ${randomUUID()}`,
);
mkdirSync(folder, { recursive: true });
const emptyPath = join(folder, "empty-path");
mkdirSync(emptyPath);
const tar =
  process.platform === "win32"
    ? join(process.env.SystemRoot, "System32/tar.exe")
    : "/usr/bin/tar";
assert.equal(
  spawnSync(tar, ["-xf", result.archive, "-C", folder], { windowsHide: true })
    .status,
  0,
);
const bundle = join(folder, basename(result.bundle));
assert(
  !existsSync(join(bundle, ".env")) && !existsSync(join(bundle, "data")),
  "Package must contain no user data or configuration",
);
assert(
  !existsSync(join(bundle, "runtime/node_modules/npm")),
  "No package manager is needed or shipped",
);
const fixture = join(root, "tests/fixtures/mock-anthropic.cjs");
const preload = join(folder, "offline-fixtures.mjs");
writeFileSync(
  preload,
  `import {createRequire} from 'node:module';
const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Unexpected external request blocked by portable test');
 return original(input, options);
};
const require = createRequire(import.meta.url);
for (const protocol of ['node:http','node:https']) {
 const mod = require(protocol);
 for (const name of ['request','get']) {
  const real = mod[name];
  mod[name] = function(input, ...args) {
   const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname || input.host || 'localhost';
   if (!['127.0.0.1','localhost','[::1]'].includes(host)) throw new Error('Unexpected external request blocked by portable test');
   return real.call(this,input,...args);
  };
 }
}
require(${JSON.stringify(fixture)});
`,
);
const port = process.env.VIZOR_PORTABLE_TEST_PORT ?? "3230";
const origin = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  PATH: emptyPath,
  APP_ORIGIN: origin,
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
};
for (const name of ["MASTER_KEY", "DATABASE_URL", "SELF_HOST"])
  delete environment[name];
let child;
let output = "";
async function start() {
  output = "";
  const command =
    process.platform === "win32"
      ? (process.env.ComSpec ??
        join(process.env.SystemRoot, "System32/cmd.exe"))
      : "/bin/sh";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", '"".\\Start Vizor.cmd" --no-open"']
      : ["./start-vizor.sh", "--no-open"];
  child = spawn(command, args, {
    cwd: bundle,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  child.on("error", (error) => {
    output += error.message;
  });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error(`Portable launcher stopped: ${output}`);
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const health = await response.json();
      if (response.ok && health.version === result.version) return;
    } catch {
      /* Local boot only. */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Portable startup timed out: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((done) => child.once("exit", done));
  if (process.platform === "win32")
    spawnSync(
      join(process.env.SystemRoot, "System32/taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await ended;
}
async function request(path, method = "GET", body) {
  const response = await fetch(`${origin}/api/${path}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  assert(response.ok, `${path} returned ${response.status}: ${text}`);
  return response.headers.get("content-type")?.includes("event-stream")
    ? text
    : JSON.parse(text);
}
try {
  await start();
  let state = await request("workspace");
  assert.equal(state.selfHost, true);
  assert.equal(state.autopilot, false);
  assert.equal(state.agents.length, 0);
  assert(state.providers.every((provider) => !provider.connected));
  const config = readFileSync(join(bundle, ".env"), "utf8");
  const page = await fetch(origin);
  const html = await page.text();
  assert.equal(page.status, 200);
  const assets = [
    ...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css)(?:\?[^\"]*)?)"/g),
  ].map((match) => match[1]);
  assert(assets.length > 0);
  for (const asset of assets)
    assert.equal(
      (await fetch(new URL(asset, origin))).status,
      200,
      `Missing local asset: ${asset}`,
    );
  await request("providers/anthropic", "POST", {
    key: "sk-ant-portable-test-fixture-1234",
  });
  const agent = await request("agents", "POST", {
    name: "Portable test assistant",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test only",
    temperature: 0.4,
    maxTokens: 256,
    color: "amber",
    icon: "spark",
  });
  const stream = await request(`agents/${agent.id}/messages`, "POST", {
    clientId: randomUUID(),
    mode: "send",
    text: "Test portable persistence",
  });
  assert(stream.includes("event: done"), "Mocked stream must finish");
  await request("budgets/anthropic", "PATCH", { limit: 1 });
  state = await request("workspace");
  const savedMessages = state.agents[0].conversation.messages;
  assert.equal(savedMessages.length, 2);
  await stop();
  await start();
  state = await request("workspace");
  assert.equal(
    readFileSync(join(bundle, ".env"), "utf8"),
    config,
    "Restart must preserve the permanent encryption key",
  );
  assert.deepEqual(state.agents[0].conversation.messages, savedMessages);
  assert.equal(
    state.budgets.find((budget) => budget.provider === "anthropic")?.limit,
    1,
  );
  assert(
    state.providers.find((provider) => provider.id === "anthropic").connected,
  );
  assert.equal(state.autopilot, false);
  await request("providers/anthropic", "DELETE");
  assert(
    !(await request("workspace")).providers.find(
      (provider) => provider.id === "anthropic",
    ).connected,
  );
  await stop();
  // Verify the shipped native Argon2 binary and session cookies in account mode.
  writeFileSync(
    join(bundle, ".env"),
    config.replace(/SELF_HOST="true"/, 'SELF_HOST="false"'),
  );
  await start();
  assert.equal((await fetch(`${origin}/api/workspace`)).status, 401);
  const credentials = {
    email: "portable@test.invalid",
    password: "Portable account test 123!",
  };
  const register = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(register.status, 200);
  const cookie = register.headers.get("set-cookie");
  assert(cookie?.includes("HttpOnly"));
  assert.equal(
    (
      await fetch(`${origin}/api/workspace`, {
        headers: { cookie: cookie.split(";")[0] },
      })
    ).status,
    200,
  );
  console.log(
    "PASS: extracted portable wrapper runs with no Node/npm on PATH; offline first boot, local assets, mocked connection/streaming, key removal, restart persistence, native account registration, autopilot off.",
  );
  writeFileSync(
    join(root, "artifacts/portable-smoke-result.json"),
    JSON.stringify(
      {
        version: result.version,
        platform: process.platform,
        arch: process.arch,
        noNodeOnPath: true,
        outboundNetworkBlocked: true,
        providerVerification: "mocked only",
        passed: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stop();
}
