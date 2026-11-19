import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { once } from "node:events";
import { openDispatchStore, createListener } from "../scripts/relay.mjs";
import {
  openSchedulerStore,
  readTask,
  scheduleTick,
} from "../scripts/scheduler.mjs";
import { recordBlocker, blockerSnapshot } from "../scripts/blockers.mjs";
import {
  orchestratorTick,
  runDirectory,
  resumeInvestigation,
  validateDecision,
} from "../scripts/orchestrator.mjs";
import { atomicJson, supervise } from "../scripts/codex-investigation.mjs";
import { createDispatcher } from "../scripts/relay.mjs";
import {
  findRoutineDecision,
  fireRoutine,
  startRoutineInvestigation,
} from "../scripts/routine-investigation.mjs";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "vizor-orchestrator-"));
  const database = join(root, "state.db");
  let db;
  const reopen = () => {
    db?.close();
    db = openDispatchStore(new DatabaseSync(database));
    openSchedulerStore(db);
  };
  reopen();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = {
    repository: "owner/repo",
    dispatchLabel: "dispatch",
    agents: {
      research: { name: "Ronald", label: "Ronald", trustedManagers: ["lead"] },
    },
  };
  const queue = {
    issues: [25],
    paused: false,
    blockerOrchestrator: true,
    ...(options.manual ? { manualReviewIssues: [25] } : {}),
  };
  const file = join(root, "queue.json");
  writeFileSync(file, JSON.stringify(queue));
  db.prepare(
    "INSERT INTO scheduled_issues(issue,agent,assignment,active,result) VALUES (25,'research','10',0,'blocked')",
  ).run();
  db.prepare(
    "INSERT INTO assignments VALUES (25,'research','https://github.com/owner/repo/issues/25#issuecomment-10')",
  ).run();
  db.prepare(
    "INSERT INTO deliveries VALUES (25,'original','started','https://claude.ai/code/session_original')",
  ).run();
  const block = (data) => "```vizor\n" + JSON.stringify(data) + "\n```";
  const issues = [
    {
      number: 25,
      title: "Qualify pilot",
      state: "open",
      labels: [{ name: "Ronald" }],
      body: block({
        agent: "research",
        dependsOn: [],
        priority: 1,
        gate: "review",
        checks: [],
        ...(options.child ? { orchestratorRoot: 1 } : {}),
      }),
    },
  ];
  const report = {
    id: 11,
    user: { login: "lead" },
    issue_url: "https://api.github.com/repos/owner/repo/issues/25",
    body: `Blocker evidence\n${options.capacity ? "Vizor blocker: capacity\n" : options.external ? "Vizor blocker: external\n" : ""}Vizor result: blocked`,
  };
  const commentMap = new Map([
    [
      25,
      [
        { id: 10, user: { login: "lead" }, body: "### Task for Ronald" },
        report,
        {
          id: 12,
          user: { login: "lead" },
          body: "Owner decision: Phase 2 authorized; external access not granted.",
        },
      ],
    ],
  ]);
  let nextComment = 100;
  let timeoutWrite = false;
  function github(method, path, body) {
    if (path === "user") return { login: "lead" };
    if (path === "repos/owner/repo") return { default_branch: "main" };
    if (path.includes("/commits/")) return { sha: "a".repeat(40) };
    if (path.includes("/contents/"))
      return {
        content: Buffer.from(
          "Approved synthetic build; no customer access.",
        ).toString("base64"),
      };
    if (path.includes("/issues?")) return issues;
    const id = Number(path.match(/issues\/(\d+)/)?.[1]);
    if (path.includes("/comments")) {
      if (method === "GET") return commentMap.get(id) ?? [];
      const value = {
        id: nextComment++,
        user: { login: "lead" },
        body: body.body,
      };
      commentMap.set(id, [...(commentMap.get(id) ?? []), value]);
      if (timeoutWrite) {
        timeoutWrite = false;
        throw Error("Response lost after remote write");
      }
      return value;
    }
    if (id && method === "GET") return issues.find((i) => i.number === id);
    if (id && path.endsWith("/labels")) return [];
    if (method === "POST" && path.endsWith("/issues")) {
      const value = {
        number: 50 + issues.length,
        state: "open",
        ...body,
        labels: body.labels.map((name) => ({ name })),
      };
      issues.push(value);
      if (timeoutWrite) {
        timeoutWrite = false;
        throw Error("Response lost after issue created");
      }
      return value;
    }
    throw Error("Unexpected " + method + " " + path);
  }
  const host = {
    executable: process.execPath,
    timeoutMs: 1000,
    endedSessions: ["https://claude.ai/code/session_original"],
    preparationIssues: options.preparation ? [25] : [],
  };
  let launches = 0;
  const launch = ({ root, run }) => {
    launches++;
    atomicJson(join(runDirectory(root, run), "status.json"), {
      state: "running",
      session: "11111111-1111-1111-1111-111111111111",
      at: Date.now(),
    });
  };
  const tick = (extra = {}) =>
    orchestratorTick({
      db,
      config,
      queue,
      file,
      github,
      host,
      root,
      parseTask: readTask,
      launch,
      ...extra,
    });
  const runs = () => db.prepare("SELECT * FROM blocker_runs").all();
  const complete = (action = "return") => {
    const run = runs()[0];
    atomicJson(join(runDirectory(root, run), "status.json"), {
      state: "completed",
      session: "11111111-1111-1111-1111-111111111111",
      at: Date.now(),
    });
    atomicJson(join(runDirectory(root, run), "decision.json"), {
      action,
      summary: "Settled decision reused; missing partner remains explicit.",
      nextStep: "Continue approved work.",
      evidence: ["12"],
      externalRequirements:
        action === "external" ? ["Partner, workspace and budget"] : [],
    });
  };
  const record = () =>
    recordBlocker({ db, config, issue: 25, comment: report });
  return {
    root,
    config,
    queue,
    file,
    report,
    host,
    tick,
    runs,
    complete,
    record,
    reopen,
    github,
    issues,
    commentMap,
    get db() {
      return db;
    },
    get launches() {
      return launches;
    },
    timeoutNext() {
      timeoutWrite = true;
    },
  };
}

