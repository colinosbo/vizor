import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "../src/lib/server/db";
import { defaultAgent } from "../src/lib/server/store";
import {
  addQueuedTask,
  enqueueProposal,
  processTaskQueue,
  setAutomation,
} from "../src/lib/server/task-queue";
import {
  approveProposal,
  editProposal,
  rejectProposal,
} from "../src/lib/server/proposals";
import {
  claimTerminalDispatch,
  completeTerminalDispatch,
  recoverTerminalDispatches,
  cancelTerminalDispatch,
} from "../src/lib/server/terminal-dispatches";
import { toolResult } from "../src/lib/server/orchestrator-tools";
import { recoverRuns } from "../src/lib/server/chat";
import { anthropic } from "../src/lib/providers/anthropic";
import { encryptKey } from "../src/lib/server/crypto";
let userId: string, otherId: string, workerId: string;
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
    await db.user.create({ data: { email: `${randomUUID()}@queue.test` } })
  ).id;
  otherId = (
    await db.user.create({ data: { email: `${randomUUID()}@queue.test` } })
  ).id;
  workerId = (
    await db.agent.create({
      data: {
        ...defaultAgent,
        userId,
        engine: "claude-code",
        projectPath: process.cwd(),
        conversation: { create: {} },
      },
    })
  ).id;
});
afterAll(() => db.$disconnect());
async function draft(text = "Scoped task") {
  return db.proposal.create({
    data: {
      userId,
      runId: randomUUID(),
      toolCallId: randomUUID(),
      action: "dispatch_terminal",
      agentId: workerId,
      payload: JSON.stringify({
        action: "dispatch_terminal",
        agentId: workerId,
        text,
      }),
    },
  });
}
it("starts disjoint project tasks together while overlapping work waits", async () => {
  const project = await db.project.create({
    data: { userId, name: "Feature", folder: process.cwd() },
  });
  const agents = await Promise.all(
    ["a", "b", "c"].map((name) =>
      db.agent.create({
        data: {
          ...defaultAgent,
          userId,
          projectId: project.id,
          name,
          engine: "claude-code",
          projectPath: process.cwd(),
          conversation: { create: {} },
        },
      }),
    ),
  );
  const paths = [["src/a"], ["src/b"], ["src/a/deeper"]];
  const proposals = [];
  for (let i = 0; i < agents.length; i++) {
    proposals.push(
      await db.proposal.create({
        data: {
          userId,
          projectId: project.id,
          runId: randomUUID(),
          toolCallId: randomUUID(),
          action: "dispatch_terminal",
          agentId: agents[i].id,
          status: "queued",
          approvedBy: userId,
          approvedAt: new Date(Date.now() + i),
          payload: JSON.stringify({
            action: "dispatch_terminal",
            agentId: agents[i].id,
            text: "Implement scoped change",
            writePaths: paths[i],
          }),
        },
      }),
    );
  }
  await setAutomation(userId, { queueEnabled: true, autoApprove: false });
  await processTaskQueue(userId);
  await processTaskQueue(userId);
  await processTaskQueue(userId);
  expect(
    (
      await db.terminalDispatch.findMany({
        where: { userId, agentId: { in: agents.map((agent) => agent.id) } },
      })
    )
      .map((task) => task.agentId)
      .sort(),
  ).toEqual([agents[0].id, agents[1].id].sort());
  expect(
    (await db.proposal.findUniqueOrThrow({ where: { id: proposals[2].id } }))
      .status,
  ).toBe("queued");
});
it("defaults to manual approval and persists both automation switches independently of layout", async () => {
  expect(
    await db.user.findUniqueOrThrow({ where: { id: userId } }),
  ).toMatchObject({ autoApprove: false, queueEnabled: false });
  await setAutomation(userId, { autoApprove: true, queueEnabled: true });
  expect(
    await db.user.findUniqueOrThrow({ where: { id: userId } }),
  ).toMatchObject({
    autoApprove: true,
    queueEnabled: true,
    workspaceLayout: "{}",
  });
  expect(
    await db.user.findUniqueOrThrow({ where: { id: otherId } }),
  ).toMatchObject({ autoApprove: false });
  await expect(
    setAutomation(userId, { autoApprove: true, queueEnabled: false }),
  ).rejects.toThrow();
  await setAutomation(userId, { autoApprove: false, queueEnabled: false });
  expect(
    await db.auditEntry.count({
      where: { userId, action: "automation.changed" },
    }),
  ).toBe(2);
});
it("preserves approval order when several tasks are added in the same millisecond", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1900000000000);
  try {
    const first = await addQueuedTask(userId, {
      agentId: workerId,
      text: "First",
    });
    const second = await addQueuedTask(userId, {
      agentId: workerId,
      text: "Second",
    });
    const a = await db.proposal.findUniqueOrThrow({ where: { id: first.id } });
    const b = await db.proposal.findUniqueOrThrow({ where: { id: second.id } });
    expect(b.approvedAt!.getTime()).toBeGreaterThan(a.approvedAt!.getTime());
  } finally {
    clock.mockRestore();
  }
});
it("cancels only owned unsent deliveries and unblocks the next task", async () => {
  const first = await addQueuedTask(userId, {
    agentId: workerId,
    text: "Cancel this",
  });
  const second = await addQueuedTask(userId, {
    agentId: workerId,
    text: "Next",
  });
  await setAutomation(userId, { queueEnabled: true, autoApprove: false });
  await processTaskQueue(userId);
  await expect(cancelTerminalDispatch(otherId, first.id)).rejects.toMatchObject(
    { status: 404 },
  );
  await cancelTerminalDispatch(userId, first.id);
  await processTaskQueue(userId);
  expect(
    await db.terminalDispatch.findUniqueOrThrow({
      where: { proposalId: first.id },
    }),
  ).toMatchObject({ status: "superseded" });
  await claimTerminalDispatch(userId, second.id, true);
  await expect(cancelTerminalDispatch(userId, second.id)).rejects.toMatchObject(
    { status: 409 },
  );
});
it("keeps multiple approved tasks durable and paused without creating a terminal delivery", async () => {
  const first = await addQueuedTask(userId, {
    agentId: workerId,
    text: "First",
  });
  const second = await addQueuedTask(userId, {
    agentId: workerId,
    text: "Second",
  });
  await processTaskQueue(userId);
  expect(await db.proposal.count({ where: { userId, status: "queued" } })).toBe(
    2,
  );
  expect(await db.terminalDispatch.count({ where: { userId } })).toBe(0);
  await expect(approveProposal(userId, first.id, 0)).rejects.toMatchObject({
    code: "queue_paused",
  });
  await rejectProposal(userId, second.id, 0);
  expect(
    await db.proposal.findUniqueOrThrow({ where: { id: second.id } }),
  ).toMatchObject({ status: "rejected" });
});
it("honors ownership and edited versions before queue approval", async () => {
  const task = await draft();
  await expect(enqueueProposal(otherId, task.id, 0)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    addQueuedTask(otherId, { agentId: workerId, text: "No" }),
  ).rejects.toMatchObject({ status: 404 });
  await editProposal(userId, task.id, 0, {
    action: "dispatch_terminal",
    agentId: workerId,
    text: "Revised scope",
  });
  await expect(enqueueProposal(userId, task.id, 0)).rejects.toMatchObject({
    code: "proposal_changed",
  });
  await enqueueProposal(userId, task.id, 1);
  await enqueueProposal(userId, task.id, 1);
  expect(
    await db.auditEntry.count({
      where: { userId, proposalId: task.id, action: "proposal.queued" },
    }),
  ).toBe(1);
});
it("runs FIFO, waits for a report, and cannot send twice from two windows", async () => {
  const first = await addQueuedTask(userId, {
    agentId: workerId,
    text: "First",
  });
  const second = await addQueuedTask(userId, {
    agentId: workerId,
    text: "Second",
  });
  // Use explicit distinct approval timestamps to verify ordering rather than timing luck.
  await db.proposal.update({
    where: { id: first.id },
    data: { approvedAt: new Date(1) },
  });
  await setAutomation(userId, { queueEnabled: true, autoApprove: false });
  await Promise.all([processTaskQueue(userId), processTaskQueue(userId)]);
  expect(await db.terminalDispatch.count({ where: { userId } })).toBe(1);
  expect(
    await db.terminalDispatch.findUniqueOrThrow({
      where: { proposalId: first.id },
    }),
  ).toMatchObject({ text: "First", status: "ready" });
  await claimTerminalDispatch(userId, first.id, true);
  await expect(
    claimTerminalDispatch(userId, first.id, true),
  ).rejects.toMatchObject({ code: "dispatch_unavailable" });
  await completeTerminalDispatch(userId, first.id);
  await processTaskQueue(userId);
  expect(
    await db.proposal.findUniqueOrThrow({ where: { id: second.id } }),
  ).toMatchObject({ status: "queued" });
  await db.terminalDispatch.update({
    where: { proposalId: first.id },
    data: { status: "reported" },
  });
  await processTaskQueue(userId);
  expect(
    await db.terminalDispatch.findUniqueOrThrow({
      where: { proposalId: second.id },
    }),
  ).toMatchObject({ text: "Second", status: "ready" });
});
it("full auto approves waiting drafts, keeps an audit, and stopping prevents later approvals and deliveries", async () => {
  const first = await draft("First");
  const second = await draft("Second");
  await setAutomation(userId, { autoApprove: true, queueEnabled: true });
  await processTaskQueue(userId);
  expect(
    await db.proposal.count({ where: { userId, status: "pending" } }),
  ).toBe(0);
  expect(await db.proposal.count({ where: { userId, status: "queued" } })).toBe(
    1,
  );
  expect(await db.terminalDispatch.count({ where: { userId } })).toBe(1);
  const audit = await db.auditEntry.findFirstOrThrow({
    where: { userId, action: "proposal.queued" },
  });
  expect(JSON.parse(audit.details).automatic).toBe(true);
  expect(audit.actor).toBe("system");
  await setAutomation(userId, { autoApprove: false, queueEnabled: false });
  const next = await draft("Needs manual approval again");
  await processTaskQueue(userId);
  expect(
    await db.proposal.findUniqueOrThrow({ where: { id: next.id } }),
  ).toMatchObject({ status: "pending" });
  const dispatch = await db.terminalDispatch.findFirstOrThrow({
    where: { userId },
  });
  await expect(
    claimTerminalDispatch(userId, dispatch.proposalId, true),
  ).rejects.toMatchObject({ code: "queue_paused" });
  expect(first.id).not.toBe(second.id);
});
it("new orchestrator proposals enter the approved queue immediately in full auto", async () => {
  const coordinator = await db.agent.create({
    data: {
      ...defaultAgent,
      userId,
      kind: "orchestrator",
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  const run = await db.run.create({
    data: {
      userId,
      conversationId: coordinator.conversation!.id,
      clientId: randomUUID(),
      assistantId: randomUUID(),
      model: defaultAgent.model,
      status: "complete",
    },
  });
  await setAutomation(userId, { autoApprove: true, queueEnabled: true });
  const call = {
    id: randomUUID(),
    name: "dispatch_terminal",
    arguments: { agent_id: workerId, text: "Implement the approved scope" },
  };
  expect(await toolResult(userId, run.id, call, [workerId])).toMatchObject({
    status: "queued",
    requiresHumanApproval: false,
    executed: false,
  });
  await toolResult(userId, run.id, call, [workerId]);
  expect(await db.proposal.count({ where: { userId } })).toBe(1);
  expect(await db.terminalDispatch.count({ where: { userId } })).toBe(0);
});
it("pauses after invalid queued execution instead of skipping to the next task", async () => {
  const first = await addQueuedTask(userId, {
    agentId: workerId,
    text: "First",
  });
  await db.proposal.update({
    where: { id: first.id },
    data: { approvedAt: new Date(1) },
  });
  await addQueuedTask(userId, { agentId: workerId, text: "Second" });
  await db.agent.update({ where: { id: workerId }, data: { archived: true } });
  await setAutomation(userId, { autoApprove: true, queueEnabled: true });
  await processTaskQueue(userId);
  expect(
    await db.user.findUniqueOrThrow({ where: { id: userId } }),
  ).toMatchObject({ autoApprove: false, queueEnabled: false });
  expect(
    await db.proposal.findUniqueOrThrow({ where: { id: first.id } }),
  ).toMatchObject({ status: "failed" });
  expect(await db.terminalDispatch.count({ where: { userId } })).toBe(0);
});
it("does not automatically resend uncertain deliveries after a restart", async () => {
  const task = await addQueuedTask(userId, {
    agentId: workerId,
    text: "Once only",
  });
  await setAutomation(userId, { autoApprove: true, queueEnabled: true });
  await processTaskQueue(userId);
  await claimTerminalDispatch(userId, task.id, true);
  await db.terminalDispatch.update({
    where: { proposalId: task.id },
    data: { claimedAt: new Date(Date.now() - 180000) },
  });
  await recoverTerminalDispatches();
  expect(
    await db.terminalDispatch.findUniqueOrThrow({
      where: { proposalId: task.id },
    }),
  ).toMatchObject({ status: "failed" });
  expect(
    await db.user.findUniqueOrThrow({ where: { id: userId } }),
  ).toMatchObject({ autoApprove: false, queueEnabled: false });
});
it("runs queued API tasks once and waits for the active response before the next task", async () => {
  await db.credential.create({
    data: {
      userId,
      provider: "anthropic",
      encrypted: encryptKey("fixture-only", userId, "anthropic"),
      last4: "test",
    },
  });
  const agent = await db.agent.create({
    data: { ...defaultAgent, userId, conversation: { create: {} } },
  });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stream = vi
    .spyOn(anthropic, "stream")
    .mockImplementation(async function* () {
      yield { type: "delta", text: "Queue response" };
      await waiting;
      yield {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, complete: true },
      };
    });
  try {
    const first = await addQueuedTask(userId, {
      agentId: agent.id,
      text: "API first",
    });
    await db.proposal.update({
      where: { id: first.id },
      data: { approvedAt: new Date(1) },
    });
    const second = await addQueuedTask(userId, {
      agentId: workerId,
      text: "Terminal second",
    });
    await setAutomation(userId, { queueEnabled: true, autoApprove: false });
    await processTaskQueue(userId);
    await processTaskQueue(userId);
    expect(
      await db.run.count({ where: { userId, proposalId: first.id } }),
    ).toBe(1);
    expect(
      await db.proposal.findUniqueOrThrow({ where: { id: second.id } }),
    ).toMatchObject({ status: "queued" });
    finish();
    await vi.waitFor(async () =>
      expect(
        await db.run.findFirstOrThrow({
          where: { userId, proposalId: first.id },
        }),
      ).toMatchObject({ status: "complete" }),
    );
    await processTaskQueue(userId);
    expect(
      await db.terminalDispatch.count({
        where: { userId, proposalId: second.id },
      }),
    ).toBe(1);
    expect(stream).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    stream.mockRestore();
  }
});
