import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
  "doctor --json reports each check and the summary for an agent",
  { skip: process.platform === "win32" },
  (t) => {
    const work = mkdtempSync(join(tmpdir(), "vizor-doctor-json-"));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    mkdirSync(join(work, "bin"));
    writeFileSync(
      join(work, "bin", "gh"),
      '#!/bin/sh\nexec "' + process.execPath + '" "' + fakeGh + '" "$@"\n',
    );
    chmodSync(join(work, "bin", "gh"), 0o755);
    const env = {
      ...process.env,
      PATH: join(work, "bin") + delimiter + process.env.PATH,
      FAKE_GH_STATE: join(work, "state.json"),
      GH_TOKEN: "",
    };
    writeFileSync(
      env.FAKE_GH_STATE,
      JSON.stringify({ labels: {}, missingLabels: ["worker"] }),
    );
    const run = (args) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: work,
        env,
        encoding: "utf8",
      });
    spawnSync("git", ["init", "-q"], { cwd: work });
    assert.equal(
      run([
        "connect",
        "--repo",
        "synthetic-owner/synthetic-repo",
        "--manager",
        "synthetic-lead",
        "--worker",
        "worker=Synthetic Worker",
      ]).status,
      0,
    );
    const result = run(["doctor", "--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema, "vizor.doctor/1");
    assert.equal(report.repository, "synthetic-owner/synthetic-repo");
    assert.equal(report.mode, "local");
    // The template has empty worker credentials and the worker label is missing.
    assert.equal(report.healthy, false);
    assert.equal(result.status, 1);
    const byLabel = Object.fromEntries(report.checks.map((c) => [c.label, c]));
    assert.equal(byLabel["Worker worker"].status, "fail");
    assert.equal(byLabel["GitHub label worker"].status, "fail");
    assert.equal(byLabel["GitHub authentication"].status, "pass");
    // Blocker investigation is core: doctor fails until it is set up.
    assert.equal(byLabel["Blocker investigation"].status, "fail");
    assert.match(byLabel["Blocker investigation"].detail, /vizor investigator/);
    assert.equal(report.failures, 3);
    assert.match(report.summary, /3 check\(s\) need attention/);
  },
);

test("doctor --json returns a JSON error outside a project folder", () => {
  const work = mkdtempSync(join(tmpdir(), "vizor-doctor-json-empty-"));
  try {
    const result = spawnSync(process.execPath, [cli, "doctor", "--json"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.healthy, false);
    assert.match(report.error, /No vizor.config.json/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
