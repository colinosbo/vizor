import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";

test(
  "hidden runtime parent restarts a failed scheduler without another task start",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "vizor restart test "));
    const state = join(directory, ".vizor");
    const scripts = join(directory, "scripts");
    mkdirSync(state);
    mkdirSync(scripts);
    const launcher = join(directory, "run.ps1");
    copyFileSync(new URL("../windows/run.ps1", import.meta.url), launcher);
    const fakeGit = join(directory, "git-fixture.cmd");
    writeFileSync(
      fakeGit,
      "@echo off\r\necho password=fixture-only-credential\r\n",
    );
    const pidFile = join(directory, "starts.jsonl");
    writeFileSync(
      join(scripts, "vizor.mjs"),
      'import {existsSync,appendFileSync} from "node:fs";\n' +
        "const file=" +
        JSON.stringify(pidFile) +
        ";\n" +
        "const first=!existsSync(file);\n" +
        'appendFileSync(file,JSON.stringify({pid:process.pid,first})+"\\n");\n' +
        "if(first)process.exit(17);else setInterval(()=>{},1000);\n",
    );
    writeFileSync(
      join(state, "runtime-host.json"),
      JSON.stringify({
        node: process.execPath,
        git: fakeGit,
        gh: process.execPath,
        runtime: directory,
        queue: join(state, "queue.json"),
        mode: "local",
      }),
    );
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        launcher,
        "-ProjectPath",
        directory,
        "-Role",
        "Scheduler",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    t.after(() => {
      if (child.pid)
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 10000,
        });
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    let starts = [];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (existsSync(pidFile))
        starts = readFileSync(pidFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
      if (starts.length >= 2) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(
      starts.length,
      2,
      "one failed process and one automatic replacement expected",
    );
    assert.equal(starts[0].first, true);
    assert.equal(starts[1].first, false);
    assert.notEqual(starts[0].pid, starts[1].pid);
    assert.doesNotThrow(() => process.kill(starts[1].pid, 0));
  },
);
