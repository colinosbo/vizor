import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { beforeAll, afterAll, expect, it } from "vitest";
import { taskBrief, taskInput } from "../scripts/task-queue.mjs";

const folder = mkdtempSync(join(tmpdir(), "vizor-project-queue-"));
const key = () => randomBytes(32).toString("hex");
const owner = key(),
  worker = key(),
  password = key(),
  oldManagerKey = key();
const oldManagerId = randomUUID();
const admin = "Basic " + Buffer.from(`owner:${password}`).toString("base64");
const origin = "http://127.0.0.1:4387";
let relay: ChildProcess, url: string, webhookUrl: string;
async function start(
  port = 0,
  webhook?: Record<string, string>,
  advanceMs = 0,
) {
  const args = ["scripts/shared-relay.mjs"];
  if (advanceMs) {
    const clock = join(folder, "advance-clock.cjs");
    writeFileSync(
      clock,
      "const now = Date.now; Date.now = () => now() + " + advanceMs,
    );
    args.unshift("--require", clock);
  }
  relay = spawn(process.execPath, args, {
    windowsHide: true,
    env: {
      ...process.env,
      VIZOR_SHARED_OWNER_KEY: owner,
      VIZOR_SHARED_WORKER_KEY: worker,
      VIZOR_DASHBOARD_PASSWORD: password,
      VIZOR_DASHBOARD_ORIGIN: origin,
      VIZOR_SHARED_DB: join(folder, "relay.db"),
      VIZOR_SHARED_PORT: String(port),
      ...webhook,
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Relay startup timed out")),
      5000,
    );
    relay.once("error", reject);
    relay.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Relay exited"));
    });
    let output = "";
    relay.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const match = /relay is listening on port (\d+)/.exec(output);
      const hook = /webhook is listening on port (\d+)/.exec(output);
      if (!match || (webhook && !hook)) return;
      clearTimeout(timer);
      url = `http://127.0.0.1:${match[1]}`;
      if (hook) webhookUrl = `http://127.0.0.1:${hook[1]}`;
      resolve();
    });
  });
}
async function stop() {
  if (relay.exitCode !== null || relay.signalCode) return;
  const stopped = once(relay, "exit");
  relay.kill();
  await stopped;
}
beforeAll(async () => {
  const db = new Database(join(folder, "relay.db"));
  db.exec(`CREATE TABLE event (id TEXT PRIMARY KEY, role TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE shared_agent (id TEXT PRIMARY KEY, name TEXT NOT NULL, participant TEXT NOT NULL, preset TEXT NOT NULL, instructions TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE shared_manager (singleton INTEGER PRIMARY KEY CHECK(singleton=1), agent_id TEXT NOT NULL);`);
  db.prepare("INSERT INTO event (id, role, body) VALUES (?, 'owner', ?)").run(
    randomUUID(),
    JSON.stringify({
      kind: "approve",
      text: "Existing approved scope.",
      paths: [],
      waitForReview: true,
    }),
  );
  db.prepare(
    "INSERT INTO shared_agent (id, name, participant, preset, instructions, token_hash) VALUES (?, 'Existing manager', 'Colin', 'orchestrator', '', ?)",
  ).run(
    oldManagerId,
    createHash("sha256")
      .update("Bearer " + oldManagerKey)
      .digest("hex"),
  );
  db.prepare("INSERT INTO shared_manager VALUES (1, ?)").run(oldManagerId);
  db.close();
  await start();
});
afterAll(() => stop());
const headers = (auth: string, project = "default") => ({
  Authorization: auth,
  "X-Vizor-Project": project,
  Origin: origin,
  "Content-Type": "application/json",
});
const post = (path: string, auth: string, body: unknown, project = "default") =>
  fetch(url + path, {
    method: "POST",
    headers: headers(auth, project),
    body: JSON.stringify(body),
  });
const state = (token: string, project = "default") =>
  fetch(url + "/v1/project", {
    headers: headers("Bearer " + token, project),
  }).then((response) => response.json());
const send = (
  token: string,
  project: string,
  action: object,
  id = randomUUID(),
) => post("/v1/project", "Bearer " + token, { id, action }, project);

