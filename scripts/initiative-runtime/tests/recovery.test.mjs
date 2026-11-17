import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDispatchStore } from "../scripts/relay.mjs";
import {
  openSchedulerStore,
  readTask,
  scheduleTick,
} from "../scripts/scheduler.mjs";
import { recoverBlockedTasks } from "../scripts/recovery.mjs";

test("blocked verification creates one durable repair and recheck, and unlocks only after recheck acceptance", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vizor-recovery-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, "queue.json");
  const queue = {
    paused: false,
    issues: [1, 2],
    autoRepair: { agent: "builder", checks: ["test"] },
  };
  writeFileSync(file, JSON.stringify(queue));
  const db = openDispatchStore(new DatabaseSync(":memory:"));
  openSchedulerStore(db);
  t.after(() => db.close());
  const agents = {
    verifier: {
      name: "Verifier",
      label: "Verifier",
      trustedManagers: ["lead"],
    },
    builder: { name: "Builder", label: "Builder", trustedManagers: ["lead"] },
  };
  const config = {
    repository: "owner/repo",
    dispatchLabel: "dispatch",
    agents,
  };
  const block = (task) =>
    "\x60\x60\x60vizor\n" + JSON.stringify(task) + "\n\x60\x60\x60";
  const issues = [
    {
      number: 1,
      state: "open",
      title: "Verify",
      labels: [{ name: "Verifier" }],
      body: block({
        agent: "verifier",
        priority: 1,
        gate: "review",
        checks: [],
        dependsOn: [],
      }),
    },
    {
      number: 2,
      state: "open",
      title: "Next phase",
      labels: [{ name: "Builder" }],
      body: block({
        agent: "builder",
        priority: 2,
        gate: "merge",
        checks: ["test"],
        dependsOn: [1],
      }),
    },
  ];
  let marker = "Vizor blocker: capacity";
  const comments = new Map([
    [1, [{ id: 11, user: { login: "lead" }, body: "" }]],
    [2, [{ id: 20, user: { login: "lead" }, body: "### Task for Builder" }]],
  ]);
  db.prepare(
    "INSERT INTO scheduled_issues(issue,agent,assignment,active,result) VALUES (1,'verifier','10',0,'blocked')",
  ).run();
  db.prepare("INSERT INTO deliveries VALUES (1,'run-1','started',NULL)").run();
  function github(method, path, body) {
    if (path === "user") return { login: "lead" };
    if (path === "repos/owner/repo") return { default_branch: "main" };
    const c = path.match(/issues\/(\d+)\/comments/);
    if (c) {
      const number = Number(c[1]);
      if (number === 1)
        comments.get(1)[0].body =
          "Software mismatch.\n" + marker + "\nVizor result: blocked";
      if (method === "POST")
        comments.set(number, [
          ...(comments.get(number) ?? []),
          { id: number * 10, user: { login: "lead" }, body: body.body },
        ]);
      return comments.get(number) ?? [];
    }
    if (path.startsWith("repos/owner/repo/issues?")) return issues;
    if (path === "repos/owner/repo/issues" && method === "POST") {
      const issue = {
        number: issues.length + 1,
        ...body,
        state: "open",
        labels: body.labels.map((name) => ({ name })),
      };
      issues.push(issue);
      return issue;
    }
    const id = Number(path.match(/issues\/(\d+)/)?.[1]);
    if (id) {
      if (method === "POST") throw Error("Preview tried to dispatch");
      return issues.find((issue) => issue.number === id);
    }
    throw Error("Unexpected call " + method + " " + path);
  }
  const recover = () =>
    recoverBlockedTasks({
      db,
      config,
      queue,
      file,
      github,
      parseTask: readTask,
      log() {},
    });
  recover();
  assert.equal(
    issues.length,
    2,
    "capacity pauses keep the existing assignment",
  );
  marker = "";
  recover();
  assert.equal(issues.length, 4);
  recover();
  assert.equal(issues.length, 4, "repeat recovery is idempotent");
  assert.equal(comments.get(3).length, 1);
  assert.equal(comments.get(4).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file)).issues, [1, 2, 3, 4]);
  const decision = [];
  await scheduleTick({
    db,
    config,
    queue,
    github,
    preview: true,
    log: (value) => decision.push(value),
  });
  assert.ok(decision.includes("#2 waiting for #1."));
  db.prepare(
    "INSERT INTO scheduled_issues(issue,agent,assignment,active,result,accepted) VALUES (4,'verifier','40',0,'done',1)",
  ).run();
  const complete = [];
  await scheduleTick({
    db,
    config,
    queue,
    github,
    preview: true,
    log: (value) => complete.push(value),
  });
  assert.ok(complete.includes("#2 eligible for Builder."));
});
