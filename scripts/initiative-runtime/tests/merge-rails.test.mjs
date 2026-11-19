import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RULESET_NAME,
  applyMergeRails,
  inspectMergeRails,
  railChecks,
} from "../scripts/merge-rails.mjs";

const repository = "synthetic-owner/synthetic-repo";
const repo = "repos/" + repository;

// In-memory GitHub with one repository, its auto-merge flag and rulesets.
function fakeGitHub({ autoMerge = false, rulesets = [], refuse } = {}) {
  const state = { autoMerge, rulesets: structuredClone(rulesets), calls: [] };
  const github = (method, path, body) => {
    state.calls.push(method + " " + path);
    if (refuse && path.startsWith(repo + "/rulesets"))
      throw Error("GitHub " + method + " failed (HTTP " + refuse + ").");
    if (path === repo && method === "GET")
      return { default_branch: "main", allow_auto_merge: state.autoMerge };
    if (path === repo && method === "PATCH")
      return (state.autoMerge = body.allow_auto_merge);
    if (path.startsWith(repo + "/rulesets?"))
      return state.rulesets.map(({ id, name }) => ({ id, name }));
    const id = Number(path.split("/").at(-1));
    if (method === "GET") return state.rulesets.find((r) => r.id === id);
    if (method === "POST")
      return state.rulesets.push({ ...body, id: state.rulesets.length + 1 });
    if (method === "PUT")
      state.rulesets = state.rulesets.map((r) =>
        r.id === id ? { ...body, id } : r,
      );
  };
  return { github, state };
}

const required = (ruleset) =>
  ruleset.rules
    .find((r) => r.type === "required_status_checks")
    .parameters.required_status_checks.map((c) => c.context);

test("railChecks collects plan and repair checks once, sorted", () => {
  const plan = {
    phases: [
      { tasks: [{ checks: ["test"] }, { checks: [] }] },
      { tasks: [{ checks: ["lint", "test"] }] },
    ],
  };
  assert.deepEqual(
    railChecks({ plan, queue: { autoRepair: { checks: ["build"] } } }),
    ["build", "lint", "test"],
  );
  assert.deepEqual(railChecks({}), []);
});

test("supervised changes nothing in GitHub", () => {
  const { github, state } = fakeGitHub();
  const result = applyMergeRails({
    github,
    repository,
    level: "supervised",
    checks: ["test"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(state.calls, []);
  assert.equal(
    inspectMergeRails({ github, repository, level: "supervised", checks: [] })
      .ok,
    true,
  );
});

test("braZy turns on auto-merge and creates the ruleset; a second run is a no-op", () => {
  const { github, state } = fakeGitHub();
  let result = applyMergeRails({
    github,
    repository,
    level: "brazy",
    checks: ["test"],
  });
  assert.equal(result.ok, true);
  assert.equal(state.autoMerge, true);
  const [ruleset] = state.rulesets;
  assert.equal(ruleset.name, RULESET_NAME);
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(ruleset.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assert.deepEqual(
    ruleset.rules.map((r) => r.type),
    ["non_fast_forward", "deletion", "required_status_checks"],
  );
  assert.deepEqual(required(ruleset), ["test"]);
  assert.equal(
    inspectMergeRails({ github, repository, level: "brazy", checks: ["test"] })
      .ok,
    true,
  );

  state.calls = [];
  result = applyMergeRails({
    github,
    repository,
    level: "brazy",
    checks: ["test"],
  });
  assert.deepEqual(result.changes, []);
  assert.ok(state.calls.every((call) => call.startsWith("GET ")));
});

test("a new plan check is added without dropping a check the owner added", () => {
  const { github, state } = fakeGitHub({
    autoMerge: true,
    rulesets: [
      {
        id: 7,
        name: RULESET_NAME,
        enforcement: "active",
        rules: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "security-scan" }],
            },
          },
        ],
      },
    ],
  });
  const before = inspectMergeRails({
    github,
    repository,
    level: "standard",
    checks: ["test"],
  });
  assert.equal(before.ok, false);
  assert.match(before.detail, /missing: test.*vizor rails/);
  applyMergeRails({ github, repository, level: "standard", checks: ["test"] });
  assert.deepEqual(required(state.rulesets[0]), ["security-scan", "test"]);
});

test("missing auto-merge fails doctor; no checks yet passes with a note", () => {
  const { github } = fakeGitHub();
  assert.match(
    inspectMergeRails({ github, repository, level: "standard", checks: [] })
      .detail,
    /auto-merge is off/i,
  );
  const ready = fakeGitHub({ autoMerge: true });
  const result = inspectMergeRails({
    github: ready.github,
    repository,
    level: "standard",
    checks: [],
  });
  assert.equal(result.ok, true);
  assert.match(result.detail, /No named checks yet/);
});

test("a refused ruleset explains admin rights and the GitHub plan", () => {
  const { github } = fakeGitHub({ refuse: 403 });
  const result = applyMergeRails({
    github,
    repository,
    level: "brazy",
    checks: ["test"],
  });
  assert.equal(result.ok, false);
  assert.match(result.notes.join(" "), /admin rights.*GitHub Free/);
});