it("dispatches only the configured signed GitHub issue and preserves one assignment across restart", async () => {
  const register = async (preset: string) => {
    const response = await post("/dashboard/agents", admin, {
      name: `Webhook ${preset}`,
      participant: "Colin",
      preset,
    });
    expect(response.status).toBe(201);
    return response.json();
  };
  const manager = await register("orchestrator");
  const developer = await register("developer");
  const created = await post("/dashboard/projects", admin, {
    name: "Webhook pilot",
    goal: "Approve one linked documentation change.",
    repository: "example/repository",
    paths: ["README.md"],
    managerId: manager.agent.id,
    agentIds: [manager.agent.id, developer.agent.id],
  });
  expect(created.status).toBe(201);
  const { project } = await created.json();
  const taskId = randomUUID();
  const current = await state(manager.key, project.id);
  expect(
    (
      await send(
        manager.key,
        project.id,
        {
          kind: "task_create",
          basis: current.latest.id,
          title: "Document the workflow",
          description: "Update the documentation.",
          acceptance: "The workflow is described.",
          paths: ["README.md"],
          references: ["https://github.com/example/repository/issues/7"],
        },
        taskId,
      )
    ).status,
  ).toBe(200);
  const secret = key();
  const settings = {
    VIZOR_GITHUB_WEBHOOK_PORT: "0",
    VIZOR_GITHUB_WEBHOOK_SECRET: secret,
    VIZOR_GITHUB_PROJECT_ID: project.id,
    VIZOR_GITHUB_TASK_ID: taskId,
    VIZOR_GITHUB_AGENT_ID: developer.agent.id,
  };
  await stop();
  await start(0, settings);
  const deliver = (issue: number, signingKey = secret) => {
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "vizor:dispatch" },
      repository: { full_name: "example/repository" },
      issue: { number: issue, state: "open" },
    });
    return fetch(webhookUrl + "/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "X-GitHub-Event": "issues",
        "X-Hub-Signature-256":
          "sha256=" +
          createHmac("sha256", signingKey).update(body).digest("hex"),
      },
    });
  };
  expect((await fetch(webhookUrl + "/dashboard/project")).status).toBe(404);
  expect((await deliver(7, key())).status).toBe(401);
  expect(await (await deliver(8)).json()).toEqual({ ignored: true });
  expect((await state(manager.key, project.id)).queue[0].status).toBe("queued");
  const dispatched = await deliver(7);
  expect(dispatched.status).toBe(202);
  const { dispatchId } = await dispatched.json();
  expect((await state(developer.key, project.id)).turn.id).toBe(dispatchId);
  const runnerId = randomUUID();
  const turn = { turnId: dispatchId, runnerId };
  const retryAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  expect(
    (await send(developer.key, project.id, { kind: "claim", ...turn })).status,
  ).toBe(200);
  expect(
    (await send(developer.key, project.id, { kind: "work_start", ...turn }))
      .status,
  ).toBe(200);
  expect(
    (
      await send(developer.key, project.id, {
        kind: "usage_wait",
        ...turn,
        runnerId: randomUUID(),
        retryAt,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send(developer.key, project.id, {
        kind: "usage_wait",
        ...turn,
        retryAt,
      })
    ).status,
  ).toBe(200);
  await stop();
  await start(0, settings);
  expect(
    (await send(developer.key, project.id, { kind: "work_start", ...turn }))
      .status,
  ).toBe(409);
  expect(await (await deliver(7)).json()).toEqual({
    duplicate: true,
    dispatchId,
  });
  const view = await fetch(url + "/dashboard/project", {
    headers: headers(admin, project.id),
  }).then((response) => response.json());
  expect(
    view.events.filter((event: { kind: string }) => event.kind === "assign"),
  ).toHaveLength(1);
  expect(view.queue[0]).toMatchObject({
    status: "assigned",
    assignee: developer.agent.id,
    retryAt,
  });
  await stop();
  await start(0, settings, 3 * 60 * 60 * 1000 + 1000);
  expect(
    (await send(developer.key, project.id, { kind: "work_start", ...turn }))
      .status,
  ).toBe(200);
  const resumed = (await state(manager.key, project.id)).queue[0];
  expect(resumed).toMatchObject({
    status: "working",
    executionId: dispatchId,
    attempts: 1,
  });
  expect(resumed.retryAt).toBeUndefined();
  await stop();
  await start();
});

