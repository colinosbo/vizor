import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../scripts/runtime-control.mjs";

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
        { windowsHide: true, stdio: "ignore", env: windowsPowerShellEnv() },
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
        { encoding: "utf8", env: windowsPowerShellEnv() },
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
      { encoding: "utf8", timeout: 120000, env: windowsPowerShellEnv() },
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
      { encoding: "utf8", timeout: 60000, env: windowsPowerShellEnv() },
    );
    assert.equal(start.status, 0, start.stdout + start.stderr);
    assert.ok(
      !existsSync(join(mine, ".vizor", "stopped")),
      "start clears the stop",
    );
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /disable Vizor mine Scheduler/);
    assert.match(
      calls,
      /enable Vizor mine Relay[\s\S]*enable Vizor mine Scheduler[\s\S]*enable Vizor mine Dashboard/,
    );
    assert.doesNotMatch(calls, /Vizor other/);
  },
);

test(
  "install.ps1 -NoStart registers the tasks disabled and starts none",
  { skip: process.platform !== "win32" },
  (t) => {
    const work = realpathSync.native(
      mkdtempSync(join(tmpdir(), "vizor nostart ")),
    );
    t.after(() => rmSync(work, { recursive: true, force: true }));
    mkdirSync(join(work, ".vizor"));
    writeFileSync(
      join(work, "vizor.config.json"),
      JSON.stringify({ repository: "o/r", port: 4388 }),
    );
    writeFileSync(
      join(work, ".vizor", "queue.json"),
      JSON.stringify({ paused: false, issues: [], dispatchMode: "local" }),
    );
    const log = join(work, "tasks.log");
    const registerMocks =
      mocks(log) +
      "function New-ScheduledTaskTrigger { 'trigger' }; " +
      "function New-ScheduledTaskPrincipal { 'principal' }; " +
      "function New-ScheduledTaskSettingsSet { 'settings' }; " +
      "function New-ScheduledTaskAction { 'action' }; " +
      "function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force) Add-Content -LiteralPath '" +
      log +
      "' ('register ' + $TaskName) }; ";
    const run = (extra) =>
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          registerMocks +
            ". '" +
            join(scripts, "install.ps1") +
            "' -ProjectPath '" +
            work +
            "' -QueuePath '.vizor\\queue.json' -TaskPrefix 'Vizor nostart'" +
            extra,
        ],
        { encoding: "utf8", timeout: 120000, env: windowsPowerShellEnv() },
      );
    const stopped = run(" -NoStart");
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.match(stopped.stdout, /left stopped/);
    let calls = readFileSync(log, "utf8");
    assert.match(calls, /register Vizor nostart Scheduler/);
    assert.match(calls, /disable Vizor nostart Scheduler/);
    assert.doesNotMatch(calls, /start Vizor nostart/);
    writeFileSync(log, "");
    const started = run("");
    assert.equal(started.status, 0, started.stdout + started.stderr);
    calls = readFileSync(log, "utf8");
    assert.doesNotMatch(calls, /disable Vizor nostart/);
  },
);
