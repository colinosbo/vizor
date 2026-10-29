// Two private, clearly labelled fixture apps exercise the real electron-updater/NSIS path.
// Their localhost feed and ephemeral key are compiled only into these test apps.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { generateKeyPairSync, createHash, sign, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import Database from "better-sqlite3";
if (process.platform !== "win32")
  throw new Error("The real updater smoke check runs only on Windows.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const psExe = join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
function ps(command, env = {}) {
  const r = spawnSync(
    psExe,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true },
  );
  assert.equal(r.status, 0);
  return r.stdout.trim();
}
assert.equal(
  ps(
    "@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Vizor Update Test' }).Count",
  ),
  "0",
  "A previous update-test installation exists; leave it untouched until inspected.",
);
const folder = join(root, "artifacts", `real updater check ${randomUUID()}`);
const project = join(folder, "project"),
  installDir = join(folder, "Installed Update Test"),
  home = join(folder, "Private update test data");
assert(installDir.startsWith(join(root, "artifacts") + "\\"));
mkdirSync(project, { recursive: true });
const portable = JSON.parse(
  readFileSync(join(root, "artifacts/portable-result.json"), "utf8"),
);
const files = new Map();
const rolloutHeaders = [];
const server = createServer((request, response) => {
  if (request.headers["x-user-staging-id"])
    rolloutHeaders.push(request.headers["x-user-staging-id"]);
  const pathname = new URL(request.url, "http://localhost").pathname;
  const file = files.get(pathname);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  const bytes = typeof file === "string" ? readFileSync(file) : file;
  response.setHeader(
    "Content-Type",
    pathname.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
  );
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
  if (range) {
    const start = Number(range[1]),
      end = range[2]
        ? Math.min(Number(range[2]), bytes.length - 1)
        : bytes.length - 1;
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      "Content-Length": end - start + 1,
    });
    response.end(bytes.subarray(start, end + 1));
  } else {
    response.setHeader("Content-Length", bytes.length);
    response.end(bytes);
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const feed = `http://127.0.0.1:${server.address().port}/`;
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64");
const desktop = JSON.parse(
  readFileSync(join(root, "desktop/package.json"), "utf8"),
);
for (const file of [
  "main.cjs",
  "policy.cjs",
  "terminals.cjs",
  "preload.cjs",
  "updater.cjs",
  "update-policy.cjs",
  "update-key.cjs",
  "icon.png",
])
  cpSync(join(root, "desktop", file), join(project, file));
symlinkSync(
  join(root, "desktop/node_modules"),
  join(project, "node_modules"),
  "junction",
);
writeFileSync(
  join(project, "update-source.cjs"),
  `// Private updater fixture only. Never distributed as Vizor.\nmodule.exports={publicKey:${JSON.stringify(publicKey)},feed:{provider:'generic',url:${JSON.stringify(feed)}},initialDelay:2500,async readAsset(version,name){const r=await fetch(${JSON.stringify(feed)}+'v'+version+'/'+name);if(!r.ok)throw Error('Fixture unavailable');return Buffer.from(await r.arrayBuffer());}};\n`,
);
process.env.VIZOR_INSTALLER_BUNDLE = portable.bundle;
const originalConfig = requireDesktop("./builder.cjs");
async function build(version, out) {
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      {
        name: "vizor-update-test",
        productName: "Vizor Update Test",
        description: "Private automated update fixture",
        version,
        main: "main.cjs",
        author: "colinosbo",
        private: true,
        dependencies: desktop.dependencies,
      },
      null,
      2,
    ),
  );
  const config = {
    ...originalConfig,
    appId: "com.colinosbo.vizor.update-test",
    productName: "Vizor Update Test",
    electronVersion: desktop.devDependencies.electron,
    directories: { output: out },
    publish: { provider: "generic", url: feed },
    nsis: {
      ...originalConfig.nsis,
      shortcutName: "Vizor Update Test",
      uninstallDisplayName: "Vizor Update Test",
      license: join(root, "LICENSE"),
    },
  };
  writeFileSync(
    join(project, "builder.cjs"),
    "module.exports=" + JSON.stringify(config, null, 2),
  );
  console.log(`Update check: building private fixture ${version}.`);
  const child = spawn(
    process.execPath,
    [
      join(root, "desktop/node_modules/electron-builder/out/cli/cli.js"),
      "--win",
      "nsis",
      "--x64",
      "--config",
      "builder.cjs",
      "--publish",
      "never",
    ],
    {
      cwd: project,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      windowsHide: true,
      stdio: "inherit",
    },
  );
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  assert.equal(code, 0);
  return join(out, `Vizor-Setup-${version}-x64.exe`);
}
let child, browser, origin;
const exe = join(installDir, "Vizor Update Test.exe");
async function waitFor(check, message, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(message);
}
async function execute(command, args, options = {}) {
  const p = spawn(command, args, {
    windowsHide: true,
    stdio: "ignore",
    ...options,
  });
  const code = await new Promise((done, reject) => {
    p.once("error", reject);
    p.once("exit", done);
  });
  assert.equal(code, 0);
}
async function open(version) {
  // A separate HTTP server reserves a temporary debug-port number without a fixed global port.
  const reserve = createServer();
  await new Promise((done) => reserve.listen(0, "127.0.0.1", done));
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  const env = { ...process.env, VIZOR_DESKTOP_DATA_DIR: home };
  for (const name of [
    "VIZOR_DISABLE_UPDATES",
    "NODE_OPTIONS",
    "MASTER_KEY",
    "DATABASE_URL",
    "SELF_HOST",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[name];
  child = spawn(exe, [`--remote-debugging-port=${port}`, "--disable-gpu"], {
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  await waitFor(async () => {
    if (child.exitCode !== null)
      throw Error("Update fixture exited before startup");
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      return targets.some((target) =>
        target.url.startsWith("http://127.0.0.1:"),
      );
    } catch {
      return false;
    }
  }, "Fixture window did not load");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser.contexts()[0].setDefaultTimeout(20000);
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().startsWith("http://127.0.0.1:"));
  await page.getByRole("button", { name: "API keys", exact: true }).click();
  await page.getByLabel("Your Anthropic API key").waitFor();
  origin = new URL(page.url()).origin;
  assert.equal(
    (await page.evaluate(() => window.vizorDesktop.getUpdateState()))
      .currentVersion,
    version,
  );
  return page;
}
try {
  const futureOut = join(folder, "future"),
    baseOut = join(folder, "baseline");
  const future = await build("0.8.1", futureOut);
  const bytes = readFileSync(future);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      version: "0.8.1",
      platform: "win32",
      arch: "x64",
      file: "Vizor-Setup-0.8.1-x64.exe",
      size: bytes.length,
      sha512,
    }) + "\n",
  );
  files.set("/latest.yml", join(futureOut, "latest.yml"));
  files.set("/Vizor-Setup-0.8.1-x64.exe", future);
  files.set("/Vizor-Setup-0.8.1-x64.exe.blockmap", `${future}.blockmap`);
  files.set("/v0.8.1/vizor-update.json", manifest);
  files.set(
    "/v0.8.1/vizor-update.sig",
    Buffer.from(sign(null, manifest, keys.privateKey).toString("base64")),
  );
  const baseline = await build("0.8.0", baseOut);
  await execute(baseline, ["/S", `/D=${installDir}`], {
    windowsVerbatimArguments: true,
  });
  let page = await open("0.8.0");
  const config = readFileSync(join(home, "workspace/.env"), "utf8");
  const cap = await fetch(`${origin}/api/budgets/anthropic`, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ limit: 0.5 }),
  });
  assert.equal(cap.status, 200);
  console.log("Update check: waiting for authenticated background download.");
  await waitFor(
    async () =>
      (await page.evaluate(() => window.vizorDesktop.getUpdateState()))
        .state === "ready",
    "The real updater did not authenticate and download the newer installer",
    120000,
  );
  assert.equal(
    (await page.evaluate(() => window.vizorDesktop.getUpdateState())).version,
    "0.8.1",
  );
  // A real SQLite run row verifies the launcher's private activity IPC, without provider calls.
  const db = new Database(join(home, "workspace/data/vizor.db"));
  const owner = db.prepare("SELECT id FROM User LIMIT 1").get().id;
  db.prepare(
    "INSERT INTO Agent(id,userId,name,model,systemPrompt) VALUES(?,?,?,?,?)",
  ).run(
    "update-fixture-agent",
    owner,
    "Update fixture",
    "claude-sonnet-4-6",
    "Test only",
  );
  db.prepare(
    "INSERT INTO Conversation(id,agentId) VALUES('update-fixture-conversation','update-fixture-agent')",
  ).run();
  db.prepare(
    "INSERT INTO Message(id,conversationId,position,role,text) VALUES('update-fixture-message','update-fixture-conversation',0,'assistant','Private fixture')",
  ).run();
  db.prepare(
    "INSERT INTO Run(id,userId,conversationId,clientId,assistantId,model,status) VALUES(?,?,'update-fixture-conversation','update-fixture-client','update-fixture-message','claude-sonnet-4-6','running')",
  ).run("update-fixture-run", owner);
  assert.deepEqual(
    await page.evaluate(() => window.vizorDesktop.restartToUpdate()),
    { ok: false, reason: "busy" },
  );
  assert.equal(child.exitCode, null);
  db.prepare("DELETE FROM Run WHERE id='update-fixture-run'").run();
  db.prepare("DELETE FROM Message WHERE id='update-fixture-message'").run();
  db.prepare(
    "DELETE FROM Conversation WHERE id='update-fixture-conversation'",
  ).run();
  db.prepare("DELETE FROM Agent WHERE id='update-fixture-agent'").run();
  db.close();
  console.log("Update check: normal app close must install the staged update.");
  const exited = new Promise((done) => child.once("exit", done));
  await page.close();
  await exited;
  browser = undefined;
  await waitFor(
    () => {
      try {
        const version = ps(
          "(Get-Item -LiteralPath $env:VIZOR_TEST_EXE).VersionInfo.ProductVersion",
          { VIZOR_TEST_EXE: exe },
        );
        if (!version.startsWith("0.8.1")) return false;
        const metadata = JSON.parse(
          requireDesktop("@electron/asar")
            .extractFile(join(installDir, "resources/app.asar"), "package.json")
            .toString(),
        );
        if (metadata.version !== "0.8.1") return false;
        const installing = ps(
          "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($env:LOCALAPPDATA + '\\vizor-update-test-updater\\*') }).Count",
        );
        return installing === "0";
      } catch {
        return false;
      }
    },
    "Closing the app did not install the downloaded update",
    180000,
  );
  page = await open("0.8.1");
  assert.equal(readFileSync(join(home, "workspace/.env"), "utf8"), config);
  assert.equal(
    (await (await fetch(`${origin}/api/workspace`)).json()).budgets.find(
      (item) => item.provider === "anthropic",
    ).limit,
    0.5,
  );
  assert.equal(
    (await page.evaluate(() => window.vizorDesktop.getUpdateState()))
      .currentVersion,
    "0.8.1",
  );
  assert(
    rolloutHeaders.length > 0 &&
      rolloutHeaders.every((value) => value === "vizor"),
    "Updates must not transmit a per-install tracking identifier",
  );
  const ended = new Promise((done) => child.once("exit", done));
  await page.close();
  await ended;
  await execute(join(installDir, "Uninstall Vizor Update Test.exe"), ["/S"]);
  await waitFor(
    () => !existsSync(exe),
    "The update-test program was not uninstalled",
  );
  writeFileSync(
    join(root, "artifacts/real-update-smoke-result.json"),
    JSON.stringify(
      {
        passed: true,
        productionVersion: desktop.version,
        sourceCommit: JSON.parse(
          readFileSync(join(root, "artifacts/windows-result.json"), "utf8"),
        ).sourceCommit,
        fixtureVersions: ["0.8.0", "0.8.1"],
        signedManifest: true,
        realDownload: true,
        activeGenerationDeferred: true,
        installOnNormalQuit: true,
        relaunchNewVersion: true,
        dataPreserved: true,
        providerCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: authenticated real download, active-generation restart deferral, automatic installation on app close, newer app relaunch and preserved workspace. Fixtures only; no provider calls.",
  );
} finally {
  if (child && child.exitCode === null)
    spawnSync(
      join(process.env.SystemRoot, "System32/taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
  await new Promise((done) => server.close(done));
}
