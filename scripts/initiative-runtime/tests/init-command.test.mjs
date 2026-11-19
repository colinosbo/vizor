import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/vizor.mjs", import.meta.url));
const fakeGh = fileURLToPath(
  new URL("./fixtures/fake-gh.mjs", import.meta.url),
);

test(
  "vizor init walks a new project from questions to a passing doctor",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "vizor-init-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "gh"),
      '#!/bin/sh\nexec "' + process.execPath + '" "' + fakeGh + '" "$@"\n',
    );
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const project = join(dir, "project");
    mkdirSync(project);
    spawnSync("git", ["init", "-q"], { cwd: project });
    spawnSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/synthetic-owner/synthetic-repo.git",
      ],
      { cwd: project },
    );
    const env = {
      ...process.env,
      PATH: join(dir, "bin") + delimiter + process.env.PATH,
      FAKE_GH_STATE: join(dir, "state.json"),
      VIZOR_SKILLS_HOME: join(dir, "user-claude"),
      GH_TOKEN: "",
    };
    writeFileSync(
      env.FAKE_GH_STATE,
      JSON.stringify({ labels: {}, missingLabels: ["worker"] }),
    );
    const run = (input, args = []) =>
      spawnSync(process.execPath, [cli, "init", ...args], {
        cwd: project,
        env,
        input,
        encoding: "utf8",
      });

    // Answers: repo and login from defaults (git remote, gh), one worker, braZy, then Enter after "saving" secrets.
    // The secrets are still empty, so init stops at the secrets step with a clear message.
    let r = run("\n\nworker=Synthetic Worker\nbrazy\n\n");
    assert.equal(r.status, 1);
    assert.match(
      r.stdout,
      /GitHub repository \(owner\/repo\) \[synthetic-owner\/synthetic-repo\]/,
    );
    assert.match(r.stdout, /Your GitHub login \[synthetic-lead\]/);
    assert.match(r.stderr, /Worker credentials still missing for: worker/);
    const config = JSON.parse(
      readFileSync(join(project, "vizor.config.json"), "utf8"),
    );
    assert.equal(config.repository, "synthetic-owner/synthetic-repo");
    assert.deepEqual(config.agents.worker.trustedManagers, ["synthetic-lead"]);

    // The owner pastes the secrets (worker + investigator routine), then reruns init.
    const secretsFile = join(project, ".vizor", "secrets.json");
    const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
    secrets.agents.worker = {
      fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_w/fire",
      token: "t",
    };
    secrets.orchestrator = {
      fireUrl:
        "https://api.anthropic.com/v1/claude_code/routines/trig_inv/fire",
      token: "t",
    };
    writeFileSync(secretsFile, JSON.stringify(secrets));
    r = run("brazy\n", []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Already connected/);
    assert.match(r.stdout, /Created GitHub labels: worker\./);
    assert.match(r.stdout, /Blocker investigation is on/);
    assert.match(r.stdout, /Autonomy set to braZy/);
    assert.match(r.stdout, /All diagnostics passed/);
    assert.ok(
      existsSync(
        join(project, ".claude", "skills", "vizor-investigate", "SKILL.md"),
      ),
    );
    assert.ok(
      existsSync(join(dir, "user-claude", "skills", "vizor-plan", "SKILL.md")),
    );
    const queue = JSON.parse(
      readFileSync(join(project, ".vizor", "queue.json"), "utf8"),
    );
    assert.equal(queue.blockerOrchestrator, true);
    assert.equal(queue.autoAcceptReviews, true);
    assert.equal(
      JSON.parse(readFileSync(join(project, "vizor.config.json"), "utf8"))
        .autonomy,
      "brazy",
    );
  },
);