test("signed blocked event -> one saved investigation -> verified resolution -> original-worker follow-up through normal scheduler", async (t) => {
  const f = fixture(t);
  const credentials = { webhookSecret: "a".repeat(64), agents: {} };
  const server = createListener({
    config: f.config,
    credentials,
    database: f.db,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const event = {
    action: "created",
    repository: { full_name: "owner/repo" },
    issue: { number: 25 },
    comment: f.report,
    sender: { login: "lead" },
  };
  const bytes = JSON.stringify(event);
  const send = (signature) =>
    fetch(`http://127.0.0.1:${server.address().port}/webhooks/github`, {
      method: "POST",
      body: bytes,
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": signature,
      },
    });
  assert.equal((await send("sha256=" + "0".repeat(64))).status, 401);
  const signature =
    "sha256=" +
    createHmac("sha256", credentials.webhookSecret).update(bytes).digest("hex");
  assert.equal((await send(signature)).status, 202);
  assert.equal((await send(signature)).status, 200);
  f.tick();
  f.tick();
  assert.equal(f.launches, 1);
  f.complete();
  f.tick();
  f.tick();
  assert.equal(f.runs()[0].state, "returned");
  assert.equal(f.issues.length, 2);
  assert.equal(
    f.db.prepare("SELECT accepted FROM scheduled_issues WHERE issue=25").get()
      .accepted,
    0,
  );
  const followup = f.issues[1];
  assert.match(followup.body, /linked follow-up, not same-chat resumption/);
  assert.equal(
    readTask(followup, f.config.agents, new Set(f.queue.issues)).agent,
    "research",
  );
  const dispatched = [];
  await scheduleTick({
    db: f.db,
    config: f.config,
    queue: f.queue,
    github: f.github,
    reachable: async () => true,
    dispatch: async (i) => dispatched.push(i),
    log() {},
  });
  assert.deepEqual(dispatched, [followup.number]);
  assert.equal(
    f.db
      .prepare("SELECT agent FROM scheduled_issues WHERE issue=?")
      .get(followup.number).agent,
    "research",
  );
  assert.ok(
    blockerSnapshot(f.db).activity.some((a) => a.action === "returned"),
  );
});

test("restart and lost remote responses reconcile issue/comment markers without duplicated starts or follow-ups", (t) => {
  const f = fixture(t);
  f.record();
  f.tick();
  f.reopen();
  f.tick();
  assert.equal(f.launches, 1);
  f.complete();
  f.timeoutNext();
  f.tick(); // resolution comment succeeds remotely, response lost
  f.reopen();
  f.tick();
  assert.equal(f.runs()[0].state, "returned");
  assert.equal(f.issues.length, 2);
  assert.equal(
    f.commentMap.get(25).filter((c) => c.body.includes(":resolution -->"))
      .length,
    1,
  );
  f.tick();
  assert.equal(f.launches, 1);
});

test("lost follow-up creation response reconciles its marker after restart", (t) => {
  const f = fixture(t);
  f.record();
  f.tick();
  f.complete();
  const github = (method, path, body) => {
    if (method === "POST" && path === "repos/owner/repo/issues")
      f.timeoutNext();
    return f.github(method, path, body);
  };
  f.tick({ github });
  assert.equal(f.issues.length, 2);
  assert.equal(f.runs()[0].uncertain, "followup");
  f.reopen();
  f.tick();
  assert.equal(f.issues.length, 2);
  assert.equal(f.runs()[0].state, "returned");
});

test("software repair keeps merge checks and returns recheck to the original worker", (t) => {
  const f = fixture(t);
  f.queue.autoRepair = { agent: "research", checks: ["test"] };
  writeFileSync(f.file, JSON.stringify(f.queue));
  f.record();
  f.tick();
  f.complete("repair");
  f.tick();
  assert.equal(f.runs()[0].state, "repair");
  assert.equal(f.issues.length, 3);
  const repair = readTask(
    f.issues[1],
    f.config.agents,
    new Set(f.queue.issues),
  );
  const recheck = readTask(
    f.issues[2],
    f.config.agents,
    new Set(f.queue.issues),
  );
  assert.equal(repair.gate, "merge");
  assert.deepEqual(repair.checks, ["test"]);
  assert.equal(recheck.agent, "research");
  assert.deepEqual(recheck.dependsOn, [f.issues[1].number]);
});

test("uncertain launch is never retried; restart can reconcile a late acknowledgement", (t) => {
  const f = fixture(t);
  f.record();
  f.tick({ launch() {} });
  f.tick({ now: Date.now() + 60000 });
  assert.equal(f.runs()[0].state, "uncertain");
  f.reopen();
  f.tick();
  assert.equal(f.launches, 0);
  f.complete();
  f.tick();
  assert.equal(f.runs()[0].state, "returned");
  assert.equal(f.launches, 0);
});

test("Codex usage pause resumes the saved session only on demand", (t) => {
  const f = fixture(t);
  f.record();
  f.tick();
  const run = f.runs()[0];
  atomicJson(join(runDirectory(f.root, run), "status.json"), {
    state: "usage_paused",
    session: "11111111-1111-1111-1111-111111111111",
    at: Date.now(),
  });
  f.tick();
  f.reopen();
  f.tick();
  assert.equal(f.launches, 1);
  assert.equal(f.runs()[0].state, "usage_paused");
  resumeInvestigation(f.db, run.id);
  let resumed;
  f.tick({
    launch(args) {
      resumed = args.run.session;
    },
  });
  assert.equal(resumed, "11111111-1111-1111-1111-111111111111");
  assert.equal(f.runs()[0].attempt, 1);
});

test("worker usage pause retains active worker and blocks every replacement even if model says return", (t) => {
  const f = fixture(t, { capacity: true });
  f.db.prepare("UPDATE scheduled_issues SET active=1,result=NULL").run();
  f.record();
  f.tick();
  f.complete();
  f.tick();
  assert.equal(f.runs()[0].state, "worker_usage_paused");
  assert.equal(f.issues.length, 1);
  assert.equal(
    f.db.prepare("SELECT active FROM scheduled_issues").get().active,
    1,
  );
});

test("manual/external gates reach Codex but never become accepted; approved preparation is separate", (t) => {
  const f = fixture(t, { manual: true, external: true, preparation: true });
  f.record();
  f.tick();
  f.complete("external");
  f.tick();
  assert.equal(f.launches, 1);
  assert.equal(f.runs()[0].state, "preparation_queued");
  assert.deepEqual(
    {
      ...f.db
        .prepare("SELECT result,accepted FROM scheduled_issues WHERE issue=25")
        .get(),
    },
    { result: "blocked", accepted: 0 },
  );
  assert.match(f.issues[1].body, /synthetic data only/);
  assert.equal(
    f.db.prepare("SELECT * FROM task_recoveries WHERE issue=25").get(),
    undefined,
  );
});

test("genuine external authority without preparation remains held and does not occupy another worker", (t) => {
  const f = fixture(t, { external: true });
  f.record();
  f.tick();
  f.complete("external");
  f.tick();
  assert.equal(f.runs()[0].state, "external");
  assert.equal(f.issues.length, 1);
});

test("unknown provider end, active worker, and recursive follow-ups cannot spawn another worker chat", (t) => {
  const f = fixture(t);
  f.host.endedSessions = [];
  f.record();
  f.tick();
  f.complete();
  f.tick();
  assert.equal(f.runs()[0].state, "awaiting_worker_end");
  assert.equal(f.issues.length, 1);
  f.host.endedSessions = ["https://claude.ai/code/session_original"];
  f.db.prepare("UPDATE scheduled_issues SET active=1").run();
  f.tick();
  assert.equal(f.issues.length, 1);
  f.db.prepare("UPDATE scheduled_issues SET active=0").run();
  f.tick();
  assert.equal(f.issues.length, 2);
  const g = fixture(t, { child: true });
  g.record();
  g.tick();
  g.complete("repair");
  g.tick();
  assert.equal(g.runs()[0].state, "held");
  assert.equal(g.issues.length, 1);
});

test("foreign authors, assignment mismatch, invalid evidence and paused queues cannot authorize actions", (t) => {
  const f = fixture(t);
  assert.equal(
    recordBlocker({
      db: f.db,
      config: f.config,
      issue: 25,
      comment: { ...f.report, user: { login: "attacker" } },
    }),
    false,
  );
  assert.throws(() =>
    validateDecision(
      {
        action: "return",
        summary: "x",
        nextStep: "y",
        evidence: ["invented"],
        externalRequirements: [],
      },
      { kind: "ordinary" },
      { issues: [] },
    ),
  );
  f.record();
  f.queue.paused = true;
  f.tick();
  assert.equal(f.launches, 0);
});

test("saved readable comment citations reconcile to exact bound IDs without a second model run", (t) => {
  const f = fixture(t);
  f.record();
  f.tick();
  f.complete("external");
  const file = join(runDirectory(f.root, f.runs()[0]), "decision.json");
  const saved = JSON.parse(readFileSync(file));
  saved.evidence = [
    "#25 comment 11 contains the blocker; #25 comment 12 records the later decision.",
  ];
  atomicJson(file, saved);
  f.tick();
  assert.equal(f.runs()[0].state, "external");
  assert.equal(f.launches, 1);
  assert.deepEqual(JSON.parse(f.runs()[0].decision).evidence, ["11", "12"]);
  assert.throws(() =>
    validateDecision(
      { ...saved, evidence: ["comment 999 is invented"] },
      { kind: "ordinary" },
      { issues: [{ comments: [{ id: "12" }] }] },
    ),
  );
});

test("real supervisor process protocol saves session, classifies usage, and times out without retries", async (t) => {
  for (const mode of ["success", "usage", "timeout"]) {
    const directory = mkdtempSync(join(tmpdir(), "vizor-codex-protocol-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // node is a portable fake executable: its first argument 'exec' is this fixture file.
    writeFileSync(
      join(directory, "exec"),
      `const fs=require('node:fs');
console.log(JSON.stringify({type:'thread.started',thread_id:'22222222-2222-2222-2222-222222222222'}));
${
  mode === "success"
    ? "fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], JSON.stringify({action:'external'}));"
    : mode === "usage"
      ? "console.error('usage_limit_reached');process.exitCode=1;"
      : "setInterval(()=>{},1000);"
}`,
    );
    atomicJson(join(directory, "request.json"), {
      executable: process.execPath,
      prompt: "classify",
      timeoutMs: mode === "timeout" ? 100 : 5000,
    });
    await supervise(directory);
    const status = JSON.parse(readFileSync(join(directory, "status.json")));
    assert.equal(
      status.state,
      mode === "success"
        ? "completed"
        : mode === "usage"
          ? "usage_paused"
          : "timeout",
    );
    if (mode !== "timeout")
      assert.equal(status.session, "22222222-2222-2222-2222-222222222222");
  }
});

function cloudFixture(t, options = {}) {
  const f = fixture(t, options);
  f.host.cloudReturn = {
    type: "claude-cloud-cli",
    executable: process.execPath,
    triggers: { research: "trig_research" },
  };
  f.host.endedSessions = [];
  let sends = 0;
  const sendCloud = (request) => {
    sends++;
    assert.equal(request.session, "session_original");
    return {
      state: "queued",
      detail: "Exact provider session confirmed queued.",
    };
  };
  const observeLifecycle = () => ({
    state: "completed",
    detail: "Provider terminal metadata.",
  });
  return {
    ...f,
    get db() {
      return f.db;
    },
    get sends() {
      return sends;
    },
    get launches() {
      return f.launches;
    },
    tick(extra = {}) {
      f.tick({ sendCloud, observeLifecycle, ...extra });
    },
  };
}

test("same-chat return retains original receipt, uses a new result generation, deduplicates restart and accepts only its result token", async (t) => {
  const f = cloudFixture(t);
  f.queue.autoAcceptReviews = true;
  f.record();
  f.tick();
  f.complete();
  f.tick();
  f.reopen();
  f.tick();
  assert.equal(f.sends, 1);
  assert.equal(f.issues.length, 1);
  assert.equal(f.runs()[0].state, "cloud_queued");
  const record = f.db.prepare("SELECT * FROM cloud_returns").get();
  assert.equal(record.original_assignment, "10");
  assert.equal(record.session, "session_original");
  assert.equal(
    f.db.prepare("SELECT session FROM deliveries WHERE issue=25").get().session,
    "https://claude.ai/code/session_original",
  );
  const list = f.commentMap.get(25);
  list.push({
    id: 201,
    user: { login: "lead" },
    body: "Old finishing turn\nVizor result: done",
  });
  const schedule = () =>
    scheduleTick({
      db: f.db,
      config: f.config,
      queue: f.queue,
      github: f.github,
      reachable: async () => true,
      log() {},
    });
  await schedule();
  assert.equal(
    f.db.prepare("SELECT active FROM scheduled_issues").get().active,
    1,
  );
  list.push({
    id: 202,
    user: { login: "lead" },
    body: "Vizor return: different-session\nVizor result: blocked",
  });
  await schedule();
  assert.equal(
    f.db.prepare("SELECT active FROM scheduled_issues").get().active,
    1,
  );
  list.push({
    id: 203,
    user: { login: "lead" },
    body: "Vizor return: " + record.run + "\nVizor result: done",
  });
  await schedule();
  await schedule();
  assert.equal(
    f.db.prepare("SELECT result FROM scheduled_issues").get().result,
    "done",
  );
  assert.equal(
    f.db.prepare("SELECT state FROM cloud_returns").get().state,
    "completed",
  );
  assert.equal(f.runs()[0].state, "return_completed");
  assert.equal(f.sends, 1);
});

test("same-chat preparation completes while the original manual live gate remains blocked and unaccepted", async (t) => {
  const f = cloudFixture(t, {
    manual: true,
    external: true,
    preparation: true,
  });
  f.record();
  f.tick();
  f.complete("external");
  f.tick();
  const record = f.db.prepare("SELECT * FROM cloud_returns").get();
  f.commentMap.get(25).push({
    id: 201,
    user: { login: "lead" },
    body: "Vizor return: " + record.run + "\nVizor result: done",
  });
  await scheduleTick({
    db: f.db,
    config: f.config,
    queue: f.queue,
    github: f.github,
    reachable: async () => true,
    log() {},
  });
  const row = f.db.prepare("SELECT * FROM scheduled_issues").get();
  assert.equal(row.active, 0);
  assert.equal(row.result, "blocked");
  assert.equal(row.accepted, 0);
  assert.equal(f.runs()[0].state, "preparation_complete");
  assert.equal(f.issues.length, 1);
});

test("same-chat unknown/finishing observation is never called completed; supported queue handles it without a new Fire", (t) => {
  for (const state of ["unknown", "running"]) {
    const f = cloudFixture(t);
    f.record();
    f.tick();
    f.complete();
    f.tick({ observeLifecycle: () => ({ state, detail: "No end asserted." }) });
    assert.equal(f.sends, 1);
    assert.equal(f.runs()[0].state, "cloud_queued");
    assert.equal(f.issues.length, 1);
  }
  const f = cloudFixture(t);
  f.record();
  f.tick();
  f.complete();
  f.tick({
    observeLifecycle: () => ({
      state: "usage_paused",
      detail: "Provider usage pause.",
    }),
  });
  assert.equal(f.sends, 0);
  assert.equal(f.runs()[0].state, "worker_usage_paused");
});

test("worker capacity wait retries after its independent task completes; usage-paused and uncertain sends never duplicate", (t) => {
  const f = cloudFixture(t);
  f.record();
  f.tick();
  f.complete();
  f.db
    .prepare(
      "INSERT INTO scheduled_issues(issue,agent,assignment,active) VALUES (99,'research','99',1)",
    )
    .run();
  f.tick();
  assert.equal(f.runs()[0].state, "awaiting_worker_capacity");
  assert.equal(f.sends, 0);
  f.db
    .prepare(
      "UPDATE scheduled_issues SET active=0,result='done' WHERE issue=99",
    )
    .run();
  f.tick();
  assert.equal(f.sends, 1);
  const g = cloudFixture(t);
  g.record();
  g.tick();
  g.complete();
  let attempts = 0;
  g.tick({
    sendCloud() {
      attempts++;
      throw Error("Response lost after send");
    },
  });
  g.reopen();
  g.tick();
  assert.equal(attempts, 1);
  assert.equal(g.runs()[0].state, "cloud_uncertain");
  assert.equal(
    g.db.prepare("SELECT active FROM scheduled_issues").get().active,
    1,
  );
});

test("repair keeps merge/check dependencies then queues verification in the original saved chat, with no verifier Fire", async (t) => {
  const f = cloudFixture(t);
  f.queue.autoAcceptReviews = true;
  f.queue.autoRepair = { agent: "research", checks: ["test"] };
  writeFileSync(f.file, JSON.stringify(f.queue));
  f.record();
  f.tick();
  f.complete("repair");
  f.tick();
  assert.equal(f.runs()[0].state, "repair");
  assert.equal(f.issues.length, 3);
  const [repair, recheck] = f.issues.slice(1);
  const mapping = f.db
    .prepare("SELECT * FROM cloud_rechecks WHERE issue=?")
    .get(recheck.number);
  assert.equal(mapping.original, 25);
  let verifierFires = 0;
  let queues = 0;
  const dispatch = createDispatcher({
    config: f.config,
    credentials: { agents: {} },
    database: f.db,
    fire() {
      verifierFires++;
      throw Error("Must not Fire verifier");
    },
    cloudServices: {
      host: f.host,
      observe: () => ({ state: "completed" }),
      send: () => {
        queues++;
        return { state: "queued", detail: "Same verifier queued." };
      },
    },
  });
  const schedule = () =>
    scheduleTick({
      db: f.db,
      config: f.config,
      queue: f.queue,
      github,
      reachable: async () => true,
      dispatch: (i) => (i === repair.number ? true : dispatch(i, randomUUID())),
      log() {},
    });
  function github(method, path, body) {
    if (path === "repos/owner/repo/pulls/77")
      return {
        merged: true,
        merge_commit_sha: "a".repeat(40),
        body: "Vizor issue: #" + repair.number,
        base: { ref: "main", repo: { full_name: "owner/repo" } },
      };
    if (path.includes("/check-runs"))
      return {
        total_count: 1,
        check_runs: [{ name: "test", conclusion: "success" }],
      };
    return f.github(method, path, body);
  }
  await schedule();
  assert.equal(queues, 0);
  f.db
    .prepare(
      "UPDATE scheduled_issues SET active=0,result='done',pull=77 WHERE issue=?",
    )
    .run(repair.number);
  f.db
    .prepare(
      "INSERT INTO deliveries VALUES (?,'repair-delivery','started','https://claude.ai/code/session_repair')",
    )
    .run(repair.number);
  await schedule();
  assert.equal(queues, 1);
  assert.equal(verifierFires, 0);
  assert.equal(
    f.db
      .prepare("SELECT session FROM deliveries WHERE issue=?")
      .get(recheck.number).session,
    "https://claude.ai/code/session_original",
  );
  f.commentMap.get(recheck.number).push({
    id: 900,
    user: { login: "lead" },
    body: "Vizor result: done\nhttps://github.com/owner/repo/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/artifact.md",
  });
  await schedule();
  assert.equal(
    f.db
      .prepare("SELECT accepted FROM scheduled_issues WHERE issue=?")
      .get(recheck.number).accepted,
    1,
  );
  await dispatch(recheck.number, randomUUID());
  assert.equal(queues, 1);
});

test(
  "Claude subscription investigator binds its session, saves only structured output and classifies usage pauses",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const mode of ["success", "usage", "wrong-session"]) {
      const directory = mkdtempSync(join(tmpdir(), "vizor-claude-protocol-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const fake = join(directory, "fake-claude");
      // A portable stand-in for the installed CLI's documented stream-json events.
      writeFileSync(
        fake,
        `#!${process.execPath}
const args=process.argv.slice(2);
const at=args.indexOf('--session-id');
const id=${mode === "wrong-session" ? "'99999999-9999-9999-9999-999999999999'" : "args[at+1]"};
if(!args.includes('--tools')||args[args.indexOf('--tools')+1]!==''||!args.includes('--strict-mcp-config'))process.exit(9);
console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
${
  mode === "usage"
    ? "console.log(JSON.stringify({type:'result',is_error:true,session_id:id,result:\"You've hit your usage limit\"}));process.exitCode=1;"
    : "console.log(JSON.stringify({type:'result',is_error:false,session_id:id,structured_output:{action:'external',summary:'s',nextStep:'n',evidence:['1'],externalRequirements:[]}}));"
}`,
        { mode: 0o755 },
      );
      atomicJson(join(directory, "request.json"), {
        provider: "claude",
        executable: fake,
        prompt: "classify",
        timeoutMs: 5000,
        attempt: 0,
      });
      await supervise(directory);
      const status = JSON.parse(readFileSync(join(directory, "status.json")));
      assert.equal(status.provider, "claude");
      if (mode === "success") {
        assert.equal(status.state, "completed");
        assert.match(status.session, /^[0-9a-f-]{36}$/);
        assert.equal(
          JSON.parse(readFileSync(join(directory, "decision.json"))).action,
          "external",
        );
      } else if (mode === "usage") {
        assert.equal(status.state, "usage_paused");
        assert.ok(status.retryAt > Date.now());
      } else {
        // Output from any other session is never accepted as this run's decision.
        assert.equal(status.state, "uncertain");
        assert.equal(status.session, null);
      }
    }
  },
);

test("investigator routine: one fire, decision found by token from a trusted login, validated and routed like a local run", async (t) => {
  const f = fixture(t);
  f.host.provider = "routine";
  f.host.timeoutMs = 600000;
  delete f.host.executable;
  const secretFile = join(f.root, "secrets.json");
  writeFileSync(
    secretFile,
    JSON.stringify({
      orchestrator: {
        fireUrl:
          "https://api.anthropic.com/v1/claude_code/routines/trig_investigator/fire",
        token: "synthetic",
      },
    }),
  );
  const fires = [];
  let launches = 0;
  // Real request/token writer and real fire, with the provider stubbed.
  const launch = ({ root, run, host, packet }) => {
    launches++;
    const directory = runDirectory(root, run);
    mkdirSync(directory, { recursive: true });
    startRoutineInvestigation({
      directory,
      run,
      packet,
      host,
      secretFile,
      launch: () => ({ on() {}, unref() {} }),
    });
  };
  const tick = () => f.tick({ launch });
  f.record();
  tick();
  assert.equal(launches, 1);
  let run = f.runs()[0];
  assert.equal(run.state, "launching");
  const directory = runDirectory(f.root, run);
  const request = JSON.parse(
    readFileSync(join(directory, "request.json"), "utf8"),
  );
  assert.match(request.text, /owner\/repo#25/);
  assert.match(request.text, new RegExp("Run token: " + request.token));
  await fireRoutine(directory, {
    fire: async (url, options) => {
      fires.push([url, JSON.parse(options.body).text]);
      return Response.json({ claude_code_session_id: "session_investigator1" });
    },
  });
  tick();
  run = f.runs()[0];
  assert.equal(run.state, "running");
  assert.equal(run.session, "https://claude.ai/code/session_investigator1");
  tick();
  assert.equal(launches, 1, "never fired twice");
  // Decisions with the wrong token or from an untrusted login are ignored.
  const decisionBody = (token) =>
    "## Vizor investigation\n\nOwner already decided.\n\nVizor investigation: " +
    token +
    "\n\n```json\n" +
    JSON.stringify({
      action: "return",
      summary: "Recorded owner decision resolves it.",
      nextStep: "Continue approved work.",
      evidence: ["12"],
      externalRequirements: [],
    }) +
    "\n```";
  f.commentMap.get(25).push(
    { id: 40, user: { login: "lead" }, body: decisionBody(randomUUID()) },
    {
      id: 41,
      user: { login: "stranger" },
      body: decisionBody(request.token),
    },
  );
  tick();
  assert.equal(f.runs()[0].state, "running");
  f.commentMap.get(25).push({
    id: 42,
    user: { login: "lead" },
    body: decisionBody(request.token),
  });
  tick();
  tick();
  run = f.runs()[0];
  assert.equal(run.state, "returned");
  assert.equal(JSON.parse(run.decision).action, "return");
  assert.equal(
    f.issues.length,
    2,
    "one linked follow-up for the original worker",
  );
  assert.equal(fires.length, 1);
  assert.ok(
    blockerSnapshot(f.db).activity.some((a) =>
      /Investigator routine posted its decision/.test(a.detail),
    ),
  );
});

test("investigator routine: rejected, unconfirmed, malformed and late runs are reported and never re-fired", async (t) => {
  for (const scenario of ["rejected", "no-status", "malformed", "timeout"]) {
    const f = fixture(t);
    f.host.provider = "routine";
    f.host.timeoutMs = 1000;
    let launches = 0;
    const launch = ({ root, run, host, packet }) => {
      launches++;
      const directory = runDirectory(root, run);
      mkdirSync(directory, { recursive: true });
      startRoutineInvestigation({
        directory,
        run,
        packet,
        host,
        secretFile: join(f.root, "none.json"),
        launch: () => ({ on() {}, unref() {} }),
      });
    };
    f.record();
    f.tick({ launch });
    const run = f.runs()[0];
    const directory = runDirectory(f.root, run);
    const request = JSON.parse(
      readFileSync(join(directory, "request.json"), "utf8"),
    );
    if (scenario === "rejected") await fireRoutine(directory); // no credentials -> rejected
    if (scenario === "malformed" || scenario === "timeout")
      atomicJson(join(directory, "status.json"), {
        provider: "routine",
        state: "running",
        session: "https://claude.ai/code/session_x",
        at: scenario === "timeout" ? Date.now() - 5000 : Date.now(),
      });
    if (scenario === "malformed")
      f.commentMap.get(25).push({
        id: 50,
        user: { login: "lead" },
        body:
          "Vizor investigation: " + request.token + "\n```json\n{not json\n```",
      });
    const later = scenario === "no-status" ? Date.now() + 120000 : Date.now();
    f.tick({ launch, now: later });
    f.tick({ launch, now: later });
    assert.equal(
      f.runs()[0].state,
      scenario === "timeout" ? "timeout" : "uncertain",
      scenario,
    );
    assert.equal(launches, 1, scenario + " never re-fired");
  }
});

test("routine decision parsing requires the exact token, a trusted login and a JSON block", () => {
  const token = randomUUID();
  const body = (
    t,
    json = '{"action":"external","summary":"s","nextStep":"n","evidence":["1"],"externalRequirements":["budget"]}',
  ) => "Vizor investigation: " + t + "\n```json\n" + json + "\n```";
  const pick = (comments) =>
    findRoutineDecision({
      comments,
      token,
      trustedManagers: ["Lead"],
      after: "5",
    });
  assert.equal(
    pick([{ id: 9, user: { login: "lead" }, body: body(token) }]).action,
    "external",
  );
  assert.equal(
    pick([{ id: 4, user: { login: "lead" }, body: body(token) }]),
    null,
    "before the blocker",
  );
  assert.equal(
    pick([{ id: 9, user: { login: "other" }, body: body(token) }]),
    null,
  );
  assert.equal(
    pick([{ id: 9, user: { login: "lead" }, body: body(randomUUID()) }]),
    null,
  );
  assert.throws(
    () =>
      pick([
        {
          id: 9,
          user: { login: "lead" },
          body: "Vizor investigation: " + token,
        },
      ]),
    /no JSON block/,
  );
});
