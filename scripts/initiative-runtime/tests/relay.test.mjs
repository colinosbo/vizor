import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createListener, openDispatchStore } from "../scripts/relay.mjs";

test("routes only authorized ready issues and reserves each dispatch once", async (context) => {
  const database = openDispatchStore(new DatabaseSync(":memory:"));
  database.prepare("INSERT INTO assignments VALUES (?, ?, ?)").run(10, "research", "https://github.com/example/channel/issues/10#issuecomment-22");
  database.prepare("INSERT INTO assignments VALUES (?, ?, ?)").run(11, "builder", "https://github.com/example/channel/issues/11#issuecomment-23");
  const config = { repository: "example/channel", dispatchLabel: "vizor:dispatch", agents: {
    research: { label: "team:research", trustedManagers: ["lead"] },
    builder: { label: "agent:builder", trustedManagers: ["lead"] },
  } };
  const credentials = { webhookSecret: "test-secret", agents: {
    research: { fireUrl: "https://example.invalid/research", token: "test-research" },
    builder: { fireUrl: "https://example.invalid/builder", token: "test-builder" },
  } };
  const fires = [];
  const researchResponse = Promise.withResolvers();
  const server = createListener({ config, credentials, database, fire: async (url, options) => {
    fires.push({ url, options });
    return url.endsWith("builder")
      ? new Response("", { status: 503 })
      : researchResponse.promise;
  } }).listen(0, "127.0.0.1");
  context.after(() => {
    server.close();
    database.close();
  });
  await once(server, "listening");
  const endpoint = "http://127.0.0.1:" + server.address().port + "/webhooks/github";
  const deliver = ({ number = 10, added = "vizor:dispatch", names = ["team:research"],
    login = "lead", signingKey = credentials.webhookSecret, repo = "example/channel", delivery = randomUUID() } = {}) => {
    const body = JSON.stringify({ action: "labeled", label: { name: added },
      repository: { full_name: repo }, sender: { login }, issue: { number, state: "open", labels: names.map(name => ({ name })) } });
    return fetch(endpoint, { method: "POST", body, headers: {
      "X-GitHub-Event": "issues", "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": "sha256=" + createHmac("sha256", signingKey).update(body).digest("hex"),
    } });
  };
  assert.equal((await deliver({ signingKey: "invalid" })).status, 401);
  for (const options of [
    { added: "team:research" }, { names: [] }, { number: 12 },
    { login: "someone" }, { repo: "example/other" }, { names: ["team:research", "agent:builder"] },
  ]) assert.deepEqual(await (await deliver(options)).json(), { ignored: true });
  assert.equal(fires.length, 0);
  const delivery = randomUUID();
  const responses = await Promise.all([deliver({ delivery }), deliver({ delivery })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 202]);
  assert.deepEqual(await responses.find(response => response.status === 202).json(), { accepted: true });
  assert.deepEqual(await (await deliver()).json(), { duplicate: true });
  assert.equal(fires.length, 1);
  assert.equal(fires[0].url, credentials.agents.research.fireUrl);
  assert.equal(fires[0].options.headers.Authorization, "Bearer test-research");
  assert.match(JSON.parse(fires[0].options.body).text, /issuecomment-22/);
  const receipt = database.prepare("SELECT state, session FROM deliveries WHERE issue = ?");
  assert.equal(receipt.get(10).state, "unconfirmed");
  researchResponse.resolve(Response.json({
    claude_code_session_id: "cse_test",
    claude_code_session_url: "https://claude.ai/code/cse_test",
  }));
  for (let attempt = 0; attempt < 50 && !receipt.get(10).session; attempt++) await delay(10);
  assert.equal(receipt.get(10).session, "https://claude.ai/code/cse_test");
  const builder = { number: 11, names: ["agent:builder"] };
  assert.equal((await deliver(builder)).status, 202);
  assert.deepEqual(await (await deliver(builder)).json(), { duplicate: true });
  assert.equal(fires.length, 2);
  assert.equal(fires[1].url, credentials.agents.builder.fireUrl);
  assert.equal(database.prepare("SELECT state FROM deliveries WHERE issue = 11").get().state, "unconfirmed");
});
