import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createGitHubClient,
  parseResponse,
} from "../scripts/github-client.mjs";
import {
  atomicJson,
  snapshotPath,
  readRuntimeSnapshot,
  validArtifactEvidence,
  logLine,
} from "../scripts/runtime-snapshot.mjs";
import { dashboardSnapshot } from "../scripts/dashboard.mjs";
import { requireNode24, runtimeHealth } from "../scripts/runtime-control.mjs";
import {
  openSchedulerStore,
  scheduleTick,
  runScheduler,
  acceptedTaskMetadata,
} from "../scripts/scheduler.mjs";
import { openDispatchStore } from "../scripts/relay.mjs";

function directory(t) {
  const p = mkdtempSync(join(tmpdir(), "vizor-core-"));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
function response(status, value, headers = {}) {
  return {
    status: status >= 400 ? 1 : 0,
    stdout: `HTTP/2.0 ${status} Status\r\n${Object.entries(headers)
      .map(([k, v]) => k + ": " + v)
      .join(
        "\r\n",
      )}\r\n\r\n${value === undefined ? "" : JSON.stringify(value)}`,
    stderr: status >= 400 ? `gh: HTTP ${status}` : "",
  };
}

test("persistent authenticated ETags reuse 304 and isolate credentials; status/header parsing preserves budget", (t) => {
  const file = join(directory(t), "cache.db");
  let calls = 0;
  const execute = (_exe, args) => {
    calls++;
    return calls === 1
      ? response(
          200,
          { ok: true },
          {
            ETag: '"one"',
            "X-RateLimit-Remaining": 4999,
            "X-RateLimit-Reset": 2000000000,
          },
        )
      : (assert.ok(args.includes('If-None-Match: "one"')),
        response(304, undefined, { "X-RateLimit-Remaining": 4999 }));
  };
  let client = createGitHubClient({ file, scope: "identity-A", execute });
  assert.deepEqual(client("GET", "user"), { ok: true });
  client.close();
  client = createGitHubClient({ file, scope: "identity-A", execute });
  assert.deepEqual(client("GET", "user"), { ok: true });
  assert.equal(client.budget().remaining, 4999);
  client.close();
  client = createGitHubClient({
    file,
    scope: "identity-B",
    execute: (_exe, args) => {
      assert.ok(!args.some((a) => a.startsWith("If-None-Match")));
      return response(200, { other: true });
    },
  });
  assert.deepEqual(client("GET", "user"), { other: true });
  client.close();
  assert.equal(
    parseResponse("HTTP/1.1 403 Forbidden\nRetry-After: 12\n\n{}").headers[
      "retry-after"
    ],
    "12",
  );
});

test("403/429 expose budget and honor reset/Retry-After across process restarts without resending", (t) => {
  for (const status of [403, 429]) {
    const file = join(directory(t), "cache.db");
    let clock = 1000000,
      calls = 0;
    const make = () =>
      createGitHubClient({
        file,
        scope: "A",
        now: () => clock,
        execute: () => {
          calls++;
          return response(
            status,
            { message: "credential-must-never-leak" },
            {
              "X-RateLimit-Remaining": 0,
              "X-RateLimit-Reset": 1200,
              "Retry-After": 400,
            },
          );
        },
      });
    let client = make();
    assert.throws(
      () => client("GET", "user"),
      (error) =>
        error.message.includes(`HTTP ${status}`) &&
        error.message.includes("remaining 0") &&
        error.message.includes("retry after") &&
        !error.message.includes("credential-must-never-leak"),
    );
    client.close();
    client = make();
    clock += 399000;
    assert.throws(() => client("GET", "user"), /held until/);
    assert.equal(calls, 1);
    client.close();
    client = make();
    clock += 1001;
    assert.throws(() => client("GET", "user"), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 2);
    client.close();
  }
});

test("primary reset, secondary Retry-After date, missing resources and CLI timeouts have distinct bounded behavior", (t) => {
  for (const scenario of [
    {
      status: 403,
      headers: { "X-RateLimit-Remaining": 0, "X-RateLimit-Reset": 1500 },
      resume: 1500000,
    },
    {
      status: 429,
      headers: {
        "X-RateLimit-Remaining": 4990,
        "Retry-After": new Date(1600000).toUTCString(),
      },
      resume: 1600000,
    },
  ]) {
    let clock = 1000000,
      calls = 0;
    const client = createGitHubClient({
      file: join(directory(t), "cache.db"),
      scope: "A",
      now: () => clock,
      execute: () => {
        calls++;
        return response(scenario.status, {}, scenario.headers);
      },
    });
    assert.throws(() => client("GET", "user"), /HTTP/);
    clock = scenario.resume - 1;
    assert.throws(() => client("GET", "user"), /held until/);
    assert.equal(calls, 1);
    clock = scenario.resume;
    assert.throws(() => client("GET", "user"), /HTTP/);
    assert.equal(calls, 2);
    client.close();
  }
  const missing = createGitHubClient({
    file: join(directory(t), "cache.db"),
    scope: "A",
    execute: () => response(404, {}),
  });
  assert.equal(
    missing("GET", "repos/owner/repo/issues/99", undefined, true),
    null,
  );
  assert.throws(() => missing("GET", "repos/owner/repo/issues/99"), /HTTP 404/);
  missing.close();
  const timeout = createGitHubClient({
    file: join(directory(t), "cache.db"),
    scope: "A",
    execute: () => ({
      error: Error("private credential omitted"),
      status: null,
      stdout: "",
      stderr: "",
    }),
  });
  assert.throws(
    () => timeout("GET", "user"),
    (error) =>
      error.message.includes("timed out") &&
      !error.message.includes("private credential"),
  );
  timeout.close();
});

function fixture(t, count = 3) {
  const db = openDispatchStore(new DatabaseSync(":memory:"));
  openSchedulerStore(db);
  t.after(() => db.close());
  const config = {
    repository: "owner/repo",
    dispatchLabel: "vizor:dispatch",
    agents: {},
  };
  const issues = new Map(),
    comments = new Map();
  for (let n = 1; n <= count; n++) {
    const agent = "worker" + n;
    config.agents[agent] = {
      name: "Dev: " + agent,
      label: agent,
      trustedManagers: ["lead"],
    };
    issues.set(n, {
      number: n,
      title: "Task " + n,
      state: "open",
      labels: [{ name: agent }],
      body:
        "```vizor\n" +
        JSON.stringify({
          agent,
          dependsOn: [],
          priority: n,
          gate: "review",
          checks: [],
        }) +
        "\n```",
    });
    comments.set(n, []);
    db.prepare(
      "INSERT INTO scheduled_issues (issue,agent,assignment) VALUES (?,?,?)",
    ).run(n, agent, String(n * 10));
    db.prepare("INSERT INTO deliveries VALUES (?,?,'started',NULL)").run(
      n,
      "delivery" + n,
    );
  }
  const queue = {
    paused: false,
    autoAcceptReviews: true,
    issues: [...issues.keys()],
    dispatchMode: "local",
  };
  const github = (method, path, body) => {
    if (path === "user") return { login: "lead" };
    if (path === "repos/owner/repo") return { default_branch: "main" };
    const m = path.match(/\/issues\/(\d+)(.*)/);
    if (!m) throw Error("Unexpected " + path);
    const n = Number(m[1]);
    if (method === "PATCH") {
      issues.get(n).state = body.state;
      return issues.get(n);
    }
    if (method === "POST") return {};
    return m[2].startsWith("/comments") ? comments.get(n) : issues.get(n);
  };
  return { db, config, queue, github, issues, comments };
}

test("25 queued issues over one SIMULATED hour retain >3000 budget; accepted issues stop all repeated issue/comment reads", async (t) => {
  const f = fixture(t, 25);
  let clock = 0,
    charged = 0,
    conditional = 0;
  const reads = [];
  const client = createGitHubClient({
    file: join(directory(t), "cache.db"),
    scope: "A",
    now: () => clock,
    execute: (_exe, args, options) => {
      const method = args[args.indexOf("-X") + 1],
        path = args[args.indexOf("-X") + 2];
      const value = f.github(
        method,
        path,
        options.input ? JSON.parse(options.input) : undefined,
      );
      const etag =
        '"' +
        createHash("sha256").update(JSON.stringify(value)).digest("hex") +
        '"';
      if (method === "GET") reads.push(path);
      if (method === "GET" && args.includes("If-None-Match: " + etag)) {
        conditional++;
        return response(304, undefined, {
          "X-RateLimit-Remaining": 5000 - charged,
        });
      }
      charged++;
      return response(200, value, {
        ETag: etag,
        "X-RateLimit-Remaining": 5000 - charged,
      });
    },
  });
  for (let round = 0; round < 80; round++) {
    clock = round * 45000;
    if (round === 40)
      for (const [n, items] of f.comments)
        items.push({
          id: n * 10 + 1,
          user: { login: "lead" },
          body:
            "https://github.com/owner/repo/blob/" +
            "a".repeat(40) +
            "/artifact.md\nVizor result: done",
        });
    if (round === 42) reads.length = 0;
    await scheduleTick({
      ...f,
      github: client,
      reachable: () => true,
      log() {},
    });
  }
  client.close();
  assert.ok(
    5000 - charged > 3000,
    `remaining ${5000 - charged}; charged ${charged}`,
  );
  assert.ok(conditional > 1000);
  assert.ok(reads.every((p) => !p.includes("/issues/")));
  assert.equal(acceptedTaskMetadata(f.db).length, 25);
  t.diagnostic(
    `SIMULATED 80 rounds at 45s: ${charged} charged requests; ${conditional} conditional 304s; remaining ${5000 - charged}. No live-hour claim.`,
  );
});

test("accepted pruned dependencies release; closed/not-planned unaccepted prerequisites explicitly block dependents", async (t) => {
  const f = fixture(t, 3);
  f.queue.issues = [3];
  f.db
    .prepare(
      "UPDATE scheduled_issues SET active=0,result='done',accepted=1 WHERE issue=1",
    )
    .run();
  f.db.prepare("DELETE FROM scheduled_issues WHERE issue IN (2,3)").run();
  f.db.prepare("DELETE FROM deliveries WHERE issue IN (2,3)").run();
  f.issues.get(2).state = "closed";
  f.issues.get(2).state_reason = "not_planned";
  const setDeps = (deps) =>
    (f.issues.get(3).body =
      "```vizor\n" +
      JSON.stringify({
        agent: "worker3",
        dependsOn: deps,
        priority: 3,
        gate: "review",
        checks: [],
      }) +
      "\n```");
  f.comments.get(3).push({
    id: 31,
    user: { login: "lead" },
    body: "### Task for Dev: worker3",
  });
  let statuses = [];
  setDeps([1, 2]);
  await scheduleTick({
    ...f,
    reachable: () => true,
    preview: true,
    onStatus: (s) => statuses.push(s),
    log() {},
  });
  assert.match(statuses[0].reason, /closed, unaccepted prerequisite #2/);
  assert.equal(statuses[0].status, "blocked");
  setDeps([1]);
  statuses = [];
  await scheduleTick({
    ...f,
    reachable: () => true,
    preview: true,
    onStatus: (s) => statuses.push(s),
    log() {},
  });
  assert.equal(statuses[0].status, "ready");
  statuses = [];
  await scheduleTick({
    ...f,
    reachable: () => true,
    preview: true,
    authorizeAssignment: () => false,
    onStatus: (s) => statuses.push(s),
    log() {},
  });
  assert.match(statuses[0].reason, /Missing a trusted assignment/);
});

test("bare/mutable review reports do not autoaccept; immutable evidence does; start confirmation never claims current activity", async (t) => {
  const f = fixture(t, 1);
  const statuses = [];
  await scheduleTick({
    ...f,
    reachable: () => true,
    onStatus: (s) => statuses.push(s),
    log() {},
  });
  assert.equal(statuses[0].status, "started");
  assert.match(statuses[0].reason, /current activity is unknown/);
  f.comments.get(1).push({
    id: 11,
    user: { login: "lead" },
    body: "Vizor result: done\nhttps://github.com/owner/repo/blob/main/artifact.md",
  });
  await scheduleTick({ ...f, reachable: () => true, log() {} });
  assert.equal(
    f.db.prepare("SELECT accepted FROM scheduled_issues").get().accepted,
    0,
  );
  f.comments.get(1)[0].body +=
    "\nhttps://github.com/owner/repo/blob/" + "b".repeat(40) + "/artifact.md";
  await scheduleTick({ ...f, reachable: () => true, log() {} });
  assert.equal(acceptedTaskMetadata(f.db).length, 1);
  assert.equal(validArtifactEvidence("Vizor result: done"), false);
});

test("heartbeat is atomically saved even on sync error; dashboard reads only local snapshot and reports stale/missing truthfully", async (t) => {
  const f = fixture(t, 1),
    file = join(directory(t), "queue.json");
  writeFileSync(file, JSON.stringify(f.queue));
  await runScheduler({
    ...f,
    file,
    once: true,
    reachable: () => true,
    log() {},
  });
  let saved = JSON.parse(readFileSync(snapshotPath(file)));
  assert.equal(saved.schema, "vizor.scheduler/1");
  assert.equal(saved.pid, process.pid);
  assert.ok(saved.startId);
  assert.equal(saved.tasks[0].status, "started");
  const project = join(file, "..");
  mkdirSync(join(project, ".vizor"));
  writeFileSync(
    join(project, ".vizor/runtime-host.json"),
    JSON.stringify({ project: resolve(project), queue: file }),
  );
  assert.equal(runtimeHealth({ project }).healthy, true);
  assert.equal(readRuntimeSnapshot(file).stale, false);
  assert.equal(
    readRuntimeSnapshot(file, { now: Date.now() + 200000 }).stale,
    true,
  );
  assert.equal(readRuntimeSnapshot(file, { alive: () => false }).stale, true);
  assert.equal(
    (
      await dashboardSnapshot({
        file,
        github() {
          throw Error("Dashboard must never use GitHub");
        },
      })
    ).pid,
    process.pid,
  );
  await assert.rejects(
    runScheduler({
      ...f,
      file,
      once: true,
      github() {
        throw Error("HTTP 429 remaining 0");
      },
      reachable: () => true,
    }),
    /HTTP 429/,
  );
  saved = JSON.parse(readFileSync(snapshotPath(file)));
  assert.deepEqual(saved.errors, ["HTTP 429 remaining 0"]);
  assert.equal(saved.tasks[0].status, "started");
  assert.equal(runtimeHealth({ project }).healthy, false);
  assert.equal(
    readRuntimeSnapshot(join(directory(t), "missing")).missing,
    true,
  );
  assert.equal(
    validArtifactEvidence(
      "Vizor evidence: validated schema=vizor.artifact/1 sha256=" +
        "a".repeat(64) +
        " reference=https://example.test/artifact",
    ),
    true,
  );
  assert.ok(!logLine("Bearer secret ghp_password").includes("secret"));
  assert.throws(() => requireNode24("22.0.0"), /requires Node.js 24/);
  assert.doesNotThrow(() => requireNode24("24.15.0"));
});
