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
  assert.notEqual(queue.blockerOrchestrator, true, "not set up yet");
  assert.equal(queue.autoRepair, undefined);
  assert.match(r.stdout, /run vizor investigator/);
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
  assert.match(r.stdout, /run vizor investigator/);
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
  // Once set up, blocker investigation stays on at every level.
  assert.equal(queue.blockerOrchestrator, true);
  run(["autonomy", "supervised"]);
  ({ queue } = read());
  assert.equal(queue.blockerOrchestrator, true);

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
  for (const name of [
    "vizor-accept",
    "vizor-deliver",
    "vizor-blocked",
    "vizor-investigate",
  ])
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
    "vizor-investigate",
    "vizor-operate",
    "vizor-plan",
    "vizor-setup",
  ]);
});

test(
  "vizor investigator turns on blocker investigation from the worker Fire URLs",
  { skip: process.platform === "win32" },
  (t) => {
    const { dir, run, read } = project(t);
    const fake = join(dir, "fake-claude");
    const signed = join(dir, "signed-in");
    writeFileSync(
      fake,
      "#!/bin/sh\nif [ -f '" +
        signed +
        '\' ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; else echo \'{"loggedIn":false}\'; fi\n',
    );
    spawnSync("chmod", ["755", fake]);
    let r = run(["investigator", "--claude", fake]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /claude auth login --claudeai/);
    writeFileSync(signed, "");
    r = run(["investigator", "--claude", fake]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Worker builder has no Fire URL/);
    const secretsFile = join(dir, ".vizor", "secrets.json");
    const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
    for (const id of ["builder", "reviewer"])
      secrets.agents[id] = {
        fireUrl:
          "https://api.anthropic.com/v1/claude_code/routines/trig_" +
          id +
          "123/fire",
        token: "t",
      };
    writeFileSync(secretsFile, JSON.stringify(secrets));
    r = run(["investigator", "--claude", fake]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Blocker investigation is on/);
    const host = JSON.parse(
      readFileSync(join(dir, ".vizor", "orchestrator-host.json"), "utf8"),
    );
    assert.equal(host.provider, "claude");
    assert.equal(host.executable, fake);
    assert.equal(host.timeoutMs, 300000);
    assert.deepEqual(host.cloudReturn, {
      type: "claude-cloud-cli",
      executable: fake,
      triggers: { builder: "trig_builder123", reviewer: "trig_reviewer123" },
    });
    assert.equal(read().queue.blockerOrchestrator, true);
    // An existing configuration is kept; only missing pieces are filled in.
    host.timeoutMs = 120000;
    host.cloudReturn.triggers.builder = "trig_custom";
    writeFileSync(
      join(dir, ".vizor", "orchestrator-host.json"),
      JSON.stringify(host),
    );
    run(["investigator", "--claude", fake]);
    const kept = JSON.parse(
      readFileSync(join(dir, ".vizor", "orchestrator-host.json"), "utf8"),
    );
    assert.equal(kept.timeoutMs, 120000);
    assert.equal(kept.cloudReturn.triggers.builder, "trig_custom");
    assert.equal(kept.cloudReturn.triggers.reviewer, "trig_reviewer123");
    // Doctor now reports the investigation as on.
    r = run(["doctor", "--json"]);
    const check = JSON.parse(r.stdout).checks.find(
      (c) => c.label === "Blocker investigation",
    );
    assert.equal(check.status, "pass", JSON.stringify(check));
  },
);

test("vizor investigator prefers the investigator routine and needs no CLI", (t) => {
  const { dir, run, read } = project(t);
  const secretsFile = join(dir, ".vizor", "secrets.json");
  const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
  assert.deepEqual(
    secrets.orchestrator,
    { fireUrl: "", token: "" },
    "connect adds the template",
  );
  for (const id of ["builder", "reviewer"])
    secrets.agents[id] = {
      fireUrl:
        "https://api.anthropic.com/v1/claude_code/routines/trig_" +
        id +
        "1/fire",
      token: "t",
    };
  writeFileSync(secretsFile, JSON.stringify(secrets));
  // No routine credentials and no CLI: both options are explained.
  let r = run(["investigator", "--claude", join(dir, "missing-claude")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /investigator routine/);
  assert.match(r.stderr, /claude auth login --claudeai/);
  secrets.orchestrator = {
    fireUrl:
      "https://api.anthropic.com/v1/claude_code/routines/trig_investigator/fire",
    token: "t",
  };
  writeFileSync(secretsFile, JSON.stringify(secrets));
  r = run(["investigator", "--claude", join(dir, "missing-claude")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /investigator routine \(cloud; nothing installed on this PC\)/,
  );
  assert.match(r.stdout, /linked follow-up chat/);
  const host = JSON.parse(
    readFileSync(join(dir, ".vizor", "orchestrator-host.json"), "utf8"),
  );
  assert.equal(host.provider, "routine");
  assert.equal(host.executable, undefined);
  assert.equal(host.timeoutMs, 1800000);
  assert.equal(host.cloudReturn, undefined);
  assert.equal(read().queue.blockerOrchestrator, true);
  r = run(["doctor", "--json"]);
  const check = JSON.parse(r.stdout).checks.find(
    (c) => c.label === "Blocker investigation",
  );
  assert.equal(check.status, "pass", JSON.stringify(check));
  assert.match(check.detail, /investigator routine/);
  // Removing the routine credentials makes doctor fail with a clear fix.
  secrets.orchestrator = { fireUrl: "", token: "" };
  writeFileSync(secretsFile, JSON.stringify(secrets));
  r = run(["doctor", "--json"]);
  assert.match(
    JSON.parse(r.stdout).checks.find((c) => c.label === "Blocker investigation")
      .detail,
    /under "orchestrator"/,
  );
});
