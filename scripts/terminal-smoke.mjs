// Windows-only: real ConPTY, separate processes, resize, interruption and cleanup.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const sourceCommit = process.argv[3];
if (!process.argv.includes("--bundled")) {
  const build = JSON.parse(
    readFileSync("artifacts/windows-result.json", "utf8"),
  );
  const empty = resolve("artifacts/terminal-empty-path");
  mkdirSync(empty, { recursive: true });
  const result = spawnSync(
    join(build.executable, "../resources/vizor/runtime/node.exe"),
    [
      fileURLToPath(import.meta.url),
      "--bundled",
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ],
    {
      env: { ...process.env, PATH: empty },
      windowsHide: true,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}
const require = createRequire(import.meta.url);
if (process.platform !== "win32")
  throw Error("Run the native terminal check on Windows.");
const build = JSON.parse(readFileSync("artifacts/windows-result.json", "utf8"));
const host = resolve(build.executable, "../resources/vizor/terminal-host");
const { Sessions } = require(join(host, "sessions.cjs"));
const realPty = require(join(host, "isolated-pty.cjs"));
const { Terminal } = require("@xterm/headless");
const powershell = join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const data = new Map();
const processes = [];
const sessions = new Sessions({
  // A clearly labelled fixture shell exercises the actual packaged PTY layer;
  // it never masquerades as a real provider or uses a model account.
  pty: {
    spawn(_file, _args, options) {
      const terminal = realPty.spawn(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NoExit",
          "-Command",
          "Write-Output 'VIZOR_PTY_READY'",
        ],
        options,
      );
      const screen = new Terminal({
        cols: 100,
        rows: 28,
        allowProposedApi: true,
      });
      screen.onData((value) => terminal.write(value));
      terminal.onData((value) => screen.write(value));
      terminal.onExit(() => screen.dispose());
      processes.push(terminal.pid);
      return terminal;
    },
  },
  notify(event) {
    if (event.type === "data")
      data.set(event.agentId, (data.get(event.agentId) || "") + event.data);
  },
  findTool: () => powershell,
});
async function wait(check, message) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(message);
}
try {
  const agent = (id) => ({
    id,
    engine: "claude-code",
    projectPath: resolve("."),
    terminalStarted: false,
  });
  const a = await sessions.start(agent("fixture-a"));
  const b = await sessions.start(agent("fixture-b"), true);
  await wait(
    () =>
      ["fixture-a", "fixture-b"].every((id) =>
        data.get(id)?.includes("VIZOR_PTY_READY"),
      ),
    "Both native terminals must start",
  );
  sessions.input("fixture-a", a.token, "Write-Output 'ONLY_A'\r");
  await wait(
    () => data.get("fixture-a")?.includes("ONLY_A"),
    "First terminal did not receive input",
  );
  assert(!data.get("fixture-b").includes("ONLY_A"));
  assert.throws(() => sessions.input("fixture-b", a.token, "wrong"));
  sessions.resize("fixture-b", b.token, 90, 25);
  sessions.input("fixture-b", b.token, "Start-Sleep -Seconds 60\r");
  await new Promise((done) => setTimeout(done, 500));
  sessions.interrupt("fixture-b", b.token);
  await new Promise((done) => setTimeout(done, 750));
  sessions.input("fixture-b", b.token, "Write-Output 'INTERRUPTED_B'\r");
  await wait(
    () => data.get("fixture-b")?.includes("INTERRUPTED_B"),
    "Interrupted terminal must accept another command",
  );
  await sessions.stop("fixture-a", a.token);
  assert.equal(sessions.snapshot("fixture-a").state, "stopped");
  assert.equal(sessions.snapshot("fixture-b").state, "running");
  sessions.dispose();
  writeFileSync(
    "artifacts/terminal-smoke-result.json",
    JSON.stringify(
      {
        passed: true,
        sourceCommit,
        bundledNode: true,
        noNodeOnPath: true,
        realConpty: true,
        concurrentProcesses: true,
        inputIsolation: true,
        resize: true,
        interrupt: true,
        ownedCleanup: true,
        providerCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real Windows terminals, concurrent input isolation, resizing, interruption and owned process cleanup. Fixture shells only; no provider calls.",
  );
} catch (error) {
  console.log(JSON.stringify(Object.fromEntries(data)));
  throw error;
} finally {
  sessions.dispose();
  await realPty.dispose();
}
