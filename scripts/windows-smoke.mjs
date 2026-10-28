// Real NSIS install -> app/shortcuts -> upgrade -> uninstall. Windows only.
// Refuses an existing Vizor installation/shortcut instead of replacing a user's app.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "@playwright/test";
if (process.platform !== "win32")
  throw new Error("The installer smoke check runs only on Windows.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = JSON.parse(
  readFileSync(join(root, "artifacts/windows-result.json"), "utf8"),
);
const powershell = join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
function ps(script, extra = {}) {
  const response = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, ...extra }, encoding: "utf8", windowsHide: true },
  );
  assert.equal(response.status, 0, "Windows inspection failed");
  return response.stdout.trim();
}
const locations = JSON.parse(
  ps(
    "@{ desktop=[Environment]::GetFolderPath('DesktopDirectory'); programs=[Environment]::GetFolderPath('Programs') } | ConvertTo-Json -Compress",
  ),
);
const desktopLink = join(locations.desktop, "Vizor.lnk"),
  startLink = join(locations.programs, "Vizor.lnk");
const installed = ps(
  "@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Vizor' }).Count",
);
assert.equal(
  installed,
  "0",
  "A real Vizor installation already exists. Run this check in a clean Windows account/CI runner.",
);
assert(
  !existsSync(desktopLink) && !existsSync(startLink),
  "Existing shortcuts will not be overwritten by a test",
);
const folder = join(
  root,
  "artifacts",
  `installer check with spaces ${randomUUID()}`,
);
const installDir = join(folder, "Installed Vizor"),
  home = join(folder, "Private Vizor data");
assert(resolve(installDir).startsWith(join(root, "artifacts") + "\\"));
mkdirSync(folder, { recursive: true });
const emptyPath = join(folder, "empty-path");
mkdirSync(emptyPath);
const environment = {
  ...process.env,
  PATH: emptyPath,
  VIZOR_DESKTOP_DATA_DIR: home,
  VIZOR_DISABLE_UPDATES: "1",
};
for (const key of [
  "MASTER_KEY",
  "DATABASE_URL",
  "SELF_HOST",
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
])
  delete environment[key];