it.each([
  { acknowledged: true, backupEnabled: true },
  { acknowledged: false, backupEnabled: true },
  { acknowledged: false, backupEnabled: false },
])(
  "only transfers an unacknowledged assignment to a configured backup ($acknowledged, $backupEnabled)",
  async ({ acknowledged, backupEnabled }) => {
    async function register(name: string, preset: string) {
      const response = await post("/dashboard/agents", admin, {
        name,
        participant: "Pilot",
        preset,
      });
      expect(response.status).toBe(201);
      return response.json();
    }
    const manager = await register("Deadline manager", "orchestrator");
    const primary = await register("Primary worker", "developer");
    const backup = await register("Backup worker", "developer");
    const created = await post("/dashboard/projects", admin, {
      name: "Acknowledgement deadline pilot",
      goal: "Approve one documentation change.",
      repository: "example/repository",
      paths: ["README.md"],
      managerId: manager.agent.id,
      agentIds: [manager.agent.id, primary.agent.id, backup.agent.id],
    });
    expect(created.status).toBe(201);
    const project = (await created.json()).project.id;
    const taskId = randomUUID();
    const issue = "https://github.com/example/repository/issues/15";
    expect(
      (
        await send(
          manager.key,
          project,
          {
            kind: "task_create",
            basis: (await state(manager.key, project)).latest.id,
            title: "Document acknowledgement",
            description: "Clarify the handoff.",
            acceptance: "The approved documentation is updated.",
            paths: ["README.md"],
            references: [issue],
          },
          taskId,
        )
      ).status,
    ).toBe(200);
    const secret = key();
    const settings = {
      VIZOR_GITHUB_WEBHOOK_PORT: "0",
      VIZOR_GITHUB_WEBHOOK_SECRET: secret,
      VIZOR_GITHUB_PROJECT_ID: project,
      VIZOR_GITHUB_TASK_ID: taskId,
      VIZOR_GITHUB_AGENT_ID: primary.agent.id,
      ...(backupEnabled
        ? { VIZOR_GITHUB_BACKUP_AGENT_ID: backup.agent.id }
        : {}),
    };
    await stop();
    await start(0, settings);
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "vizor:dispatch" },
      repository: { full_name: "example/repository" },
      issue: { number: 15, state: "open" },
    });
    const deliver = () =>
      fetch(webhookUrl + "/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-GitHub-Event": "issues",
          "X-Hub-Signature-256":
            "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
        },
      });
    const accepted = await deliver();
    expect(accepted.status).toBe(202);
    const { dispatchId } = await accepted.json();
    const assignment = (await state(primary.key, project)).task;
    expect(assignment.id).toBe(dispatchId);
    if (backupEnabled) {
      const remaining = Date.parse(assignment.ackDeadline) - Date.now();
      expect(remaining).toBeGreaterThan(14 * 60 * 1000);
      expect(remaining).toBeLessThanOrEqual(15 * 60 * 1000);
    } else {
      expect(assignment.ackDeadline).toBeUndefined();
    }
    expect((await state(backup.key, project)).task).toBeNull();
    const runnerId = randomUUID();
    if (acknowledged)
      expect(
        (
          await send(primary.key, project, {
            kind: "claim",
            turnId: dispatchId,
            runnerId,
          })
        ).status,
      ).toBe(200);
    await stop();
    await start(0, undefined, 15 * 60 * 1000 + 1000);
    if (acknowledged || !backupEnabled) {
      expect((await state(primary.key, project)).task.id).toBe(dispatchId);
      if (!acknowledged)
        expect(
          (
            await send(primary.key, project, {
              kind: "claim",
              turnId: dispatchId,
              runnerId,
            })
          ).status,
        ).toBe(200);
      expect((await state(backup.key, project)).task).toBeNull();
      expect(
        (
          await send(primary.key, project, {
            kind: "work_start",
            turnId: dispatchId,
            runnerId,
          })
        ).status,
      ).toBe(200);
    } else {
      expect((await state(primary.key, project)).task).toBeNull();
      expect(
        (
          await send(primary.key, project, {
            kind: "claim",
            turnId: dispatchId,
            runnerId,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await send(primary.key, project, {
            kind: "work_start",
            turnId: dispatchId,
            runnerId,
          })
        ).status,
      ).toBe(409);
      const replacement = (await state(backup.key, project)).task;
      expect(replacement).toMatchObject({
        queuedTaskId: taskId,
        replaces: dispatchId,
        source: "backup",
      });
      const backupTurn = { turnId: replacement.id, runnerId: randomUUID() };
      expect(
        (await send(primary.key, project, { kind: "claim", ...backupTurn }))
          .status,
      ).toBe(409);
      expect(
        (await send(backup.key, project, { kind: "claim", ...backupTurn }))
          .status,
      ).toBe(200);
      expect(
        (await send(backup.key, project, { kind: "work_start", ...backupTurn }))
          .status,
      ).toBe(200);
    }
    const result = await state(manager.key, project);
    expect(result.tasks).toHaveLength(1);
    expect(result.queue[0]).toMatchObject({
      id: taskId,
      status: "working",
      assignee: (acknowledged || !backupEnabled ? primary : backup).agent.id,
    });
    expect(
      result.events.filter(
        (event: { kind: string }) => event.kind === "work_start",
      ),
    ).toHaveLength(1);
    await stop();
    await start(0, settings, 15 * 60 * 1000 + 1000);
    expect(await (await deliver()).json()).toEqual({
      duplicate: true,
      dispatchId,
    });
    expect((await state(manager.key, project)).tasks).toHaveLength(1);
    await stop();
    await start();
  },
);

