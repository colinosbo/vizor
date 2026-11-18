import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSchedulerStore } from "../scripts/scheduler.mjs";
import {
  planAssignmentAllowed,
  publishApprovedPhases,
} from "../scripts/phase-publisher.mjs";

const config = {
  repository: "owner/repo",
  agents: {
    riley: { name: "Dev: Riley", label: "Riley", trustedManagers: ["owner"] },
    morgan: {
      name: "Dev: Morgan",
      label: "Morgan",
      trustedManagers: ["owner"],
    },
  },
};
const task = (key, agent, gate, dependsOn = [], paths = []) => ({
  key,
  agent,
  title: "Task " + key,
  body: "Approved body for " + key + ".",
  assignment: "Do " + key + ".",
  gate,
  checks: gate === "merge" ? ["vision-python"] : [],
  dependsOn,
  paths: gate === "merge" ? ["vision/probe/**"] : paths,
  priority: 10,
});
const plan = {
  schema: "vizor.plan/1",
  repository: "owner/repo",
  id: "synthetic-chain",
  phases: [
    {
      id: "one",
      tasks: [
        task("check", "riley", "review"),
        task("fix", "morgan", "merge", ["check"]),
      ],
    },
    { id: "two", tasks: [task("after", "riley", "review", ["fix"])] },
  ],
};

function fixture(t, { planBody = plan, loseFirstIssueResponse = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vizor-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "queue.json");
  writeFileSync(file, JSON.stringify({ paused: false, issues: [7] }));
  const db = new DatabaseSync(":memory:");
  openSchedulerStore(db);
  const issues = [];
  const comments = new Map();
  const writes = [];
  let lose = loseFirstIssueResponse;
  const github = (method, path, body) => {
    if (method === "GET" && path === "user") return { login: "owner" };
    if (method === "GET" && path === "repos/owner/repo")
      return { default_branch: "main" };
    if (method === "GET" && path.startsWith("repos/owner/repo/contents/")) {
      assert.equal(
        path,
        "repos/owner/repo/contents/.github/vizor-plan.json?ref=main",
      );
      return {
        sha: "abc",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(planBody)).toString("base64"),
      };
    }
    if (method === "GET" && path.startsWith("repos/owner/repo/issues?"))
      return path.includes("page=1") ? issues : [];
    const commentPath = path.match(
      /^repos\/owner\/repo\/issues\/(\d+)\/comments/,
    );
    if (method === "GET" && commentPath)
      return path.includes("page=1")
        ? (comments.get(Number(commentPath[1])) ?? [])
        : [];
    if (method === "POST" && path === "repos/owner/repo/issues") {
      writes.push(["issue", body.title]);
      const issue = {
        number: 100 + issues.length,
        body: body.body,
        labels: body.labels,
      };
      issues.push(issue);
      if (lose) {
        lose = false;
        throw Error("GitHub POST failed (HTTP unavailable)");
      }
      return issue;
    }
    if (method === "POST" && commentPath) {
      const number = Number(commentPath[1]);
      const comment = {
        id: 9000 + writes.length,
        user: { login: "owner" },
        body: body.body,
      };
      writes.push(["comment", number]);
      comments.set(number, [...(comments.get(number) ?? []), comment]);
      return comment;
    }
    throw Error("Unexpected " + method + " " + path);
  };
  const queue = () => ({
    ...JSON.parse(readFileSync(file, "utf8")),
    planFile: ".github/vizor-plan.json",
  });
  const run = () =>
    publishApprovedPhases({
      db,
      config,
      queue: queue(),
      file,
      github,
      log: () => {},
    });
  const accept = (issue) =>
    db
      .prepare("INSERT OR REPLACE INTO task_cache VALUES (?,?,1,NULL)")
      .run(issue, JSON.stringify({ number: issue }));
  return { db, file, issues, comments, writes, run, accept };
}

const block = (issue) =>
  JSON.parse(issue.body.match(/```vizor\n([\s\S]*?)\n```/)[1]);

test("publishes only the next approved phase after every earlier task is accepted, then reports completion", (t) => {
  const f = fixture(t);
  assert.equal(f.run().state, "published");
  assert.deepEqual(
    f.issues.map((i) => i.number),
    [100, 101],
  );
  assert.deepEqual(block(f.issues[1]), {
    agent: "morgan",
    dependsOn: [100],
    priority: 10,
    gate: "merge",
    checks: ["vision-python"],
    plan: "synthetic-chain/fix",
  });
  assert.deepEqual(f.issues[1].labels, ["Morgan"]);
  assert.match(
    f.comments.get(101)[0].body,
    /^### Task for Dev: Morgan\n<!-- vizor-plan:synthetic-chain\/fix:assignment -->/,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(f.file, "utf8")).issues,
    [7, 100, 101],
  );
  // Repeated ticks and restarts with partial acceptance publish nothing.
  assert.equal(f.run().state, "running");
  f.accept(100);
  assert.equal(f.run().state, "running");
  assert.equal(f.issues.length, 2);
  f.accept(101);
  const second = f.run();
  assert.equal(second.phase, "two");
  assert.deepEqual(block(f.issues[2]).dependsOn, [101]);
  assert.deepEqual(
    JSON.parse(readFileSync(f.file, "utf8")).issues,
    [7, 100, 101, 102],
  );
  f.accept(102);
  assert.equal(f.run().state, "complete");
  assert.equal(f.issues.length, 3);
  assert.equal(f.writes.length, 6);
});

test("a lost creation response is reconciled by its marker and never published twice", (t) => {
  const f = fixture(t, { loseFirstIssueResponse: true });
  assert.throws(() => f.run(), /HTTP unavailable/);
  assert.equal(f.issues.length, 1);
  // The next round (or a restarted process sharing the database) finds the marker.
  assert.equal(f.run().state, "published");
  assert.deepEqual(
    f.issues.map((i) => i.number),
    [100, 101],
  );
  assert.equal(f.comments.get(100).length, 1);
});

test("only the published assignment comment authorizes a plan task; unrelated issues keep existing rules", (t) => {
  const f = fixture(t);
  f.run();
  const published = f.comments.get(100)[0];
  assert.equal(
    planAssignmentAllowed(f.db, { issue: 100, comment: published }),
    true,
  );
  assert.equal(
    planAssignmentAllowed(f.db, { issue: 100, comment: { id: 1 } }),
    false,
  );
  assert.equal(
    planAssignmentAllowed(f.db, { issue: 57, comment: { id: 1 } }),
    true,
  );
});

test("invalid or out-of-order plans hold publication without creating work", (t) => {
  const bad = structuredClone(plan);
  bad.phases[0].tasks[0].dependsOn = ["fix"];
  const f = fixture(t, { planBody: bad });
  assert.throws(() => f.run(), /out-of-order/);
  const outside = structuredClone(plan);
  outside.phases[0].tasks[1].paths = ["../escape"];
  const g = fixture(t, { planBody: outside });
  assert.throws(() => g.run(), /Invalid/);
  assert.equal(f.writes.length + g.writes.length, 0);
});

test("a blocked plan task counts as accepted only through its accepted recovery recheck (live #62 -> #65 case)", (t) => {
  const f = fixture(t);
  f.run();
  f.accept(101);
  // #100 was blocked; recovery created repair #200 and recheck #201.
  f.db
    .prepare(
      "INSERT INTO task_recoveries(issue,token,repair,recheck,created_at) VALUES (100,'tok',200,201,'now')",
    )
    .run();
  assert.equal(f.run().state, "running");
  f.accept(200);
  assert.equal(f.run().state, "running");
  f.accept(201);
  assert.equal(f.run().phase, "two");
});
