import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("..", import.meta.url));
const cli = join(runtime, "scripts", "vizor.mjs");
const skillsRoot = join(runtime, "skills");

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), "vizor-autonomy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  assert.equal(
    run([
      "connect",
      "--repo",
      "o/r",
      "--manager",
      "lead",
      "--worker",
      "builder=Builder",
      "--worker",
      "reviewer=Reviewer",
    ]).status,
    0,
  );
  const read = () => ({
    config: JSON.parse(readFileSync(join(dir, "vizor.config.json"), "utf8")),
    queue: JSON.parse(readFileSync(join(dir, ".vizor", "queue.json"), "utf8")),
  });
  return { dir, run, read };
}

test("vizor autonomy applies each level to the queue and records it for workers", (t) => {
  const { dir, run, read } = project(t);
  let r = run(["autonomy"]);
  assert.match(r.stdout, /Autonomy: Standard/);

  r = run(["autonomy", "supervised"]);
  assert.equal(r.status, 0, r.stderr);
  let { config, queue } = read();
  assert.equal(config.autonomy, "supervised");
  assert.equal(queue.autoAcceptReviews, false);
  assert.equal(queue.blockerOrchestrator, false);
  assert.equal(queue.autoRepair, undefined);
  assert.match(r.stdout, /draft PRs/);

  r = run([
    "autonomy",
    "brazy",
    "--repair-agent",
    "builder",
    "--repair-check",
    "test",
  ]);
  assert.equal(r.status, 0, r.stderr);
  ({ config, queue } = read());
  assert.equal(config.autonomy, "brazy");
  assert.equal(queue.autoAcceptReviews, true);
  assert.deepEqual(queue.autoRepair, { agent: "builder", checks: ["test"] });
  // No orchestrator host yet: investigations stay manual and the user is told.
  assert.notEqual(queue.blockerOrchestrator, true);
  assert.match(r.stdout, /Blocker investigations stay manual/);
  assert.match(r.stdout, /braZy/);
  // Queue and config remain valid for the runtime.
  assert.equal(queue.dispatchMode, "local");
  assert.deepEqual(queue.issues, []);

  writeFileSync(join(dir, ".vizor", "orchestrator-host.json"), "{}");
  run(["autonomy", "brazy"]);
  ({ queue } = read());
  assert.equal(queue.blockerOrchestrator, true);
  assert.deepEqual(
    queue.autoRepair,
    { agent: "builder", checks: ["test"] },
    "kept",
  );

  r = run(["autonomy", "standard"]);
  ({ config, queue } = read());
  assert.equal(config.autonomy, "standard");
  assert.equal(queue.autoAcceptReviews, true);
  assert.equal(queue.autoRepair, undefined);
  assert.equal(queue.blockerOrchestrator, false);

  r = run(["autonomy", "yolo"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /supervised \| standard \| brazy/);
  r = run([
    "autonomy",
    "brazy",
    "--repair-agent",
    "nobody",
    "--repair-check",
    "test",
  ]);
  assert.equal(r.status, 1);
  // A plan still validates with the autonomy field present in the config.
  mkdirSync(join(dir, ".github"));
  const example = JSON.parse(
    readFileSync(
      join(runtime, "..", "..", "packaging", "examples", "vizor-plan.json"),
      "utf8",
    ),
  );
  writeFileSync(
    join(dir, ".github", "vizor-plan.json"),
    JSON.stringify({ ...example, repository: "o/r" }),
  );
  r = run(["check-plan"]);
  assert.equal(r.status, 0, r.stderr);
});

test("vizor skills installs worker skills in the project and operator skills for the user, without overwriting", (t) => {
  const { dir, run } = project(t);
  const home = join(dir, "user-claude");
  const env = { VIZOR_SKILLS_HOME: home };
  let r = run(["skills"], env);
  assert.equal(r.status, 0, r.stderr);
  for (const name of ["vizor-accept", "vizor-deliver", "vizor-blocked"])
    assert.ok(
      existsSync(join(dir, ".claude", "skills", name, "SKILL.md")),
      name,
    );
  for (const name of ["vizor-setup", "vizor-plan", "vizor-operate"])
    assert.ok(existsSync(join(home, "skills", name, "SKILL.md")), name);
  writeFileSync(
    join(dir, ".claude", "skills", "vizor-accept", "SKILL.md"),
    "customised",
  );
  r = run(["skills"], env);
  assert.match(r.stdout, /Kept existing .*vizor-accept/);
  assert.equal(
    readFileSync(
      join(dir, ".claude", "skills", "vizor-accept", "SKILL.md"),
      "utf8",
    ),
    "customised",
  );
  r = run(["skills", "--workers-only", "--force"], env);
  assert.notEqual(
    readFileSync(
      join(dir, ".claude", "skills", "vizor-accept", "SKILL.md"),
      "utf8",
    ),
    "customised",
  );
});

test("every bundled skill has valid frontmatter and no pilot-specific details", () => {
  const found = [];
  for (const group of ["operator", "worker"])
    for (const name of readdirSync(join(skillsRoot, group))) {
      const text = readFileSync(
        join(skillsRoot, group, name, "SKILL.md"),
        "utf8",
      );
      const front = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(
        text,
      );
      assert.ok(front, name + " frontmatter");
      assert.equal(front[1], name);
      assert.ok(front[2].length <= 1024, name + " description length");
      for (const pilot of [
        /colinosbo/i,
        /\bMorgan\b/,
        /\bRiley\b/,
        /\bRonald\b/,
        /Vision/,
        /npm run vizor/,
        /tunnel/i,
      ])
        assert.doesNotMatch(text, pilot, name + " mentions " + pilot);
      found.push(name);
    }
  assert.deepEqual(found.sort(), [
    "vizor-accept",
    "vizor-blocked",
    "vizor-deliver",
    "vizor-operate",
    "vizor-plan",
    "vizor-setup",
  ]);
});
