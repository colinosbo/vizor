import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runDoctor } from "../scripts/doctor.mjs";
import { openDispatchStore } from "../scripts/relay.mjs";

test("doctor verifies signed pings, reports a stale webhook and never prints secret values", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "vizor-doctor-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const secretFile = join(directory, "secrets.json");
  const hookFile = join(directory, "hook.json");
  const databaseFile = join(directory, "dispatch.db");
  const webhookSecret = "a".repeat(64);
  const fireUrl = "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire";
  const token = "private-worker-token";
  const endpoint = "https://example.trycloudflare.com/webhooks/github";
  const config = { repository: "owner/repo", port: 4388, dispatchLabel: "vizor:dispatch",
    agents: { worker: { label: "Worker", trustedManagers: ["lead"] } } };
  writeFileSync(secretFile, JSON.stringify({ webhookSecret, agents: { worker: { fireUrl, token } } }));
  writeFileSync(hookFile, JSON.stringify({ id: 1, endpoint }));
  openDispatchStore(new DatabaseSync(databaseFile)).close();
  let webhookUrl = endpoint;
  const github = (method, path) => {
    assert.equal(method, "GET");
    if (path === "user") return { login: "lead" };
    if (path === "repos/owner/repo") return { full_name: "owner/repo" };
    if (path.endsWith("/hooks/1")) return { active: true, events: ["issues"],
      config: { url: webhookUrl, content_type: "json", insecure_ssl: "0" } };
    return { name: decodeURIComponent(path.split("/").at(-1)) };
  };
  const requests = [];
  const request = (url, options) => {
    requests.push(url);
    assert.equal(options.headers["X-GitHub-Event"], "ping");
    assert.equal(options.headers["X-Hub-Signature-256"],
      "sha256=" + createHmac("sha256", webhookSecret).update("{}").digest("hex"));
    return Response.json({ ignored: true });
  };
  const output = [];
  const run = () => runDoctor({
    config, secretFile, hookFile, databaseFile, github, request, command: () => 0,
    report: (line) => output.push(line),
  });
  assert.equal(await run(), true);
  assert.deepEqual(requests, ["http://127.0.0.1:4388/webhooks/github", endpoint]);
  webhookUrl = "https://other.trycloudflare.com/webhooks/github";
  assert.equal(await run(), false);
  assert.ok(output.some((line) => line.startsWith("FAIL GitHub webhook") && line.includes("URL differs")));
  for (const secret of [webhookSecret, fireUrl, token]) assert.ok(!output.join("\n").includes(secret));
});
