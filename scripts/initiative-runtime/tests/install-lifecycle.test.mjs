import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
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
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// End-to-end install lifecycle with synthetic data only: build two release
// packages, install from an extracted copy with no source checkout, connect a
// project, dispatch an assignment, upgrade, roll back and restart, and prove
// the same assignment and receipt survive without a second dispatch.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const node = process.execPath;
const V1 = "9.0.0-test.1";
const V2 = "9.0.0-test.2";

function run(args, options = {}) {
  const result = spawnSync(node, args, {
    encoding: "utf8",
    timeout: 120000,
    ...options,
    env: { ...process.env, ...options.env },
  });
  return { ...result, out: (result.stdout || "") + (result.stderr || "") };
}

const hashDir = (dir, skip = () => false) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && !skip(d.name))
      .map((d) => {
        const path = join(d.parentPath ?? d.path, d.name);
        return [
          path.slice(dir.length),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ];
      }),
  );

test("clean install, upgrade, rollback and restart keep one dispatch per assignment", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "vizor install "));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const home = join(work, "home");
  const env = {
    VIZOR_HOME: home,
    VIZOR_SUPERVISOR: "none",
    FIRE_LOG: join(work, "fires.jsonl"),
    FAKE_GH_STATE: join(work, "gh-state.json"),
  };
  writeFileSync(env.FIRE_LOG, "");
  const labels = (map) =>
    writeFileSync(env.FAKE_GH_STATE, JSON.stringify({ labels: map }));
  labels({});
  const fires = (issue) =>
    readFileSync(env.FIRE_LOG, "utf8")
      .split("\n")
      .filter((line) => line.includes("#" + issue + ".")).length;

  // Build both packages, then copy each to a separate "download" folder.
  for (const version of [V1, V2]) {
    const built = run(
      [
        join(repo, "scripts", "package.mjs"),
        "--version",
        version,
        "--out",
        join(work, "dist"),
      ],
      { cwd: repo },
    );
    assert.equal(built.status, 0, built.out);
    // Install from the zip a user downloads, extracted with the OS tool.
    const zip = join(work, "dist", "vizor-" + version + ".zip");
    const target = join(work, "download-" + version);
    const extracted =
      process.platform === "win32"
        ? spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Expand-Archive -LiteralPath '" +
                zip.replaceAll("'", "''") +
                "' -DestinationPath '" +
                target.replaceAll("'", "''") +
                "'",
            ],
            { encoding: "utf8" },
          )
        : spawnSync("unzip", ["-q", zip, "-d", target], { encoding: "utf8" });
    assert.equal(
      extracted.status,
      0,
      String(extracted.stdout || "") + (extracted.stderr || extracted.error),
    );
    cpSync(join(target, "vizor-" + version), target, { recursive: true });
    rmSync(join(target, "vizor-" + version), { recursive: true });
  }
  rmSync(join(work, "dist"), { recursive: true, force: true });
  const setup = (version, extra = []) =>
    run(
      [join(work, "download-" + version, "setup.mjs"), "--no-path", ...extra],
      {
        cwd: work,
        env,
      },
    );

  // Clean install from the extracted package, then delete the package.
  const first = setup(V1);
  assert.equal(first.status, 0, first.out);
  assert.match(
    first.out,
    new RegExp("Installed Vizor " + V1.replaceAll(".", "\\.")),
  );
  rmSync(join(work, "download-" + V1), { recursive: true, force: true });
  const v1 = join(home, "versions", V1);
  const cli = (version, args, cwd) =>
    run([join(home, "versions", version, "scripts", "vizor.mjs"), ...args], {
      cwd,
      env,
    });
  assert.equal(cli(V1, ["version"], work).out.trim(), V1);
  const shim = readFileSync(join(home, "bin", "vizor.cmd"), "utf8");
  assert.ok(shim.includes(join(v1, "scripts", "vizor.mjs")));
  assert.ok(!shim.includes(repo), "shim must not point at the source checkout");
  for (const file of readdirSync(v1, { recursive: true }))
    assert.ok(!String(file).includes("tests"), "tests are not shipped");
  // Pre-install v2 and roll back to v1, so the later upgrade also proves that
  // reinstalling an already-installed version is idempotent.
  assert.equal(setup(V2).status, 0);
  assert.equal(cli(V2, ["rollback"], work).status, 0);
  assert.equal(
    JSON.parse(readFileSync(join(home, "install.json"), "utf8")).current,
    V1,
  );

  // Connect a synthetic project through the installed CLI.
  const project = join(work, "project");
  mkdirSync(project);
  const connected = cli(
    V1,
    [
      "connect",
      "--repo",
      "synthetic-owner/synthetic-repo",
      "--manager",
      "synthetic-lead",
      "--worker",
      "worker=Synthetic Worker",
      "--worker",
      "helper=Synthetic Helper",
    ],
    project,
  );
  assert.equal(connected.status, 0, connected.out);
  assert.match(
    readFileSync(join(project, ".gitignore"), "utf8"),
    /^\.vizor\/$/m,
  );
  const config = JSON.parse(
    readFileSync(join(project, "vizor.config.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(config.agents), ["worker", "helper"]);
  const secrets = JSON.parse(
    readFileSync(join(project, ".vizor", "secrets.json"), "utf8"),
  );
  for (const id of ["worker", "helper"])
    secrets.agents[id] = {
      fireUrl:
        "https://api.anthropic.com/v1/claude_code/routines/trig_synthetic_" +
        id +
        "/fire",
      token: "synthetic-token",
    };
  writeFileSync(
    join(project, ".vizor", "secrets.json"),
    JSON.stringify(secrets),
  );
  const queueFile = join(project, ".vizor", "queue.json");
  const queue = JSON.parse(readFileSync(queueFile, "utf8"));
  assert.equal(queue.dispatchMode, "local");
  writeFileSync(queueFile, JSON.stringify({ ...queue, issues: [7] }));

  const round = (version, mode = "ok") =>
    run(
      [
        join(fixtures, "runner-round.mjs"),
        join(home, "versions", version),
        project,
        mode,
      ],
      { env },
    );
  const receipts = () => {
    const name = readdirSync(join(project, ".vizor")).find((n) =>
      /^[a-f0-9]{64}\.db$/.test(n),
    );
    const db = new DatabaseSync(join(project, ".vizor", name));
    try {
      return db
        .prepare(
          "SELECT d.issue, d.delivery, d.state, d.session, s.agent, s.assignment FROM deliveries d JOIN scheduled_issues s USING(issue) ORDER BY issue",
        )
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };

  // v1 dispatches #7 with a confirmed provider start.
  let r = round(V1);
  assert.equal(r.status, 0, r.out);
  assert.equal(fires(7), 1);
  labels({ 7: ["worker", "vizor:dispatch"] });
  // Then #8, whose provider reply is lost after the fire (ambiguous start).
  writeFileSync(queueFile, JSON.stringify({ ...queue, issues: [7, 8] }));
  r = round(V1, "lost-response");
  assert.equal(r.status, 0, r.out);
  assert.equal(fires(7), 1);
  assert.equal(fires(8), 1);
  labels({ 7: ["worker", "vizor:dispatch"], 8: ["helper", "vizor:dispatch"] });
  const recorded = receipts();
  assert.deepEqual(
    recorded.map((x) => [x.issue, x.agent, x.state]),
    [
      [7, "worker", "started"],
      [8, "helper", "unconfirmed"],
    ],
  );
  const stateBefore = hashDir(
    join(project, ".vizor"),
    (n) =>
      /snapshot|\.db-|cache|\.tmp$/.test(n) || /^[a-f0-9]{64}\.db$/.test(n),
  );

  // Upgrade to v2 from an extracted package; project files are untouched.
  const upgraded = setup(V2);
  assert.equal(upgraded.status, 0, upgraded.out);
  assert.match(upgraded.out, /Upgraded Vizor/);
  let install = JSON.parse(readFileSync(join(home, "install.json"), "utf8"));
  assert.deepEqual([install.current, install.previous], [V2, V1]);
  assert.deepEqual(
    hashDir(
      join(project, ".vizor"),
      (n) =>
        /snapshot|\.db-|cache|\.tmp$/.test(n) || /^[a-f0-9]{64}\.db$/.test(n),
    ),
    stateBefore,
  );
  assert.equal(cli(V2, ["status"], project).status, 0);

  // Restart on v2 with assignments already recorded: no second fire.
  for (let i = 0; i < 2; i++) {
    r = round(V2);
    assert.equal(r.status, 0, r.out);
  }
  assert.equal(fires(7), 1);
  assert.equal(fires(8), 1);
  assert.deepEqual(receipts(), recorded);
  const snapshot = JSON.parse(
    readFileSync(queueFile + ".snapshot.json", "utf8"),
  );
  assert.equal(
    snapshot.executable,
    join(home, "versions", V2, "scripts", "vizor.mjs"),
  );

  // A second runner cannot dispatch while one holds the queue.
  const holder = spawn(
    node,
    [
      join(fixtures, "runner-round.mjs"),
      join(home, "versions", V2),
      project,
      "hold",
    ],
    {
      env: { ...process.env, ...env },
      stdio: "ignore",
    },
  );
  t.after(() => holder.kill("SIGKILL"));
  for (let i = 0; i < 100; i++) {
    const snap = existsSync(queueFile + ".snapshot.json")
      ? JSON.parse(readFileSync(queueFile + ".snapshot.json", "utf8"))
      : null;
    if (snap?.pid === holder.pid && snap.roundState === "idle") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  r = round(V1);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Another Vizor runner owns this project's queue/);
  // Rollback while the holder is still alive, then kill it without cleanup.
  const rolled = cli(V2, ["rollback"], work);
  assert.equal(rolled.status, 0, rolled.out);
  install = JSON.parse(readFileSync(join(home, "install.json"), "utf8"));
  assert.deepEqual([install.current, install.previous], [V1, V2]);
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));

  // v1 takes over the dead holder's lease and recovers the same receipts.
  r = round(V1);
  assert.equal(r.status, 0, r.out);
  assert.equal(fires(7), 1);
  assert.equal(fires(8), 1);
  assert.deepEqual(receipts(), recorded);
  const health = cli(V1, ["status"], project);
  assert.match(health.out, /unconfirmed/);

  // Install is refused while another install holds the lock.
  mkdirSync(join(home, "install.lock"));
  writeFileSync(
    join(home, "install.lock", "owner.json"),
    JSON.stringify({
      pid: process.pid,
      host: (await import("node:os")).hostname(),
      at: Date.now(),
    }),
  );
  const locked = cli(V1, ["rollback"], work);
  assert.notEqual(locked.status, 0);
  assert.match(
    locked.out,
    /Another Vizor install, upgrade or rollback is running/,
  );
  rmSync(join(home, "install.lock"), { recursive: true });

  // A tampered installed version is refused before activation.
  writeFileSync(join(home, "versions", V2, "scripts", "relay.mjs"), "tampered");
  const tampered = cli(V1, ["rollback"], work);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.out, /do not match the package manifest/);
  assert.equal(
    JSON.parse(readFileSync(join(home, "install.json"), "utf8")).current,
    V1,
  );
});
