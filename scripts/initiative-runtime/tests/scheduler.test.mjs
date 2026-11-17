import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDispatchStore } from "../scripts/relay.mjs";
import { acceptReview, openSchedulerStore, retireClaim, scheduleTick } from "../scripts/scheduler.mjs";

test("releases three agents independently, then waits for review and verified merge evidence", async (context) => {
  const db = openDispatchStore(new DatabaseSync(":memory:"));
  context.after(() => db.close());
  openSchedulerStore(db);
  const agents = Object.fromEntries(["ronald", "morgan", "riley"].map((name) => [name, {
    label: name, name: "Dev: " + name, trustedManagers: ["lead"],
  }]));
  const config = { repository: "owner/repo", dispatchLabel: "vizor:dispatch", agents };
  const queue = { paused: false, issues: [1, 2, 3, 4] };
  const issues = new Map();
  const comments = new Map();
  const deliveries = [];
  function addIssue(number, agent, dependsOn = [], checks = []) {
    const task = { agent, dependsOn, gate: checks.length ? "merge" : "review", checks, priority: number };
    issues.set(number, {
      number, state: "open", labels: [{ name: agent }],
      body: "\x60\x60\x60vizor\n" + JSON.stringify(task) + "\n\x60\x60\x60",
    });
    comments.set(number, [{ id: number * 10, user: { login: "lead" }, body: "### Task for Dev: " + agent }]);
  }
  addIssue(1, "ronald");
  addIssue(2, "morgan", [], ["test"]);
  addIssue(3, "riley");
  addIssue(4, "ronald", [1, 2]);
  let reachable = false;
  let merged = false;
  let conclusion = "failure";
  function github(method, path, body) {
    if (path === "user") return { login: "lead" };
    if (path === "repos/owner/repo") return { default_branch: "main" };
    if (path.endsWith("/pulls/25")) return {
      merged, base: { ref: "main", repo: { full_name: "owner/repo" } },
      merge_commit_sha: "merged-sha", body: "Vizor issue: #2",
    };
    if (path.includes("/commits/merged-sha/check-runs")) {
      return { total_count: 1, check_runs: [{ name: "test", conclusion }] };
    }
    const [, id, suffix] = path.match(/\/issues\/(\d+)(.*)$/);
    const issue = Number(id);
    if (suffix.startsWith("/comments")) return comments.get(issue);
    if (method === "POST") {
      assert.equal(db.prepare("SELECT agent FROM assignments WHERE issue = ?").get(issue).agent, issues.get(issue).labels[0].name);
      deliveries.push(issue);
      issues.get(issue).labels.push(...body.labels.map((name) => ({ name })));
      return;
    }
    return issues.get(issue);
  }
  const tick = () => scheduleTick({ db, config, queue, github, reachable: () => reachable, log() {} });
  const preview = [];
  await scheduleTick({ db, config, queue: { ...queue, paused: true }, github, preview: true, log: (line) => preview.push(line) });
  assert.ok(preview.includes("#4 waiting for #1, #2."));
  assert.deepEqual(db.prepare("SELECT issue FROM scheduled_issues").all(), []);
  await tick();
  assert.deepEqual(deliveries, []);
  reachable = true;
  await Promise.all([tick(), tick()]);
  assert.deepEqual(deliveries, [1, 2, 3]);
  for (const issue of [1, 2, 3]) {
    db.prepare("INSERT INTO deliveries VALUES (?, ?, 'started', NULL)").run(issue, "delivery-" + issue);
    comments.get(issue).push({
      id: issue * 10 + 1, user: { login: "lead" },
      body: issue === 2 ? "Vizor result: done (PR #25)" : "Vizor result: done",
    });
  }
  await tick();
  const automatic = [];
  await scheduleTick({ db, config, queue: { ...queue, autoAcceptReviews: true }, github, preview: true,
    log: (line) => automatic.push(line) });
  assert.ok(automatic.includes("#4 waiting for #2."));
  assert.equal(db.prepare("SELECT accepted FROM scheduled_issues WHERE issue = 1").get().accepted, 0);
  acceptReview(db, 1);
  queue.autoAcceptReviews = true;
  queue.manualReviewIssues = [3];
  await tick();
  assert.equal(db.prepare("SELECT accepted FROM scheduled_issues WHERE issue = 3").get().accepted, 0);
  queue.manualReviewIssues = [];
  await tick();
  assert.equal(db.prepare("SELECT accepted FROM scheduled_issues WHERE issue = 3").get().accepted, 1);
  assert.deepEqual(deliveries, [1, 2, 3]);
  merged = true;
  await tick();
  assert.deepEqual(deliveries, [1, 2, 3]);
  conclusion = "success";
  await tick();
  await tick();
  assert.deepEqual(deliveries, [1, 2, 3, 4]);
  retireClaim(db, 4);
  assert.equal(db.prepare("SELECT issue FROM assignments WHERE issue = 4").get(), undefined);
  assert.equal(db.prepare("SELECT result FROM scheduled_issues WHERE issue = 4").get().result, "retired");
  await tick();
  assert.deepEqual(deliveries, [1, 2, 3, 4]);

  addIssue(5, "riley");
  queue.issues.push(5);
  issues.get(5).labels.push({ name: config.dispatchLabel });
  db.prepare("INSERT INTO scheduled_issues (issue, agent, assignment) VALUES (5, 'riley', '50')").run();
  const started = [];
  const localTick = () => scheduleTick({
    db, config, queue, github, reachable: () => true, log() {},
    dispatch: (issue) => {
      started.push(issue);
      db.prepare("INSERT INTO deliveries VALUES (?, ?, 'started', NULL)").run(issue, "local-" + issue);
      return true;
    },
  });
  await localTick();
  await localTick();
  assert.deepEqual(started, [5]);

  addIssue(1, "ronald", [4]);
  await assert.rejects(tick(), /Dependency cycle/);
});
