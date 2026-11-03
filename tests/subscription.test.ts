import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../src/lib/server/db";
import { configureOrchestrator } from "../src/lib/server/orchestrator-config";
import { defaultAgent } from "../src/lib/server/store";
import { startChat, recoverRuns } from "../src/lib/server/chat";
import { runClaude } from "../src/lib/server/subscription";
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const require = createRequire(import.meta.url);
const native = require("../desktop/terminal-host/claude-runtime.cjs");
let userId: string, workerId: string, home: string;
let reply: unknown;
let auth: unknown;
const invocations: { args: string[]; prompt: string; options: any }[] = [];
beforeAll(async () => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const migration of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  sqlite.close();
  await recoverRuns();
});
beforeEach(async () => {
  userId = (
    await db.user.create({
      data: { email: `${randomUUID()}@subscription.test` },
    })
  ).id;
  workerId = (
    await db.agent.create({
      data: {
        ...defaultAgent,
        engine: "claude-code",
        userId,
        projectPath: process.cwd(),
        conversation: { create: {} },
      },
    })
  ).id;
  home = mkdtempSync(join(tmpdir(), "vizor-subscription-test-"));
  vi.stubEnv("SELF_HOST", "true");
  vi.stubEnv("VIZOR_TERMINALS", "1");
  vi.stubEnv("VIZOR_NATIVE_HOST", resolve("desktop/terminal-host"));
  vi.stubEnv("VIZOR_NATIVE_HOME", home);
  vi.spyOn(native, "runtime").mockReturnValue({
    binary: "fixture-native.exe",
    cwd: home,
    env: { PATH: "fixture" },
  });
  auth = { loggedIn: true, authMethod: "claude.ai" };
  reply = {
    message: "One scoped task is ready for approval.",
    actions: [
      {
        tool: "dispatch_terminal",
        arguments: JSON.stringify({
          agent_id: workerId,
          text: "Review the approved scope and report.",
        }),
      },
    ],
  };
  invocations.length = 0;
  vi.mocked(childProcess.spawn).mockImplementation(
    (_file, args: any, options: any) => {
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => {
        child.emit("close", 143);
        return true;
      });
      let prompt = "";
      child.stdin.on("data", (bytes: Buffer) => {
        prompt += bytes.toString();
      });
      child.stdin.on("finish", () => {
        invocations.push({ args, prompt, options });
        queueMicrotask(() => {
          child.stdout.end(
            JSON.stringify(
              args[0] === "auth" ? auth : { structured_output: reply },
            ),
          );
          child.emit("close", 0);
        });
      });
      return child;
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => db.$disconnect());

it("uses native subscription sign-in without credentials, API spending, or shell access", async () => {
  const agent = await configureOrchestrator(userId, {
    provider: "anthropic",
    model: "sonnet",
    temperature: 0.2,
    maxTokens: 512,
    orchestratorMode: "subscription",
  });
  const response = await startChat(
    userId,
    agent.id,
    { clientId: randomUUID(), mode: "send", text: "Prepare a read-only task." },
    undefined,
    { orchestrator: true, scope: [workerId] },
  );
  expect(await response.text()).toContain("One scoped task");
  expect(invocations).toHaveLength(2);
  expect(invocations[1].args).toEqual(
    expect.arrayContaining([
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]),
  );
  expect(invocations[1].options.shell).toBe(false);
  expect(await db.credential.count({ where: { userId } })).toBe(0);
  expect(await db.spendEntry.count({ where: { userId } })).toBe(0);
  expect(await db.run.findFirstOrThrow({ where: { userId } })).toMatchObject({
    provider: "claude-subscription",
    cost: null,
    status: "complete",
  });
  expect(
    await db.proposal.findFirstOrThrow({ where: { userId } }),
  ).toMatchObject({ status: "pending" });
  expect(await db.terminalDispatch.count({ where: { userId } })).toBe(0);
});
it("full auto queues native proposals through the same standing authorization", async () => {
  await db.user.update({
    where: { id: userId },
    data: { queueEnabled: true, autoApprove: true },
  });
  const agent = await configureOrchestrator(userId, {
    provider: "anthropic",
    model: "opus",
    temperature: 0.2,
    maxTokens: 512,
    orchestratorMode: "subscription",
  });
  await (
    await startChat(
      userId,
      agent.id,
      { clientId: randomUUID(), mode: "send", text: "Prepare a task." },
      undefined,
      { orchestrator: true, scope: [workerId] },
    )
  ).text();
  expect(
    await db.proposal.findFirstOrThrow({ where: { userId } }),
  ).toMatchObject({ status: "queued", approvedBy: userId });
});
it("refuses native API authentication and never falls back to paid API calls", async () => {
  auth = { loggedIn: true, authMethod: "api_key" };
  const agent = await configureOrchestrator(userId, {
    provider: "anthropic",
    model: "sonnet",
    temperature: 0.2,
    maxTokens: 512,
    orchestratorMode: "subscription",
  });
  const output = await (
    await startChat(
      userId,
      agent.id,
      { clientId: randomUUID(), mode: "send", text: "Plan." },
      undefined,
      { orchestrator: true },
    )
  ).text();
  expect(output).toContain("subscription_login");
  expect(invocations).toHaveLength(1);
  expect(await db.proposal.count({ where: { userId } })).toBe(0);
  expect(await db.spendEntry.count({ where: { userId } })).toBe(0);
});
it("gives an actionable sign-in message when the subscription profile is empty", async () => {
  auth = { loggedIn: false, authMethod: "none" };
  const agent = await configureOrchestrator(userId, {
    provider: "anthropic",
    model: "sonnet",
    temperature: 0.2,
    maxTokens: 512,
    orchestratorMode: "subscription",
  });
  const output = await (
    await startChat(
      userId,
      agent.id,
      { clientId: randomUUID(), mode: "send", text: "Plan." },
      undefined,
      { orchestrator: true },
    )
  ).text();
  expect(output).toContain("subscription_login");
  expect(invocations).toHaveLength(1);
});
it("rejects malformed native output before any action and preserves the failed response", async () => {
  reply = { message: "Invalid", actions: "execute everything" };
  const agent = await configureOrchestrator(userId, {
    provider: "anthropic",
    model: "sonnet",
    temperature: 0.2,
    maxTokens: 512,
    orchestratorMode: "subscription",
  });
  await (
    await startChat(
      userId,
      agent.id,
      { clientId: randomUUID(), mode: "send", text: "Plan." },
      undefined,
      { orchestrator: true },
    )
  ).text();
  expect(await db.proposal.count({ where: { userId } })).toBe(0);
  expect(await db.run.findFirstOrThrow({ where: { userId } })).toMatchObject({
    status: "error",
  });
});
it("refuses subscription orchestration outside the local desktop", async () => {
  vi.stubEnv("VIZOR_TERMINALS", "0");
  await expect(
    configureOrchestrator(userId, {
      provider: "anthropic",
      model: "sonnet",
      temperature: 0.2,
      maxTokens: 512,
      orchestratorMode: "subscription",
    }),
  ).rejects.toThrow();
});
it("supports cancellation before native launch", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runClaude(["auth", "status"], "", controller.signal),
  ).rejects.toThrow();
  expect(invocations).toHaveLength(0);
});
it("removes alternate billing routes and inherited tokens for dedicated native sign-in", () => {
  const env = native.subscriptionEnvironment({
    PATH: "fixture",
    ANTHROPIC_API_KEY: "private",
    CLAUDE_CODE_OAUTH_TOKEN: "private",
    ANTHROPIC_AUTH_TOKEN: "private",
    ANTHROPIC_BASE_URL: "private",
    CLAUDE_CODE_USE_BEDROCK: "1",
    MASTER_KEY: "private",
  });
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  expect(env.MASTER_KEY).toBeUndefined();
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});
