import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validatePlan } from "../scripts/approvals.mjs";
import { publishApprovedPhases } from "../scripts/phase-publisher.mjs";
import { openSchedulerStore } from "../scripts/scheduler.mjs";

// The example in packaging/examples/ is what FIRST-PLAN.md tells people to copy.
// It must stay valid and publish exactly as the guide describes.
const example = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../packaging/examples/vizor-plan.json", import.meta.url),
    ),
    "utf8",
  ),
);
const config = {
  repository: "your-name/your-repo",
  agents: {
    builder: { name: "Builder", label: "builder", trustedManagers: ["you"] },
    reviewer: { name: "Reviewer", label: "reviewer", trustedManagers: ["you"] },
  },
};

test("the first-plan example is a valid plan for the documented workers", () => {
  assert.equal(validatePlan(example, config.agents), example);
  assert.throws(
    () => validatePlan(example, { builder: config.agents.builder }),
    /Invalid, out-of-order or cyclic plan task: survey/,
  );
});

test("the first-plan example publishes phase one as the guide describes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vizor-first-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "queue.json");
  writeFileSync(
    file,
    JSON.stringify({
      paused: false,
      issues: [],
      dispatchMode: "local",
      planFile: ".github/vizor-plan.json",
    }),
  );
  const db = new DatabaseSync(":memory:");
  openSchedulerStore(db);
  const issues = [];
  const comments = new Map();
  const github = (method, path, body) => {
    if (path === "user") return { login: "you" };
    if (path === "repos/your-name/your-repo") return { default_branch: "main" };
    if (path.startsWith("repos/your-name/your-repo/contents/"))
      return {
        sha: "abc",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(example)).toString("base64"),
      };
    if (method === "GET" && path.includes("/issues?"))
      return path.includes("page=1") ? issues : [];
    const onIssue = path.match(/issues\/(\d+)\/comments/);
    if (method === "GET" && onIssue)
      return path.includes("page=1")
        ? (comments.get(Number(onIssue[1])) ?? [])
        : [];
    if (method === "POST" && path.endsWith("/issues")) {
      const issue = { number: 1 + issues.length, ...body };
      issues.push(issue);
      return issue;
    }
    if (method === "POST" && onIssue) {
      const comment = {
        id: 9000 + comments.size,
        user: { login: "you" },
        ...body,
      };
      comments.set(Number(onIssue[1]), [comment]);
      return comment;
    }
    throw Error("unexpected " + method + " " + path);
  };
  const queue = JSON.parse(readFileSync(file, "utf8"));
  const status = publishApprovedPhases({
    db,
    config,
    queue,
    file,
    github,
    log() {},
  });
  assert.equal(status.state, "published");
  assert.equal(status.phase, "foundation");
  assert.deepEqual(
    issues.map((i) => [i.number, i.title, i.labels]),
    [
      [1, "Survey the test setup and list the gaps", ["reviewer"]],
      [2, "Add a /health endpoint with a test", ["builder"]],
    ],
  );
  // The merge task records its dependency on the survey issue and its checks.
  const meta = JSON.parse(
    issues[1].body.split("```vizor\n")[1].split("\n```")[0],
  );
  assert.deepEqual(meta, {
    agent: "builder",
    dependsOn: [1],
    priority: 20,
    gate: "merge",
    checks: ["test"],
    plan: "first-plan/health-endpoint",
  });
  assert.match(comments.get(1)[0].body, /^### Task for Reviewer\n/);
  assert.match(comments.get(2)[0].body, /Vizor issue: #2/);
  assert.match(comments.get(2)[0].body, /Vizor result: done \(PR #NUMBER\)/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).issues, [1, 2]);
  // Phase two waits until every phase-one task is accepted.
  const again = publishApprovedPhases({
    db,
    config,
    queue,
    file,
    github,
    log() {},
  });
  assert.equal(again.state, "running");
  assert.equal(issues.length, 2);
});

test("vizor check-plan validates the plan file the same way as the runner", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vizor-check-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "vizor.config.json"),
    JSON.stringify({ ...config, port: 4388, dispatchLabel: "vizor:dispatch" }),
  );
  mkdirSync(join(root, ".github"));
  const planFile = join(root, ".github", "vizor-plan.json");
  writeFileSync(planFile, JSON.stringify(example));
  const cli = fileURLToPath(new URL("../scripts/vizor.mjs", import.meta.url));
  const run = () =>
    spawnSync(process.execPath, [cli, "check-plan"], {
      cwd: root,
      encoding: "utf8",
    });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Plan is valid: first-plan, 2 phase\(s\), 3 task\(s\) \(reviewer 1, builder 2\)\./,
  );
  const broken = structuredClone(example);
  broken.phases[0].tasks[1].checks = [];
  writeFileSync(planFile, JSON.stringify(broken));
  result = run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Invalid, out-of-order or cyclic plan task: health-endpoint/,
  );
  writeFileSync(
    planFile,
    JSON.stringify({ ...example, repository: "someone/else" }),
  );
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from vizor.config.json/);
});