it("migrates existing state and runs an isolated project queue through dependencies, review and retry", async () => {
  const original = await state(oldManagerKey);
  expect(original.plan.text).toBe("Existing approved scope.");
  expect(original.managerId).toBe(oldManagerId);
  const register = async (name: string, preset: string) => {
    const response = await post("/dashboard/agents", admin, {
      name,
      participant: name,
      preset,
    });
    expect(response.status).toBe(201);
    return response.json();
  };
  const manager = await register("Gavin", "orchestrator");
  const first = await register("Stephen One", "developer");
  const second = await register("Stephen Two", "developer");
  const outsider = await register("Outside worker", "developer");
  const create = async (name: string) => {
    const payload = {
      requestId: randomUUID(),
      name,
      goal: "Fix and verify the production defaults.",
      repository: "example/repository",
      paths: ["src/a.ts", "src/b.ts"],
      managerId: manager.agent.id,
      agentIds: [manager.agent.id, first.agent.id, second.agent.id],
    };
    const response = await post("/dashboard/projects", admin, payload);
    expect(response.status).toBe(201);
    const id = (await response.json()).project.id;
    const retried = await post("/dashboard/projects", admin, payload);
    expect(retried.status).toBe(200);
    expect((await retried.json()).project.id).toBe(id);
    expect(
      (
        await post("/dashboard/projects", admin, {
          ...payload,
          name: "Different project",
        })
      ).status,
    ).toBe(409);
    return id;
  };
  const project = await create("Production fixes");
  const another = await create("Separate project");
  expect((await state(manager.key, project)).project.name).toBe(
    "Production fixes",
  );
  expect((await state(oldManagerKey)).plan.text).toBe(
    "Existing approved scope.",
  );
  expect(
    (
      await fetch(url + "/v1/project", {
        headers: headers("Bearer " + outsider.key, project),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(url + "/v1/project", {
        headers: headers("Bearer " + worker, project),
      })
    ).status,
  ).toBe(403);
  const metadata = {
    title: "Fix A",
    description: "Repair the production default.",
    acceptance: "Old values still work and the new default is correct.",
    paths: ["src/a.ts"],
    dependencies: [],
    references: ["https://github.com/example/repository/pull/12"],
  };
  const basis = (await state(manager.key, project)).latest.id;
  expect(
    (
      await send(first.key, project, {
        kind: "task_create",
        basis,
        ...metadata,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send(manager.key, project, {
        kind: "task_create",
        basis,
        ...metadata,
        paths: ["src/outside.ts"],
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send(manager.key, project, {
        kind: "task_create",
        basis,
        ...metadata,
        dependencies: [randomUUID()],
      })
    ).status,
  ).toBe(409);
  const firstId = randomUUID();
  const createAction = { kind: "task_create", basis, ...metadata };
  expect((await send(manager.key, project, createAction, firstId)).status).toBe(
    200,
  );
  expect((await send(manager.key, project, createAction, firstId)).status).toBe(
    200,
  );
  expect((await send(manager.key, another, createAction, firstId)).status).toBe(
    409,
  );
  expect((await state(manager.key, project)).queue).toHaveLength(1);
  const secondId = randomUUID();
  expect(
    (
      await send(
        manager.key,
        project,
        {
          kind: "task_create",
          basis: firstId,
          ...metadata,
          title: "Fix B",
          paths: ["src/b.ts"],
          dependencies: [firstId],
        },
        secondId,
      )
    ).status,
  ).toBe(200);
  const assign = async (taskId: string, agentId: string) => {
    const current = await state(manager.key, project);
    const task = current.queue.find(
      (item: { id: string }) => item.id === taskId,
    );
    return send(manager.key, project, {
      kind: "assign",
      basis: current.latest.id,
      queuedTaskId: taskId,
      agentId,
      text: taskBrief(task),
      paths: task.paths,
    });
  };
  expect((await assign(secondId, second.agent.id)).status).toBe(409);
  expect((await assign(firstId, first.agent.id)).status).toBe(200);
  const execution = (await state(first.key, project)).task;
  const runnerId = randomUUID();
  expect(
    (
      await send(first.key, project, {
        kind: "claim",
        turnId: execution.id,
        runnerId,
      })
    ).status,
  ).toBe(200);
  expect((await state(manager.key, project)).queue[0].status).toBe(
    "acknowledged",
  );
  expect(
    (
      await send(first.key, project, {
        kind: "work_start",
        turnId: execution.id,
        runnerId,
      })
    ).status,
  ).toBe(200);
  expect((await state(manager.key, project)).queue[0].status).toBe("working");
  expect((await state(manager.key, another)).queue).toEqual([]);
  expect(
    (
      await post(
        "/dashboard/remove-member",
        admin,
        { agentId: first.agent.id },
        project,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await post(
        "/dashboard/remove-member",
        admin,
        { agentId: manager.agent.id },
        another,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await post(
        "/dashboard/remove-member",
        admin,
        { agentId: first.agent.id },
        another,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(url + "/v1/project", {
        headers: headers("Bearer " + first.key, another),
      })
    ).status,
  ).toBe(403);
  expect((await state(first.key, project)).task.id).toBe(execution.id);
  expect(
    (
      await post(
        "/dashboard/members",
        admin,
        { agentIds: [first.agent.id] },
        another,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/dashboard/revoke-agent",
        admin,
        { agentId: first.agent.id },
        another,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await send(first.key, project, {
        kind: "report",
        turnId: execution.id,
        runnerId,
        outcome: "completed",
        text: "Changed A. The supplied check passed.",
        needsReply: false,
      })
    ).status,
  ).toBe(200);
  expect((await state(manager.key, project)).queue[0].status).toBe("review");
  expect((await assign(secondId, second.agent.id)).status).toBe(409);
  expect(
    (
      await send(first.key, project, {
        kind: "task_accept",
        taskId: firstId,
        basis: (await state(manager.key, project)).latest.id,
        text: "Worker self-approval",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send(manager.key, project, {
        kind: "task_accept",
        taskId: firstId,
        basis: (await state(manager.key, project)).latest.id,
        text: "The reported evidence satisfies the acceptance criteria.",
      })
    ).status,
  ).toBe(200);
  expect((await assign(secondId, second.agent.id)).status).toBe(200);
  const secondExecution = (await state(second.key, project)).task;
  const secondRunner = randomUUID();
  await send(second.key, project, {
    kind: "claim",
    turnId: secondExecution.id,
    runnerId: secondRunner,
  });
  await send(second.key, project, {
    kind: "report",
    turnId: secondExecution.id,
    runnerId: secondRunner,
    outcome: "blocked",
    text: "Need the existing default clarified.",
    needsReply: true,
  });
  const question = (await state(manager.key, project)).latest;
  expect(
    (
      await send(manager.key, project, {
        kind: "task_retry",
        taskId: secondId,
        basis: question.id,
        text: "Retry before answering",
      })
    ).status,
  ).toBe(409);
  await stop();
  await start();
  const clarification = {
    kind: "reply",
    turnId: question.id,
    basis: question.id,
    text: "Preserve the documented default.",
  };
  expect(
    (
      await post(
        "/dashboard/project",
        admin,
        { id: randomUUID(), action: clarification },
        project,
      )
    ).status,
  ).toBe(200);
  expect((await send(manager.key, project, clarification)).status).toBe(409);
  const answer = (await state(second.key, project)).turn;
  await send(second.key, project, {
    kind: "claim",
    turnId: answer.id,
    runnerId: secondRunner,
  });
  await send(second.key, project, {
    kind: "report",
    turnId: answer.id,
    runnerId: secondRunner,
    outcome: "failed",
    text: "The file changed before the edit could apply.",
    needsReply: false,
  });
  const port = Number(new URL(url).port);
  await stop();
  await start(port);
  const blocked = await state(manager.key, project);
  expect(blocked.queue.map((task: { status: string }) => task.status)).toEqual([
    "complete",
    "blocked",
  ]);
  expect(
    (
      await send(manager.key, project, {
        kind: "complete",
        basis: blocked.latest.id,
        text: "Finish with unfinished tasks",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send(manager.key, project, {
        kind: "task_retry",
        taskId: secondId,
        basis: blocked.latest.id,
        text: "Read the current source and preserve unrelated edits.",
      })
    ).status,
  ).toBe(200);
  expect((await assign(secondId, second.agent.id)).status).toBe(200);
  const retried = await state(second.key, project);
  expect(retried.task.text).toContain("Read the current source");
  expect(retried.queue[1].attempts).toBe(2);
  await send(second.key, project, {
    kind: "claim",
    turnId: retried.task.id,
    runnerId: secondRunner,
  });
  await send(second.key, project, {
    kind: "report",
    turnId: retried.task.id,
    runnerId: secondRunner,
    outcome: "completed",
    text: "B fixed and checked.",
    needsReply: false,
  });
  await send(manager.key, project, {
    kind: "task_accept",
    taskId: secondId,
    basis: (await state(manager.key, project)).latest.id,
    text: "Reviewed B against the saved criteria.",
  });
  expect(
    (
      await send(manager.key, project, {
        kind: "complete",
        basis: (await state(manager.key, project)).latest.id,
        text: "Both accepted tasks are complete.",
      })
    ).status,
  ).toBe(200);
  expect((await state(manager.key, project)).completed).toBe(true);
  expect((await state(manager.key, another)).completed).toBe(false);
  const projectOnly = await post(
    "/dashboard/agents",
    admin,
    { name: "Project-only reviewer", participant: "Gavin", preset: "reviewer" },
    another,
  );
  const isolated = await projectOnly.json();
  expect(
    (
      await fetch(url + "/v1/project", {
        headers: headers("Bearer " + isolated.key),
      })
    ).status,
  ).toBe(403);
  await stop();
  await start(Number(new URL(url).port));
  expect(
    (
      await fetch(url + "/v1/project", {
        headers: headers("Bearer " + isolated.key),
      })
    ).status,
  ).toBe(403);
  expect((await state(isolated.key, another)).agent.id).toBe(isolated.agent.id);
});

it("saves an approved document, wakes only its project, and preserves idempotent uploads across restart", async () => {
  const manager = await (
    await post("/dashboard/agents", admin, {
      name: "Document manager",
      participant: "Colin",
      preset: "orchestrator",
    })
  ).json();
  const developer = await (
    await post("/dashboard/agents", admin, {
      name: "Document worker",
      participant: "Stephen",
      preset: "developer",
    })
  ).json();
  const created = await post("/dashboard/projects", admin, {
    name: "Document project",
    goal: "Fix production defaults",
    repository: "example/repo",
    paths: ["src/default.ts"],
    managerId: manager.agent.id,
    agentIds: [manager.agent.id, developer.agent.id],
    document: { name: "Initial.md", content: "Initial requirements" },
  });
  expect(created.status).toBe(201);
  const project = (await created.json()).project.id;
  expect((await state(manager.key, project)).project.document.content).toBe(
    "Initial requirements",
  );
  const before = (await state(oldManagerKey)).latest.id;
  const payload = {
    requestId: randomUUID(),
    document: {
      name: "Requirements.md",
      content:
        "Fix the default value. Validate it and request a read-only review.",
    },
  };
  expect(
    (
      await post(
        "/dashboard/document",
        "Bearer " + developer.key,
        payload,
        project,
      )
    ).status,
  ).toBe(401);
  expect(
    (await post("/dashboard/document", admin, payload, project)).status,
  ).toBe(200);
  expect(
    (await post("/dashboard/document", admin, payload, project)).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/dashboard/document",
        admin,
        { ...payload, document: { ...payload.document, content: "Changed" } },
        project,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await post(
        "/dashboard/document",
        admin,
        {
          requestId: randomUUID(),
          document: { name: "Too long", content: "x".repeat(20001) },
        },
        project,
      )
    ).status,
  ).toBe(400);
  const updated = await state(manager.key, project);
  expect(updated.latest.kind).toBe("project_document");
  expect(
    updated.events.filter(
      (event: { kind: string }) => event.kind === "project_document",
    ),
  ).toHaveLength(1);
  expect(updated.plan.paths).toEqual(["src/default.ts"]);
  expect((await state(oldManagerKey)).latest.id).toBe(before);
  const port = Number(new URL(url).port);
  await stop();
  await start(port);
  expect((await state(manager.key, project)).project.document).toEqual(
    payload.document,
  );
});

it("keeps the largest accepted task and retry direction within the assignment size limit", () => {
  const task = taskInput.parse({
    title: "T".repeat(160),
    description: "D".repeat(3000),
    acceptance: "A".repeat(1500),
    paths: [],
    dependencies: [],
    references: Array(6).fill(
      "https://github.com/example/repo/pull/12?x=" + "a".repeat(250),
    ),
  });
  expect(
    taskBrief({ ...task, id: randomUUID(), managerNote: "R".repeat(1000) })
      .length,
  ).toBeLessThanOrEqual(8000);
});

it("pins publication to a human-approved handoff and returns the PR to manager review", async () => {
  const add = async (name: string, preset: string) =>
    await (
      await post("/dashboard/agents", admin, {
        name,
        participant: name,
        preset,
      })
    ).json();
  const manager = await add("PR Manager", "orchestrator"),
    coder = await add("PR Worker", "developer");
  const created = await post("/dashboard/projects", admin, {
    name: "PR handoff",
    goal: "Fix the two production files.",
    repository: "example/repository",
    paths: ["src/a.ts", "src/b.ts"],
    managerId: manager.agent.id,
    agentIds: [manager.agent.id, coder.agent.id],
  });
  const project = (await created.json()).project.id;
  const metadata = {
    title: "Fix both defaults",
    description: "Apply the approved fix.",
    acceptance: "Provide the tested PR for review.",
    paths: ["src/a.ts", "src/b.ts"],
    dependencies: [],
    references: [],
    checks: ["diff"],
  };
  const taskId = randomUUID();
  await send(
    manager.key,
    project,
    {
      kind: "task_create",
      basis: (await state(manager.key, project)).latest.id,
      ...metadata,
    },
    taskId,
  );
  const queued = (await state(manager.key, project)).queue[0];
  await send(manager.key, project, {
    kind: "assign",
    basis: taskId,
    queuedTaskId: taskId,
    agentId: coder.agent.id,
    text: taskBrief(queued),
    paths: metadata.paths,
  });
  const execution = (await state(coder.key, project)).task;
  const runnerId = randomUUID();
  await send(coder.key, project, {
    kind: "claim",
    turnId: execution.id,
    runnerId,
  });
  const handoff = {
    repository: "example/repository",
    branch: "codex/vizor-" + randomUUID(),
    head: "a".repeat(40),
    base: "main",
    baseHead: "b".repeat(40),
    title: metadata.title,
    files: metadata.paths,
    checks: ["git diff --check exited 0."],
  };
  const report = {
    kind: "report",
    turnId: execution.id,
    runnerId,
    outcome: "completed",
    text: "Prepared the local commit and check evidence.",
    needsReply: false,
    handoff,
  };
  expect(
    (
      await send(coder.key, project, {
        ...report,
        handoff: { ...handoff, files: ["src/outside.ts"] },
      })
    ).status,
  ).toBe(409);
  expect((await send(coder.key, project, report)).status).toBe(200);
  const prepared = await state(manager.key, project);
  expect(prepared.tasks).toHaveLength(1);
  expect(
    (
      await send(manager.key, project, {
        kind: "task_accept",
        basis: prepared.latest.id,
        taskId,
        text: "Accept before publication",
      })
    ).status,
  ).toBe(409);
  const approval = {
    kind: "publish_approve",
    basis: prepared.latest.id,
    turnId: prepared.turn.id,
    head: handoff.head,
  };
  expect((await send(manager.key, project, approval)).status).toBe(409);
  expect(
    (
      await post(
        "/dashboard/project",
        admin,
        { id: randomUUID(), action: { ...approval, head: "c".repeat(40) } },
        project,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await post(
        "/dashboard/project",
        admin,
        { id: randomUUID(), action: approval },
        project,
      )
    ).status,
  ).toBe(200);
  const approved = (await state(coder.key, project)).turn;
  expect(approved.kind).toBe("publish_approve");
  expect(approved.handoff.head).toBe(handoff.head);
  await send(coder.key, project, {
    kind: "claim",
    turnId: approved.id,
    runnerId,
  });
  expect(
    (
      await send(coder.key, project, {
        kind: "publish_wait",
        turnId: approved.id,
        runnerId,
        text: "GitHub is temporarily unavailable. Retrying the saved approval.",
      })
    ).status,
  ).toBe(200);
  const port = Number(new URL(url).port);
  await stop();
  await start(port);
  expect((await state(coder.key, project)).turn.id).toBe(approved.id);
  const published = {
    ...report,
    turnId: approved.id,
    text: "PR ready for review.",
    handoff: {
      ...handoff,
      prUrl: "https://github.com/example/repository/pull/42",
    },
  };
  expect(
    (
      await send(coder.key, project, {
        ...published,
        handoff: { ...published.handoff, base: "other" },
      })
    ).status,
  ).toBe(409);
  expect((await send(coder.key, project, published)).status).toBe(200);
  const final = await state(manager.key, project);
  expect(final.tasks).toHaveLength(0);
  expect(final.queue[0].handoff.prUrl).toContain("/pull/42");
  expect(
    (
      await send(manager.key, project, {
        kind: "task_accept",
        basis: final.latest.id,
        taskId,
        text: "The PR and recorded evidence meet the task criteria.",
      })
    ).status,
  ).toBe(200);
});

it("refuses a checkout in use and prevents sharing local state between projects", async () => {
  const registered = await post("/dashboard/agents", admin, {
    name: "Lock check",
    participant: "Test",
    preset: "developer",
  });
  const profile = await registered.json();
  const checkout = mkdtempSync(join(tmpdir(), "vizor-checkout-lock-"));
  const runnerHome = join(checkout, "runner-state");
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/crayosog-star/BlackforgeMC.git",
  ]);
  const lockPath = join(checkout, ".git", "vizor-runner.lock");
  writeFileSync(lockPath, String(process.pid));
  const run = async (project = "default") => {
    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/background-runner.ts"],
      {
        windowsHide: true,
        env: {
          ...process.env,
          VIZOR_RUNNER_AGENT_ID: profile.agent.id,
          VIZOR_RUNNER_PROJECT_ID: project,
          VIZOR_RUNNER_PAIRING_KEY: profile.key,
          VIZOR_RUNNER_RELAY: url,
          VIZOR_RUNNER_DIR: runnerHome,
          VIZOR_RUNNER_REPO: checkout,
        },
      },
    );
    let output = "";
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    const [code] = await once(child, "exit");
    return { code, output };
  };
  const locked = await run();
  expect(locked.code).not.toBe(0);
  expect(locked.output).toContain("Another runner is already using");
  expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  expect(existsSync(join(runnerHome, "runner.lock"))).toBe(false);
  const mismatched = await run(randomUUID());
  expect(mismatched.code).not.toBe(0);
  expect(mismatched.output).toContain("belongs to another agent");
});
