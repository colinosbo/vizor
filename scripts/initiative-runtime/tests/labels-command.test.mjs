import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  "vizor labels creates only the missing dispatch and worker labels",
  { skip: process.platform === "win32" },
  (t) => {
    const work = mkdtempSync(join(tmpdir(), "vizor-labels-"));
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
      FAKE_GH_LOG: join(work, "created.log"),
      GH_TOKEN: "",
    };
    writeFileSync(
      env.FAKE_GH_STATE,
      JSON.stringify({
        labels: {},
        missingLabels: ["vizor:dispatch", "helper"],
      }),
    );
    writeFileSync(env.FAKE_GH_LOG, "");
    const run = (args) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: work,
        env,
        encoding: "utf8",
      });
    const connected = run([
      "connect",
      "--repo",
      "synthetic-owner/synthetic-repo",
      "--manager",
      "synthetic-lead",
      "--worker",
      "worker=Synthetic Worker",
      "--worker",
      "helper=Synthetic Helper",
    ]);
    assert.equal(connected.status, 0, connected.stderr);
    const result = run(["labels"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Created GitHub labels: vizor:dispatch, helper\./,
    );
    const created = readFileSync(env.FAKE_GH_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).name);
    assert.deepEqual(created, ["vizor:dispatch", "helper"]);
  },
);
