import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runHeadlessWorker } from "../src/lib/server/headless-worker";
import { runClaude } from "../src/lib/server/subscription";
import { agentPresets } from "../scripts/agent-presets.mjs";

vi.mock("../src/lib/server/subscription", () => ({ runClaude: vi.fn() }));

const directory = mkdtempSync(join(tmpdir(), "vizor-named-agents-"));
const ownerKey = randomBytes(32).toString("hex");
const workerKey = randomBytes(32).toString("hex");
const password = randomBytes(32).toString("hex");
const admin = "Basic " + Buffer.from(`owner:${password}`).toString("base64");
const origin = "http://127.0.0.1:4387";
let relay: ChildProcess;
let url: string;
async function start(port = 0) {
  relay = spawn(process.execPath, ["scripts/shared-relay.mjs"], {
    windowsHide: true,
    env: {
      ...process.env,
      VIZOR_SHARED_OWNER_KEY: ownerKey,
      VIZOR_SHARED_WORKER_KEY: workerKey,
      VIZOR_DASHBOARD_PASSWORD: password,
      VIZOR_DASHBOARD_ORIGIN: origin,
      VIZOR_SHARED_DB: join(directory, "relay.db"),
      VIZOR_SHARED_PORT: String(port),
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Relay did not start")), 5000);
    relay.once("error", reject);
    relay.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Relay exited"));
    });
    relay.stdout!.on("data", (chunk) => {
      const match = /listening on port (\d+)/.exec(String(chunk));
      if (!match) return;
      clearTimeout(timer);
      url = `http://127.0.0.1:${match[1]}`;
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
beforeAll(() => start());
afterAll(() => stop());

const headers = (auth: string) => ({
  Authorization: auth,
  Origin: origin,
  "Content-Type": "application/json",
});
const get = (key: string) =>
  fetch(url + "/v1/project", { headers: headers(`Bearer ${key}`) }).then(
    (response) => response.json(),
  );
const post = (path: string, auth: string, body: unknown) =>
  fetch(url + path, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify(body),
  });
const action = (key: string, input: object) =>
  post("/v1/project", `Bearer ${key}`, { id: randomUUID(), action: input });
const uuid = () => randomUUID();

it("routes work to named agents, enforces manager selection and persists profiles", async () => {
  const register = async (
    name: string,
    participant: string,
    preset: string,
  ) => {
    const response = await post("/dashboard/agents", admin, {
      name,
      participant,
      preset,
      instructions: "Preserve unrelated work.",
    });
    expect(response.status).toBe(201);
    return response.json();
  };
  const manager = await register("Gavin Manager", "Gavin", "orchestrator");
  const alternate = await register("Colin Manager", "Colin", "orchestrator");
  const first = await register("Stephen Builder 1", "Stephen", "developer");
  const second = await register("Stephen Builder 2", "Stephen", "developer");
  const reviewer = await register("John", "Gavin", "reviewer");
  expect(
    new Set([manager.key, alternate.key, first.key, second.key, reviewer.key])
      .size,
  ).toBe(5);
  expect((await get(first.key)).agent).toMatchObject({
    id: first.agent.id,
    preset: "developer",
  });
  expect((await get(reviewer.key)).agent.skills).toEqual(
    agentPresets.reviewer.skills.map((skill) => skill.name),
  );
  expect(
    (
      await post("/dashboard/agents", `Bearer ${first.key}`, {
        name: "Unauthorized",
      })
    ).status,
  ).toBe(401);
  expect(
    (await post("/dashboard/manager", admin, { agentId: first.agent.id }))
      .status,
  ).toBe(409);
  expect(
    (await post("/dashboard/manager", admin, { agentId: manager.agent.id }))
      .status,
  ).toBe(200);
  expect((await get(manager.key)).managerSelected).toBe(true);
  expect((await get(alternate.key)).managerSelected).toBe(false);
  const scope = {
    kind: "approve",
    text: "Fix the production default.",
    paths: ["code.ts", "other.ts"],
    waitForReview: true,
  };
  expect((await action(manager.key, scope)).status).toBe(409);
  expect(
    (await post("/dashboard/project", admin, { id: uuid(), action: scope }))
      .status,
  ).toBe(200);
  const assign = async (key: string, agentId: string, paths = ["code.ts"]) =>
    action(key, {
      kind: "assign",
      agentId,
      basis: (await get(key)).latest.id,
      text: "Fix this default.",
      paths,
    });
  expect((await assign(alternate.key, first.agent.id)).status).toBe(409);
  expect((await assign(ownerKey, first.agent.id)).status).toBe(409);
  expect((await assign(manager.key, first.agent.id)).status).toBe(200);
  const task = (await get(first.key)).task;
  const runnerId = uuid();
  expect(
    (await action(second.key, { kind: "claim", turnId: task.id, runnerId }))
      .status,
  ).toBe(409);
  expect(
    (await action(workerKey, { kind: "claim", turnId: task.id, runnerId }))
      .status,
  ).toBe(409);
  expect(
    (await action(first.key, { kind: "claim", turnId: task.id, runnerId }))
      .status,
  ).toBe(200);
  expect((await assign(manager.key, second.agent.id)).status).toBe(409);
  expect((await assign(manager.key, first.agent.id, ["other.ts"])).status).toBe(
    409,
  );
  expect(
    (await assign(manager.key, second.agent.id, ["other.ts"])).status,
  ).toBe(200);
  expect((await get(manager.key)).tasks).toHaveLength(2);
  expect((await get(first.key)).task.id).toBe(task.id);
  const otherTask = (await get(second.key)).task;
  expect(otherTask.agentId).toBe(second.agent.id);
  const secondRunner = uuid();
  expect(
    (
      await action(second.key, {
        kind: "claim",
        turnId: otherTask.id,
        runnerId: secondRunner,
      })
    ).status,
  ).toBe(200);
  const activePort = Number(new URL(url).port);
  await stop();
  await start(activePort);
  expect((await get(manager.key)).tasks).toHaveLength(2);
  expect((await get(first.key)).task.id).toBe(task.id);
  expect((await get(second.key)).task.id).toBe(otherTask.id);
  expect(
    (await post("/dashboard/manager", admin, { agentId: alternate.agent.id }))
      .status,
  ).toBe(200);
  expect((await get(alternate.key)).tasks).toHaveLength(2);
  expect((await assign(manager.key, reviewer.agent.id)).status).toBe(409);
  expect(
    (await post("/dashboard/manager", admin, { agentId: manager.agent.id }))
      .status,
  ).toBe(200);
  expect(
    (
      await action(second.key, {
        kind: "report",
        turnId: task.id,
        runnerId,
        text: "Forged report",
        outcome: "completed",
        needsReply: false,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await action(first.key, {
        kind: "report",
        turnId: task.id,
        runnerId,
        text: "Should this handle old saves?",
        outcome: "blocked",
        needsReply: true,
      })
    ).status,
  ).toBe(200);
  const question = (await get(manager.key)).latest;
  expect(question.actorId).toBe(first.agent.id);
  expect(
    (
      await action(second.key, {
        kind: "report",
        turnId: otherTask.id,
        runnerId: secondRunner,
        text: "Which fallback should I use?",
        outcome: "blocked",
        needsReply: true,
      })
    ).status,
  ).toBe(200);
  const secondQuestion = (await get(manager.key)).latest;
  expect(
    (
      await action(manager.key, {
        kind: "reply",
        basis: secondQuestion.id,
        turnId: question.id,
        text: "Yes, preserve old saves.",
      })
    ).status,
  ).toBe(200);
  const reply = (await get(first.key)).turn;
  expect(
    (await action(first.key, { kind: "claim", turnId: reply.id, runnerId }))
      .status,
  ).toBe(200);
  expect(
    (
      await action(first.key, {
        kind: "report",
        turnId: reply.id,
        runnerId,
        text: "Fixed and checked.",
        outcome: "completed",
        needsReply: false,
      })
    ).status,
  ).toBe(200);
  expect((await get(manager.key)).tasks).toHaveLength(1);
  expect(
    (
      await action(manager.key, {
        kind: "complete",
        basis: (await get(manager.key)).latest.id,
        text: "Premature completion",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await action(first.key, {
        kind: "claim",
        turnId: otherTask.id,
        runnerId: uuid(),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await action(manager.key, {
        kind: "reply",
        basis: (await get(manager.key)).latest.id,
        turnId: secondQuestion.id,
        text: "Use the documented existing fallback.",
      })
    ).status,
  ).toBe(200);
  const secondReply = (await get(second.key)).turn;
  expect(
    (
      await action(second.key, {
        kind: "claim",
        turnId: secondReply.id,
        runnerId: secondRunner,
      })
    ).status,
  ).toBe(200);
  await action(second.key, {
    kind: "report",
    turnId: secondReply.id,
    runnerId: secondRunner,
    text: "Finished.",
    outcome: "completed",
    needsReply: false,
  });
  expect(
    (await post("/dashboard/manager", admin, { agentId: alternate.agent.id }))
      .status,
  ).toBe(200);
  expect((await assign(manager.key, first.agent.id)).status).toBe(409);
  const port = Number(new URL(url).port);
  await stop();
  await start(port);
  expect((await get(alternate.key)).managerSelected).toBe(true);
  const persisted = await get(first.key);
  expect(persisted.agents).toHaveLength(5);
  expect(JSON.stringify(persisted)).not.toContain(first.key);
  expect(JSON.stringify(persisted)).not.toContain("token_hash");
  expect(
    (
      await post("/dashboard/revoke-agent", admin, {
        agentId: reviewer.agent.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(url + "/v1/project", {
        headers: headers(`Bearer ${reviewer.key}`),
      })
    ).status,
  ).toBe(401);
});

it("loads role skills and blocks a reviewer edit even when Claude proposes one", async () => {
  const folder = mkdtempSync(join(tmpdir(), "vizor-role-source-"));
  writeFileSync(join(folder, "code.ts"), "export const fallback = 0;\n");
  execFileSync("git", ["init", "-q", folder]);
  execFileSync("git", ["-C", folder, "add", "--", "code.ts"]);
  vi.mocked(runClaude).mockImplementation(async (args) => {
    if (args[0] === "auth")
      return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
    expect(args[args.indexOf("--system-prompt") + 1]).toContain(
      "Security review",
    );
    return JSON.stringify({
      structured_output: {
        outcome: "completed",
        summary: "Proposed a fix.",
        checks: [],
        artifacts: [],
        questions: [],
        edit: {
          file: "code.ts",
          find: "fallback = 0",
          replace: "fallback = 1",
        },
      },
    });
  });
  const report = await runHeadlessWorker(
    folder,
    "sonnet",
    "Review the production default.",
    ["code.ts"],
    { preset: "reviewer" },
  );
  expect(report.outcome).toBe("blocked");
  expect(report.summary).toContain("read-only");
  expect(readFileSync(join(folder, "code.ts"), "utf8")).toContain(
    "fallback = 0",
  );
});