const exe = join(installDir, "Vizor.exe");
let child;
let browser;
let origin;
async function waitFor(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(message);
}
async function execute(command, args, extra = {}) {
  const processChild = spawn(command, args, {
    windowsHide: true,
    stdio: "ignore",
    ...extra,
  });
  const code = await new Promise((done, reject) => {
    processChild.once("error", reject);
    processChild.once("exit", done);
  });
  assert.equal(code, 0, "Installer/uninstaller must exit successfully");
}
async function install() {
  console.log("Windows check: installing program files and shortcuts.");
  await execute(result.installer, ["/S", `/D=${installDir}`], {
    windowsVerbatimArguments: true,
  });
  assert(existsSync(exe), "Installer must create Vizor.exe");
  for (const link of [desktopLink, startLink]) {
    assert(existsSync(link), "Installer must create both shortcuts");
    const target = ps(
      "(New-Object -ComObject WScript.Shell).CreateShortcut($env:VIZOR_LINK).TargetPath",
      { VIZOR_LINK: link },
    );
    assert.equal(target.toLowerCase(), exe.toLowerCase());
  }
}
async function debugPort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
}
async function open() {
  const port = await debugPort();
  child = spawn(exe, [`--remote-debugging-port=${port}`, "--disable-gpu"], {
    env: environment,
    windowsHide: true,
    stdio: "ignore",
  });
  await waitFor(async () => {
    if (child.exitCode !== null)
      throw new Error("Installed app stopped before its window became ready");
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, "Installed app did not open its app window");
  // Electron exposes the browser debugger before its app window/target is ready.
  await waitFor(async () => {
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    return targets.some(
      (target) =>
        target.type === "page" && target.url.startsWith("http://127.0.0.1:"),
    );
  }, "The installed app window never reached its local workspace");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser.contexts()[0].setDefaultTimeout(15000);
  let page;
  await waitFor(() => {
    page = browser
      .contexts()[0]
      ?.pages()
      .find((page) => page.url().startsWith("http://127.0.0.1:"));
    return !!page;
  }, "App did not load the local workspace");
  await page.getByLabel("Your Anthropic API key").waitFor({ timeout: 30000 });
  origin = new URL(page.url()).origin;
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => typeof window.process), "undefined");
  assert.equal(
    await page.evaluate(() => typeof window.electronAPI),
    "undefined",
  );
  assert.deepEqual(
    await page.evaluate(() => Object.keys(window.vizorDesktop).sort()),
    [
      "checkForUpdates",
      "getUpdateState",
      "onUpdateState",
      "restartToUpdate",
      "setAutomaticUpdates",
    ],
  );
  assert.equal(
    (await page.evaluate(() => window.vizorDesktop.getUpdateState())).state,
    "disabled",
  );
  const state = await (await fetch(`${origin}/api/workspace`)).json();
  assert.equal(state.autopilot, false);
  assert.equal(state.selfHost, true);
  return page;
}
async function close() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  if (browser?.isConnected()) await browser.contexts()[0].pages()[0].close();
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Closing the window did not stop Vizor")),
        12000,
      ),
    ),
  ]);
  await waitFor(async () => {
    try {
      await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return false;
    } catch {
      return true;
    }
  }, "Local server was left running after the app window closed");
  browser = undefined;
}
const configPath = join(home, "workspace/.env");
try {
  await install();
  console.log(
    "Windows check: app window, controls, isolation and single instance.",
  );
  let page = await open();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const keyField = page.getByLabel("Your Anthropic API key");
  await keyField.fill("local-display-fixture");
  await page
    .getByRole("button", { name: "Show Anthropic API key", exact: true })
    .click();
  assert.equal(
    await keyField.getAttribute("type"),
    "text",
    "The installed app must hydrate and respond to controls",
  );
  await page
    .getByRole("button", { name: "Hide Anthropic API key", exact: true })
    .click();
  assert.equal(await keyField.getAttribute("type"), "password");
  await keyField.fill("");
  await page.screenshot({
    path: join(root, "artifacts/windows-installed-onboarding.png"),
  });
  const before = readFileSync(configPath, "utf8");
  const cap = await fetch(`${origin}/api/budgets/anthropic`, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ limit: 0.5 }),
  });
  assert.equal(cap.status, 200);
  const second = spawn(exe, ["--disable-gpu"], {
    env: environment,
    windowsHide: true,
    stdio: "ignore",
  });
  await waitFor(
    () => second.exitCode !== null,
    "A second app instance should focus the first and exit",
  );
  assert.equal(second.exitCode, 0);
  assert.equal(browser.contexts()[0].pages().length, 1);
  assert.deepEqual(errors, []);
  await close();
  console.log("Windows check: reopening and crash recovery.");
  page = await open();
  assert.equal(
    readFileSync(configPath, "utf8"),
    before,
    "Reopening must preserve the master key",
  );
  assert.equal(
    (await (await fetch(`${origin}/api/workspace`)).json()).budgets.find(
      (item) => item.provider === "anthropic",
    ).limit,
    0.5,
  );
  const crashed = new Promise((done) => child.once("exit", done));
  child.kill(); // Main process only: its IPC disconnect must also stop the backend.
  await crashed;
  browser = undefined;
  await waitFor(async () => {
    try {
      await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return false;
    } catch {
      return true;
    }
  }, "An app crash left its local server running");
  await open();
  assert.equal(
    readFileSync(configPath, "utf8"),
    before,
    "Crash recovery must preserve the master key",
  );
  await close();
  console.log("Windows check: reinstalling over an existing workspace.");
  await install(); // Install the same release over itself, exercising the NSIS upgrade path.
  await open();
  assert.equal(
    readFileSync(configPath, "utf8"),
    before,
    "Installing an update must preserve data",
  );
  assert.equal(
    (await (await fetch(`${origin}/api/workspace`)).json()).budgets.find(
      (item) => item.provider === "anthropic",
    ).limit,
    0.5,
  );
  await close();
  console.log("Windows check: uninstalling while retaining private data.");
  const uninstaller = join(installDir, "Uninstall Vizor.exe");
  assert(existsSync(uninstaller) && dirname(uninstaller) === installDir);
  await execute(uninstaller, ["/S"]);
  await waitFor(
    () => !existsSync(exe),
    "Uninstaller did not remove program files",
  );
  await waitFor(
    () => !existsSync(desktopLink) && !existsSync(startLink),
    "Uninstaller must remove shortcuts",
  );
  assert.equal(
    readFileSync(configPath, "utf8"),
    before,
    "Uninstall must preserve private data",
  );
  assert(existsSync(join(home, "workspace/data/vizor.db")));
  const proof = {
    version: result.version,
    sourceCommit: result.sourceCommit,
    installerSHA256: createHash("sha256")
      .update(readFileSync(result.installer))
      .digest("hex"),
    passed: true,
    install: true,
    desktopShortcut: true,
    startMenuShortcut: true,
    noNodeOnPath: true,
    isolatedRenderer: true,
    singleInstance: true,
    reopenPersistence: true,
    upgradePersistence: true,
    closeStopsBackend: true,
    crashStopsBackend: true,
    uninstallPreservesData: true,
    providerVerification:
      "No provider requests made by the installed-app check; separately mocked by portable/application tests",
  };
  writeFileSync(
    join(root, "artifacts/windows-smoke-result.json"),
    JSON.stringify(proof, null, 2),
  );
  console.log(
    "PASS: real Windows installer, desktop/Start shortcuts, native window with no Node on PATH, renderer isolation, single instance, reopen/upgrade persistence, backend shutdown and uninstall data retention.",
  );
} finally {
  if (child && child.exitCode === null) {
    spawnSync(
      join(process.env.SystemRoot, "System32/taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
  }
}
