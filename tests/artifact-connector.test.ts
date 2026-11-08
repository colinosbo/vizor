import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "vizor-artifact-"));
const password = randomBytes(32).toString("hex");
const ownerKey = randomBytes(32).toString("hex");
const origin = "http://127.0.0.1:4387";
const admin = "Basic " + Buffer.from(`owner:${password}`).toString("base64");
let relay: ChildProcess, url: string;
const people: Record<string, any> = {};
const agents: Record<string, any> = {};
async function start() {
  relay = spawn(process.execPath, ["scripts/shared-relay.mjs"], {
    windowsHide: true,
    env: {
      ...process.env,
      VIZOR_SHARED_DB: join(directory, "relay.db"),
      VIZOR_SHARED_PORT: "0",
      VIZOR_SHARED_OWNER_KEY: ownerKey,
      VIZOR_SHARED_WORKER_KEY: randomBytes(32).toString("hex"),
      VIZOR_DASHBOARD_PASSWORD: password,
      VIZOR_DASHBOARD_ORIGIN: origin,
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Relay startup timed out")),
      10000,
    );
    relay.once("error", reject);
    relay.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Relay exited"));
    });
    relay.stdout!.on("data", (chunk) => {
      const match = /listening on port (\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        url = `http://127.0.0.1:${match[1]}`;
        resolve();
      }
    });
  });
}
async function stop() {
  if (relay.exitCode === null && !relay.signalCode) {
    const done = once(relay, "exit");
    relay.kill();
    await done;
  }
}
const post = (
  path: string,
  authorization: string,
  body: unknown,
  extra: Record<string, string> = {},
) =>
  fetch(url + path, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: origin,
      "Content-Type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  });
async function call(person: string, name: string, args: object) {
  const response = await post("/mcp", `Bearer ${people[person].key}`, {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  return (await response.json()).result;
}
const snapshot = async (person = "Colin") =>
  (await call(person, "vizor_project", { projectId: "default" }))
    .structuredContent;
async function act(key: string, action: object) {
  const response = await post("/v1/project", `Bearer ${key}`, {
    id: randomUUID(),
    action,
  });
  expect(response.status).toBe(200);
  return response.json();
}
beforeAll(async () => {
  await start();
  for (const [name, role] of [
    ["Colin", "owner"],
    ["Steven", "editor"],
    ["Gav", "editor"],
    ["Observer", "viewer"],
  ]) {
    const response = await post("/dashboard/artifact-members", admin, {
      name,
      role,
      projectIds: ["default"],
    });
    expect(response.status).toBe(201);
    people[name] = await response.json();
  }
  for (const [name, participant, preset] of [
    ["Manager", "Colin", "orchestrator"],
    ["Builder", "Steven", "developer"],
    ["Reviewer", "Gav", "reviewer"],
  ]) {
    const response = await post("/dashboard/agents", admin, {
      name,
      participant,
      preset,
      instructions: "Use saved task threads.",
    });
    expect(response.status).toBe(201);
    agents[name] = await response.json();
  }
  expect(
    (
      await post("/dashboard/manager", admin, {
        agentId: agents.Manager.agent.id,
      })
    ).status,
  ).toBe(200);
  await act(ownerKey, {
    kind: "approve",
    text: "Test shared dashboard only",
    paths: ["sample.ts"],
  });
});
afterAll(stop);

it("supports real MCP discovery with distinct personal access and no embedded credentials", async () => {
  const response = await post("/mcp", `Bearer ${people.Steven.key}`, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    },
  });
  expect((await response.json()).result.serverInfo.name).toBe(
    "vizor-shared-projects",
  );
  const tools = await post("/mcp", `Bearer ${people.Steven.key}`, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const names = (await tools.json()).result.tools.map((tool: any) => tool.name);
  expect(names).toContain("vizor_project");
  expect(names).not.toContain("vizor_answer_decision");
  const view = await snapshot("Gav");
  expect(view.agents.map((agent: any) => agent.name)).toEqual([
    "Manager",
    "Builder",
    "Reviewer",
  ]);
  for (const person of Object.values(people))
    expect(JSON.stringify(view)).not.toContain(person.key);
  expect((await post("/mcp", `Bearer ${agents.Builder.key}`, {})).status).toBe(
    401,
  );
  expect(
    (
      await post(
        "/mcp",
        `Bearer ${people.Colin.key}`,
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
});

it("keeps notes and conversation shared, attributed, idempotent and isolated", async () => {
  const note = {
    projectId: "default",
    requestId: randomUUID(),
    text: "Check effects in game before calling it verified.",
  };
  expect(
    (await call("Steven", "vizor_add_note", note)).structuredContent.duplicate,
  ).toBe(false);
  expect(
    (await call("Steven", "vizor_add_note", note)).structuredContent.duplicate,
  ).toBe(true);
  expect((await call("Gav", "vizor_add_note", note)).isError).toBe(true);
  expect(
    (
      await call("Observer", "vizor_add_note", {
        ...note,
        requestId: randomUUID(),
      })
    ).isError,
  ).toBe(true);
  expect((await snapshot("Colin")).notes).toEqual([
    expect.objectContaining({ text: note.text, author: "Steven" }),
  ]);
  expect(
    (await call("Gav", "vizor_project", { projectId: randomUUID() })).isError,
  ).toBe(true);
  const message = {
    projectId: "default",
    requestId: randomUUID(),
    text: "Review sample before acceptance.",
  };
  expect(
    (await call("Gav", "vizor_post_message", message)).structuredContent.saved,
  ).toBe(true);
  const view = await snapshot();
  expect(view.latest).toMatchObject({
    kind: "project_message",
    humanName: "Gav",
    text: message.text,
  });
});

it("runs task creation, manager assignment, worker question, reply and review through saved records", async () => {
  const view = await snapshot();
  const taskId = randomUUID();
  const task = {
    title: "Inspect sample",
    description: "Read the supplied sample",
    acceptance: "Report a source-backed finding",
    paths: ["sample.ts"],
    checks: ["diff"],
    dependencies: [],
    references: [],
  };
  expect(
    (
      await call("Steven", "vizor_create_task", {
        projectId: "default",
        requestId: taskId,
        basis: view.latest.id,
        task,
      })
    ).isError,
  ).not.toBe(true);
  let state = await act(agents.Manager.key, {
    kind: "assign",
    basis: taskId,
    queuedTaskId: taskId,
    agentId: agents.Reviewer.agent.id,
    paths: task.paths,
    text: `Task ${taskId}\n${task.title}\n\n${task.description}\n\nAcceptance criteria\n${task.acceptance}\n\nReferences`,
  });
  const assignment = state.turn.id,
    runner = randomUUID();
  await act(agents.Reviewer.key, {
    kind: "claim",
    turnId: assignment,
    runnerId: runner,
  });
  await act(agents.Reviewer.key, {
    kind: "work_start",
    turnId: assignment,
    runnerId: runner,
  });
  state = await act(agents.Reviewer.key, {
    kind: "report",
    turnId: assignment,
    runnerId: runner,
    outcome: "blocked",
    needsReply: true,
    text: "Should I edit?",
  });
  expect((await snapshot("Steven")).queue[0].status).toBe("blocked");
  state = await act(agents.Manager.key, {
    kind: "reply",
    basis: state.latest.id,
    turnId: state.latest.id,
    text: "Stay read-only, report only.",
  });
  const reply = state.turn.id;
  await act(agents.Reviewer.key, {
    kind: "claim",
    turnId: reply,
    runnerId: runner,
  });
  state = await act(agents.Reviewer.key, {
    kind: "report",
    turnId: reply,
    runnerId: runner,
    outcome: "completed",
    needsReply: false,
    text: "Verified: sample is unchanged; inspection complete.",
  });
  expect((await snapshot("Gav")).queue[0].status).toBe("review");
  await act(agents.Manager.key, {
    kind: "task_accept",
    basis: state.latest.id,
    taskId,
    text: "Evidence meets the criteria.",
  });
  expect((await snapshot()).queue[0].status).toBe("complete");
  const outside = { ...task, paths: ["not-approved.ts"] };
  expect(
    (
      await call("Steven", "vizor_create_task", {
        projectId: "default",
        requestId: randomUUID(),
        basis: (await snapshot()).latest.id,
        task: outside,
      })
    ).isError,
  ).toBe(true);
});

it("retains project notes, task history and access after relay restart", async () => {
  await stop();
  await start();
  const state = await snapshot("Gav");
  expect(state.notes).toHaveLength(1);
  expect(state.queue[0].status).toBe("complete");
  expect(
    state.events.some(
      (event: any) =>
        event.kind === "project_message" && event.humanName === "Gav",
    ),
  ).toBe(true);
});
