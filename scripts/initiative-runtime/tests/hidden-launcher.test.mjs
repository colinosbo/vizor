import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test(
  "Windows non-console launcher keeps PowerShell invisible, quotes project paths and propagates exits",
  { skip: process.platform !== "win32" },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "vizor hidden launcher "));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const launcher = join(directory, "hidden-run.vbs");
    copyFileSync(
      new URL("../windows/hidden-run.vbs", import.meta.url),
      launcher,
    );
    writeFileSync(
      join(directory, "run.ps1"),
      `param([string]$ProjectPath,[string]$Role)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Visibility { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'
$visible = [Visibility]::IsWindowVisible([Visibility]::GetConsoleWindow())
@{project=$ProjectPath;role=$Role;visible=$visible} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json')
exit 7
`,
    );
    const executable = join(process.env.SystemRoot, "System32", "wscript.exe");
    const result = spawnSync(
      executable,
      ["//B", "//Nologo", launcher, directory, "Scheduler"],
      { windowsHide: true, timeout: 30000 },
    );
    assert.equal(result.status, 7, String(result.error ?? ""));
    const evidence = JSON.parse(
      readFileSync(join(directory, "result.json"), "utf8").replace(
        /^\uFEFF/,
        "",
      ),
    );
    assert.equal(evidence.project, directory);
    assert.equal(evidence.role, "Scheduler");
    assert.equal(evidence.visible, false);
    const invalid = spawnSync(
      executable,
      ["//B", "//Nologo", launcher, directory, "Unknown"],
      { windowsHide: true, timeout: 30000 },
    );
    assert.equal(invalid.status, 2);
  },
);
