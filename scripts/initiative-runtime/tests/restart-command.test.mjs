import assert from "node:assert/strict";
import { spawn, execFile, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test(
  "Windows serialized restart replaces one matching scheduler, coalesces concurrent callers and never kills another project",
  { skip: process.platform !== "win32", timeout: 120000 },
  async (t) => {
    // Hosted runners expose 8.3 temp paths; installed hosts store canonical long paths.
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "vizor isolated restart ")),
    );
    const other = join(root, "other project");
    mkdirSync(other);
    mkdirSync(join(root, ".vizor"));
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts/vizor.mjs"),
      queue = join(root, "queue.json"),
      otherQueue = join(other, "queue.json");
    writeFileSync(queue, "{}");
    writeFileSync(otherQueue, "{}");
    writeFileSync(
      script,
      `import {writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';const queue=process.argv[3];writeFileSync(queue+'.snapshot.json',JSON.stringify({pid:process.pid,startId:randomUUID(),startedAt:new Date().toISOString()}));setInterval(()=>{},1000);`,
    );
    const host = {
      project: root,
      queue,
      runtime: root,
      node: process.execPath,
      prefix: "Isolated fixture only",
    };
    writeFileSync(join(root, ".vizor/runtime-host.json"), JSON.stringify(host));
    const pids = new Set();
    const launch = (q) => {
      const child = spawn(process.execPath, [script, "schedule", q], {
        windowsHide: true,
        stdio: "ignore",
      });
      pids.add(child.pid);
      return child;
    };
    const initial = launch(queue),
      unrelated = launch(otherQueue);
    const snapshot = () =>
      JSON.parse(readFileSync(queue + ".snapshot.json", "utf8"));
    t.after(() => {
      try {
        pids.add(snapshot().pid);
      } catch {}
      for (const pid of pids)
        spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 30000,
        });
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const waitUntil = async (predicate) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          if (predicate()) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("Fixture process did not start");
    };
    await waitUntil(() => snapshot().pid === initial.pid);
    const restart = fileURLToPath(
      new URL("../windows/restart.ps1", import.meta.url),
    );
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const wrapper = join(root, "restart-fixture.ps1");
    // Mock Task Scheduler only: process enumeration, named mutex, exact matching,
    // termination and replacement are the real Windows operations in restart.ps1.
    writeFileSync(
      wrapper,
      `$h=Get-Content -Raw -LiteralPath ${quote(join(root, ".vizor/runtime-host.json"))}|ConvertFrom-Json
function Get-ScheduledTask { param($TaskName) [pscustomobject]@{Actions=@([pscustomobject]@{Execute=(Join-Path $env:SystemRoot 'System32\\wscript.exe'); Arguments=('//B //Nologo "'+(Join-Path $h.runtime 'windows/hidden-run.vbs')+'" "'+$h.project+'" "Scheduler"');WorkingDirectory=$h.project})} }
function Stop-ScheduledTask { param($TaskName) }
function Start-ScheduledTask { param($TaskName) Start-Process -FilePath $h.node -ArgumentList ('"'+(Join-Path $h.runtime 'scripts/vizor.mjs')+'" schedule "'+$h.queue+'"') -WindowStyle Hidden | Out-Null }
& ${quote(restart)} -ProjectPath ${quote(root)} -ExpectedExecutable ${quote(script)}
exit $LASTEXITCODE
`,
    );
    const execute = promisify(execFile);
    const run = () =>
      execute(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-File", wrapper],
        { windowsHide: true, timeout: 100000 },
      );
    const results = await Promise.all([run(), run()]);
    const final = snapshot();
    pids.add(final.pid);
    assert.notEqual(
      final.pid,
      initial.pid,
      results.map((r) => r.stdout + r.stderr).join("\n---\n"),
    );
    assert.doesNotThrow(() => process.kill(final.pid, 0));
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    const reported = results.map((r) =>
      Number(r.stdout.match(/PID (\d+)/)?.[1]),
    );
    assert.deepEqual(reported, [final.pid, final.pid]);
    assert.ok(
      results.some((r) =>
        r.stdout.includes("Concurrent restart already completed"),
      ),
    );
    // An executable mismatch refuses before process or task mutation.
    const refused = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& ${quote(restart)} -ProjectPath ${quote(root)} -ExpectedExecutable ${quote(join(root, "wrong.mjs"))}; exit 0`,
      ],
      { windowsHide: true, timeout: 30000 },
    );
    assert.match(refused.stdout, /executable mismatch/);
    assert.doesNotThrow(() => process.kill(final.pid, 0));
  },
);
