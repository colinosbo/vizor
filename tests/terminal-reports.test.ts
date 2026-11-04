import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/server/db";
import { answerWorkerQuestion } from "../src/lib/server/worker-questions";
import { defaultAgent, workspace } from "../src/lib/server/store";
import {
  collectTerminalReports,
  reportInstructions,
  reportPath,
} from "../src/lib/server/terminal-reports";
const folder = mkdtempSync(join(tmpdir(), "vizor-report-test-"));
let owner: string,
  other: string,
  conversation: string,
  dispatch: string,
  project: string;
beforeAll(() => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const n of readdirSync("prisma/migrations")
    .filter((n) => /^\d/.test(n))
    .sort())
    sqlite.exec(readFileSync(`prisma/migrations/${n}/migration.sql`, "utf8"));
  sqlite.close();
});
beforeEach(async () => {
  vi.stubEnv("SELF_HOST", "true");
  vi.stubEnv("VIZOR_TERMINALS", "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("Unexpected network call");
    }),
  );
  owner = randomUUID();
  other = randomUUID();
  project = join(folder, randomUUID());
  mkdirSync(project);
  await db.user.createMany({
    data: [
      { id: owner, email: owner + "@test" },
      { id: other, email: other + "@test" },
    ],
  });
  const coordinator = await db.agent.create({
    data: {
      ...defaultAgent,
      userId: owner,
      kind: "orchestrator",
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  conversation = coordinator.conversation!.id;
  const agent = await db.agent.create({
    data: {
      ...defaultAgent,
      name: "Report builder",
      userId: owner,
      engine: "claude-code",
      projectPath: project,
      conversation: { create: {} },
    },
  });
  const task = await db.terminalDispatch.create({
    data: {
      userId: owner,
      agentId: agent.id,
      proposalId: randomUUID(),
      text: "read only",
      status: "delivered",
    },
  });
  dispatch = task.id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.$disconnect();
  rmSync(folder, { recursive: true, force: true });
});
async function report(overrides: Record<string, unknown> = {}) {
  const file = await reportPath(project, dispatch, true);
  writeFileSync(
    file,
    JSON.stringify({
      dispatchId: dispatch,
      outcome: "completed",
      summary: "Located source; sk-ant-private-test-value-123456789",
      checks: ["git status; exit 0; read-only"],
      artifacts: ["src/Boss.java:45"],
      ...overrides,
    }),
  );
  return file;
}
it("imports a bounded report only for its owner, labels provenance, redacts keys, and deduplicates concurrent/restarted reads without inference", async () => {
  expect(await reportInstructions(project, dispatch)).toContain(
    "explicit exception to a read-only assignment",
  );
  await report();
  await collectTerminalReports(other);
  expect(await db.message.count()).toBe(0);
  await Promise.all([
    collectTerminalReports(owner),
    collectTerminalReports(owner),
  ]);
  await collectTerminalReports(owner);
  const messages = await db.message.findMany({
    where: { conversationId: conversation },
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    origin: "terminal_report",
    proposalId: expect.any(String),
  });
  expect(messages[0].text).toContain("[REDACTED KEY]");
  expect(messages[0].text).not.toContain("sk-ant-private");
  expect(fetch).not.toHaveBeenCalled();
});
it("delivers a worker report only to its own project's Orchestrator", async () => {
  const feature = await db.project.create({
    data: { userId: owner, name: "Feature", folder: project },
  });
  const lead = await db.agent.create({
    data: {
      ...defaultAgent,
      userId: owner,
      projectId: feature.id,
      kind: "orchestrator",
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  const task = await db.terminalDispatch.findUniqueOrThrow({
    where: { id: dispatch },
  });
  await db.agent.update({
    where: { id: task.agentId },
    data: { projectId: feature.id },
  });
  await report();
  await collectTerminalReports(owner);
  expect(
    await db.message.count({
      where: {
        conversationId: lead.conversation!.id,
        origin: "terminal_report",
      },
    }),
  ).toBe(1);
  expect(
    await db.message.count({
      where: { conversationId: conversation, origin: "terminal_report" },
    }),
  ).toBe(0);
});
it("ignores mismatched, malformed, and oversized reports but accepts a later complete write", async () => {
  const file = await report({ dispatchId: "wrong" });
  await collectTerminalReports(owner);
  expect(
    await db.message.count({ where: { conversationId: conversation } }),
  ).toBe(0);
  writeFileSync(file, "{");
  await collectTerminalReports(owner);
  writeFileSync(file, "x".repeat(24577));
  await collectTerminalReports(owner);
  expect(
    await db.message.count({ where: { conversationId: conversation } }),
  ).toBe(0);
  await report();
  await collectTerminalReports(owner);
  expect(
    await db.message.count({ where: { conversationId: conversation } }),
  ).toBe(1);
});
it("defers reports while an orchestrator turn runs and recovers through workspace refresh", async () => {
  await report();
  await db.conversation.update({
    where: { id: conversation },
    data: { activeRunId: "busy" },
  });
  await collectTerminalReports(owner);
  expect(
    await db.message.count({ where: { conversationId: conversation } }),
  ).toBe(0);
  await db.conversation.update({
    where: { id: conversation },
    data: { activeRunId: null },
  });
  const state = await workspace({ id: owner, email: "test" });
  expect(
    state.orchestrator?.conversation?.messages.some(
      (m) => m.origin === "terminal_report",
    ),
  ).toBe(true);
});
it("rejects junction escapes and traversal IDs", async () => {
  const outside = join(folder, randomUUID());
  mkdirSync(outside);
  symlinkSync(outside, join(project, ".vizor"), "junction");
  await expect(reportPath(project, dispatch, true)).rejects.toThrow();
  await expect(reportPath(project, "../escape", true)).rejects.toThrow();
});
it("does not collect unsent tasks or read filesystem reports in account mode", async () => {
  await report();
  await db.terminalDispatch.update({
    where: { id: dispatch },
    data: { status: "ready" },
  });
  await collectTerminalReports(owner);
  expect(
    await db.message.count({ where: { conversationId: conversation } }),
  ).toBe(0);
  await db.terminalDispatch.update({
    where: { id: dispatch },
    data: { status: "delivered" },
  });
  vi.stubEnv("SELF_HOST", "false");
  await collectTerminalReports(owner);
  expect(
    await db.message.count({ where: { conversationId: conversation } }),
  ).toBe(0);
});
it("routes a real structured question to the Orchestrator and queues only one bounded same-worker reply", async () => {
  await report({
    outcome: "blocked",
    questions: [
      {
        id: "q1",
        question: "Which fishing interval should I use?",
        options: ["180 seconds", "60 seconds"],
      },
    ],
  });
  await collectTerminalReports(owner);
  const original = await db.terminalDispatch.findUniqueOrThrow({
    where: { id: dispatch },
  });
  expect(JSON.parse(original.questions)[0].id).toBe("q1");
  const imported = await db.message.findUniqueOrThrow({
    where: { id: `terminal-report-${dispatch}` },
  });
  expect(imported.text).toContain("Which fishing interval");
  const run = await db.run.create({
    data: {
      userId: owner,
      conversationId: conversation,
      assistantId: randomUUID(),
      clientId: randomUUID(),
      model: "fixture",
      status: "complete",
    },
  });
  const call = () => ({
    id: randomUUID(),
    name: "answer_worker_question",
    arguments: {
      dispatch_id: dispatch,
      answer: "Use 180 seconds for tier I, as the approved plan specifies.",
    },
  });
  await expect(
    answerWorkerQuestion(other, run.id, call()),
  ).rejects.toMatchObject({ status: 404 });
  const answer = await answerWorkerQuestion(owner, run.id, call());
  const reply = await db.terminalDispatch.findUniqueOrThrow({
    where: { id: answer.dispatchId },
  });
  expect(reply).toMatchObject({
    agentId: original.agentId,
    autoDeliver: true,
    replyToId: dispatch,
    replyDepth: 1,
    status: "ready",
  });
  expect(reply.text).toContain("grants no new file, command");
  expect(
    await db.message.findUniqueOrThrow({
      where: { id: `worker-answer-${reply.id}` },
    }),
  ).toMatchObject({
    origin: "worker_reply",
    role: "assistant",
    conversationId: conversation,
  });
  expect(
    (await db.proposal.findUniqueOrThrow({ where: { id: reply.proposalId } }))
      .approvedBy,
  ).toBeNull();
  const again = await answerWorkerQuestion(owner, run.id, call());
  expect(again.dispatchId).toBe(reply.id);
  expect(
    await db.terminalDispatch.count({ where: { replyToId: dispatch } }),
  ).toBe(1);
});
it("escalates clarification loops after two rounds and refuses to overlap another assignment", async () => {
  await report({
    outcome: "blocked",
    questions: [{ id: "q1", question: "Which approved option?", options: [] }],
  });
  await collectTerminalReports(owner);
  const run = await db.run.create({
    data: {
      userId: owner,
      conversationId: conversation,
      assistantId: randomUUID(),
      clientId: randomUUID(),
      model: "fixture",
      status: "complete",
    },
  });
  const call = () => ({
    id: randomUUID(),
    name: "answer_worker_question",
    arguments: { dispatch_id: dispatch, answer: "Use the option in the plan." },
  });
  await db.terminalDispatch.update({
    where: { id: dispatch },
    data: { replyDepth: 2 },
  });
  await expect(
    answerWorkerQuestion(owner, run.id, call()),
  ).rejects.toMatchObject({ code: "question_limit" });
  const original = await db.terminalDispatch.update({
    where: { id: dispatch },
    data: { replyDepth: 0 },
  });
  await db.terminalDispatch.create({
    data: {
      userId: owner,
      agentId: original.agentId,
      proposalId: randomUUID(),
      text: "Other approved assignment",
      status: "ready",
    },
  });
  await expect(
    answerWorkerQuestion(owner, run.id, call()),
  ).rejects.toMatchObject({ code: "worker_busy" });
});
