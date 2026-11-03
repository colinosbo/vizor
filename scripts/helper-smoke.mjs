// Check the shipped helper outside the checkout so missing dependencies cannot
// resolve from the development node_modules directory. No model calls or keys.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const resources =
  process.argv[2] ||
  resolve(
    JSON.parse(readFileSync("artifacts/windows-result.json", "utf8"))
      .executable,
    "../resources/vizor",
  );
const folder = mkdtempSync(join(tmpdir(), "vizor-helper-check-"));
const host = join(folder, "terminal-host");
cpSync(join(resources, "terminal-host"), host, { recursive: true });
const server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ selfHost: true }));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const child = spawn(
  join(resources, "runtime/node.exe"),
  [join(host, "host.cjs")],
  {
    cwd: folder,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      SystemRoot: process.env.SystemRoot,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PATH: process.env.PATH,
      VIZOR_TOOLS_HOME: join(folder, "private-fixture"),
      VIZOR_TERMINAL_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      VIZOR_TERMINAL_TOKEN: "isolated-fixture-only",
    },
  },
);
let failure = "";
child.stderr.on("data", (data) => {
  failure = (failure + data).slice(-2000);
});
function request(action, args = {}) {
  return new Promise((done, reject) => {
    const timer = setTimeout(
      () => finish(Error("Packaged helper IPC timed out")),
      15000,
    );
    const onExit = () => finish(Error(`Packaged helper stopped: ${failure}`));
    const onMessage = (message) => {
      if (message.id === action)
        finish(message.error ? Error(message.error) : null, message.result);
    };
    function finish(error, value) {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("message", onMessage);
      error ? reject(error) : done(value);
    }
    child.once("exit", onExit);
    child.on("message", onMessage);
    child.send({ id: action, action, args });
  });
}
try {
  const tools = await request("tools");
  assert(tools.some((tool) => tool.engine === "claude-code"));
  assert.equal(
    (await request("snapshot", { agentId: "fixture-worker" })).state,
    "stopped",
  );
  console.log(
    "PASS: shipped terminal helper loads and answers IPC outside the development workspace; no inference.",
  );
} finally {
  if (child.connected) child.disconnect();
  if (child.exitCode === null)
    await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill();
        done();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  await new Promise((done) => server.close(done));
  if (dirname(resolve(folder)) !== resolve(tmpdir()))
    throw Error("Unexpected fixture path");
  rmSync(folder, { recursive: true, force: true });
}
