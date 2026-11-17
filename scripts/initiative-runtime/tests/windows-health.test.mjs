import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

test(
  "PowerShell 5 waits for a URL when the tunnel log is empty",
  { skip: process.platform !== "win32" },
  async () => {
    const script = fileURLToPath(
      new URL("../windows/relay-health.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const code =
      ". '" +
      script +
      "'; " +
      "if ((Get-VizorTunnelEndpoint -Text $null) -ne '') { throw 'Null log should wait' }; " +
      "if ((Get-VizorTunnelEndpoint -Text '') -ne '') { throw 'Empty log should wait' }; " +
      "if ((Get-VizorTunnelEndpoint -Text 'INF https://sample-test.trycloudflare.com ready') -ne 'https://sample-test.trycloudflare.com') { throw 'URL was not parsed' }; 'passed'";
    const result = await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", code],
      { windowsHide: true, timeout: 10000 },
    );
    assert.equal(result.stdout.trim(), "passed");
  },
);

test(
  "PowerShell 5 unwraps the relay's expected HTTP 401 and rejects an unrelated service",
  { skip: process.platform !== "win32" },
  async (t) => {
    let expected = true;
    const server = createServer((_request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: expected ? "Invalid signature." : "Wrong service.",
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const script = fileURLToPath(
      new URL("../windows/relay-health.ps1", import.meta.url),
    ).replaceAll("'", "''");
    const execute = promisify(execFile);
    const check = () =>
      execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          ". '" + script + "'; Test-VizorRelay -Port " + server.address().port,
        ],
        { windowsHide: true, timeout: 10000 },
      );
    assert.equal((await check()).stdout.trim(), "True");
    expected = false;
    assert.equal((await check()).stdout.trim(), "False");
  },
);
