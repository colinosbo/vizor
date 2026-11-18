import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../windows/", import.meta.url));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Task Scheduler cmdlets are mocked; process matching and termination are real.
const mocks = (log) =>
  "function Get-ScheduledTask { param($TaskName, $ErrorAction) [pscustomobject]@{ TaskName = $TaskName; State = 'Running' } }; " +
  "function Stop-ScheduledTask { param($TaskName) Add-Content -LiteralPath '" +
  log +
  "' ('stop ' + $TaskName) }; " +
  "function Disable-ScheduledTask { param($TaskName) Add-Content -LiteralPath '" +
  log +
  "' ('disable ' + $TaskName) }; " +
  "function Enable-ScheduledTask { param($TaskName) Add-Content -LiteralPath '" +
  log +
  "' ('enable ' + $TaskName) }; " +
  "function Start-ScheduledTask { param($TaskName) Add-Content -LiteralPath '" +
  log +
  "' ('start ' + $TaskName) }; ";

test(
  "stop.ps1 stops only this project's supervisors and runtime processes; start.ps1 re-enables its tasks",
  { skip: process.platform !== "win32" },
  async (t) => {
    // Long-form path, as install.ps1 records it (temp can be an 8.3 short name).
    const work = realpathSync.native(
      mkdtempSync(join(tmpdir(), "vizor stop test ")),
    );
    const spawned = [];
    t.after(() => {
      for (const child of spawned)
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      rmSync(work, { recursive: true, force: true });
    });
    // A stand-in runtime whose run.ps1 starts a long-lived node child, like the real one.
    const runtime = join(work, "old runtime");
    mkdirSync(join(runtime, "windows"), { recursive: true });
    writeFileSync(
      join(runtime, "windows", "run.ps1"),
      "param($ProjectPath, $Role)\r\n& '" +
        process.execPath +
        '\' -e "setInterval(()=>{},1000)"\r\n',
    );
    const project = (name) => {
      const dir = join(work, name);
      mkdirSync(join(dir, ".vizor"), { recursive: true });
      writeFileSync(
        join(dir, ".vizor", "runtime-host.json"),
        JSON.stringify({
          project: dir,
          queue: join(dir, ".vizor", "queue.json"),
          prefix: "Vizor " + name,
          mode: "local",
          runtime,
        }),
      );
      return dir;
    };
    const mine = project("mine");
    const other = project("other");
    const supervise = (dir) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(runtime, "windows", "run.ps1"),
          "-ProjectPath",
          dir,
          "-Role",
          "Scheduler",
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      spawned.push(child);
      return child;
    };
    const minePs = supervise(mine);
    const otherPs = supervise(other);
    const childrenOf = (pid) =>
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=" +
            pid +
            "' | Where-Object Name -eq 'node.exe').ProcessId",
        ],
        { encoding: "utf8" },
      )
        .stdout.trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    let mineNode = [];
    let otherNode = [];
    for (let i = 0; i < 60 && (!mineNode.length || !otherNode.length); i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      mineNode = childrenOf(minePs.pid);
      otherNode = childrenOf(otherPs.pid);
    }
    assert.ok(
      mineNode.length && otherNode.length,
      "fixture supervisors started node children",
    );

    const log = join(work, "tasks.log");
    const stop = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        mocks(log) +
          ". '" +
          join(scripts, "stop.ps1") +
          "' -ProjectPath '" +
          mine +
          "' -Disable",
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    assert.equal(stop.status, 0, stop.stdout + stop.stderr);
    assert.match(
      stop.stdout,
      /Stopped 1 supervisor\(s\) and 1 runtime process\(es\); tasks disabled/,
    );
    assert.ok(
      !alive(minePs.pid) && !alive(mineNode[0]),
      "this project's processes stopped",
    );
    assert.ok(
      alive(otherPs.pid) && alive(otherNode[0]),
      "another project's runner is untouched",
    );
    const start = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        mocks(log) +
          ". '" +
          join(scripts, "start.ps1") +
          "' -ProjectPath '" +
          mine +
          "'",
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(start.status, 0, start.stdout + start.stderr);
    const calls = (await import("node:fs")).readFileSync(log, "utf8");
    assert.match(calls, /disable Vizor mine Scheduler/);
    assert.match(
      calls,
      /enable Vizor mine Relay[\s\S]*enable Vizor mine Scheduler[\s\S]*enable Vizor mine Dashboard/,
    );
    assert.doesNotMatch(calls, /Vizor other/);
  },
);
