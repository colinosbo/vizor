import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { windowsOps } from "../scripts/installer.mjs";

function project(t, { stopped }) {
  const dir = mkdtempSync(join(tmpdir(), "vizor-upgrade-stopped-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".vizor"));
  writeFileSync(
    join(dir, ".vizor", "runtime-host.json"),
    JSON.stringify({
      project: dir,
      queue: join(dir, ".vizor", "queue.json"),
      mode: "local",
      prefix: "Vizor test",
    }),
  );
  if (stopped) writeFileSync(join(dir, ".vizor", "stopped"), "x");
  return dir;
}

test("upgrade keeps a project stopped by vizor stop stopped", (t) => {
  const dir = project(t, { stopped: true });
  const calls = [];
  const ops = windowsOps({
    execute: (_exe, args) => {
      calls.push(args.slice(args.indexOf("-File") + 1));
      return { status: 0, stdout: "" };
    },
    wait: () => assert.fail("a stopped project must not wait for a runner"),
    timeoutMs: 1,
  });
  assert.equal(ops.switchProject(dir, "/v2"), "stopped");
  assert.match(calls[0][0], /stop\.ps1$/);
  assert.ok(
    !calls[0].includes("-Disable"),
    "upgrade stop does not change the user's choice",
  );
  assert.match(calls[1][0], /install\.ps1$/);
  assert.ok(calls[1].includes("-NoStart"));
});

test("upgrade starts a running project and waits for its heartbeat", (t) => {
  const dir = project(t, { stopped: false });
  const calls = [];
  const ops = windowsOps({
    execute: (_exe, args) => {
      calls.push(args.slice(args.indexOf("-File") + 1));
      return { status: 0, stdout: "" };
    },
    wait: () => {},
    timeoutMs: 1,
  });
  assert.throws(
    () => ops.switchProject(dir, "/v2"),
    /did not publish a heartbeat/,
  );
  assert.ok(!calls[1].includes("-NoStart"));
});

test("vizor restart explains when the project runs another installed version", (t) => {
  const dir = project(t, { stopped: false });
  writeFileSync(
    join(dir, "vizor.config.json"),
    JSON.stringify({
      repository: "o/r",
      port: 4388,
      dispatchLabel: "d",
      agents: { w: { name: "W", label: "w", trustedManagers: ["lead"] } },
    }),
  );
  writeFileSync(
    join(dir, ".vizor", "runtime-host.json"),
    JSON.stringify({
      project: dir,
      queue: join(dir, ".vizor", "queue.json"),
      runtime: join(dir, "other-version"),
    }),
  );
  const cli = fileURLToPath(new URL("../scripts/vizor.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "restart"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /runs Vizor from .*other-version, not this version/,
  );
  assert.match(result.stderr, /Run vizor start to move it/);
});
