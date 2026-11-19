import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCheckWorkflows } from "../scripts/check-workflows.mjs";

const repository = "synthetic-owner/synthetic-repo";
const github = (names) => (method, path) => {
  if (path === "repos/" + repository) return { default_branch: "trunk" };
  assert.equal(
    path,
    "repos/" + repository + "/commits/trunk/check-runs?per_page=100",
  );
  return { check_runs: names.map((name) => ({ name })) };
};

test("passes when every named check ran on the default branch", () => {
  const result = inspectCheckWorkflows({
    github: github(["test", "lint", "format"]),
    repository,
    checks: ["lint", "test"],
  });
  assert.equal(result.ok, true);
  assert.match(result.detail, /lint, test.*trunk/);
});

test("fails and names the missing check and the starter workflow", () => {
  const result = inspectCheckWorkflows({
    github: github(["lint"]),
    repository,
    checks: ["lint", "test"],
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /No run of test on the latest trunk commit/);
  assert.match(result.detail, /vizor-checks\.yml/);
});

test("a GitHub error is a failure, not a pass", () => {
  const result = inspectCheckWorkflows({
    github: () => {
      throw Error("GitHub GET failed (HTTP 500).");
    },
    repository,
    checks: ["test"],
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 500/);
});

test("the starter workflow runs on pull requests and pushes, with a job per example check", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(
    new URL("../../../packaging/examples/vizor-checks.yml", import.meta.url),
    "utf8",
  );
  assert.match(text, /^ {2}pull_request:/m);
  assert.match(text, /^ {2}push:\n {4}branches: \[main\]/m);
  const plan = JSON.parse(
    readFileSync(
      new URL("../../../packaging/examples/vizor-plan.json", import.meta.url),
      "utf8",
    ),
  );
  for (const phase of plan.phases)
    for (const task of phase.tasks)
      for (const check of task.checks)
        assert.match(text, new RegExp("^ {2}" + check + ":$", "m"));
});
