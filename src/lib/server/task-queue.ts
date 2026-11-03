import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { AppError, safeError } from "./errors";
import { audit } from "./audit";
import { publish } from "./events";
import type { Prisma } from "@/generated/prisma/client";

async function nextApprovalTime(tx: Prisma.TransactionClient, userId: string) {
  const last = await tx.proposal.aggregate({
    where: { userId },
    _max: { approvedAt: true },
  });
  return new Date(
    Math.max(Date.now(), (last._max.approvedAt?.getTime() ?? 0) + 1),
  );
}

export const automationSettings = z
  .object({
    queueEnabled: z.boolean(),
    autoApprove: z.boolean(),
  })
  .strict()
  .refine((value) => !value.autoApprove || value.queueEnabled, {
    message: "Full auto approval requires the task queue to be running.",
  });
export async function setAutomation(
  userId: string,
  value: z.infer<typeof automationSettings>,
) {
  const settings = automationSettings.parse(value);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: settings });
    await audit(userId, "automation.changed", null, settings, {}, tx);
  });
  publish(userId);
  return settings;
}

export async function enqueueProposal(
  userId: string,
  id: string,
  version: number,
  automatic = false,
) {
  await db.$transaction(async (tx) => {
    if (
      automatic &&
      !(await tx.user.findUniqueOrThrow({ where: { id: userId } })).autoApprove
    )
      return;
    const proposal = await tx.proposal.findFirst({ where: { id, userId } });
    if (!proposal)
      throw new AppError("not_found", "This proposal was not found.", 404);
    if (proposal.status === "queued") return;
    const claim = await tx.proposal.updateMany({
      where: { id, userId, version, status: "pending" },
      data: {
        status: "queued",
        approvedBy: userId,
        approvedAt: await nextApprovalTime(tx, userId),
        version: { increment: 1 },
        error: null,
      },
    });
    if (!claim.count)
      throw new AppError(
        "proposal_changed",
        "This proposal changed. Refresh the queue.",
        409,
      );
    await audit(
      userId,
      "proposal.queued",
      proposal.agentId,
      { automatic, version },
      {
        proposalId: id,
        approvedBy: userId,
        actor: automatic ? "system" : "user",
      },
      tx,
    );
  });
  publish(userId);
  return { id, status: "queued" };
}

export const queuedTaskInput = z
  .object({
    agentId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(32000),
  })
  .strict();
export async function addQueuedTask(
  userId: string,
  input: z.infer<typeof queuedTaskInput>,
) {
  const value = queuedTaskInput.parse(input);
  const agent = await db.agent.findFirst({
    where: {
      id: value.agentId,
      userId,
      kind: "agent",
      archived: false,
      engine: { in: ["api", "claude-code"] },
    },
  });
  if (!agent)
    throw new AppError("not_found", "Choose an available worker.", 404);
  const action = agent.engine === "api" ? "send_message" : "dispatch_terminal";
  const proposal = await db.$transaction(async (tx) => {
    const task = await tx.proposal.create({
      data: {
        userId,
        runId: `manual-${randomUUID()}`,
        toolCallId: randomUUID(),
        action,
        agentId: agent.id,
        payload: JSON.stringify({ action, ...value }),
        status: "queued",
        origin: "manual_queue",
        approvedBy: userId,
        approvedAt: await nextApprovalTime(tx, userId),
      },
    });
    await audit(
      userId,
      "proposal.queued",
      agent.id,
      { automatic: false, source: "manual_queue" },
      { proposalId: task.id, approvedBy: userId },
      tx,
    );
    return task;
  });
  publish(userId);
  return { id: proposal.id, status: "queued" };
}

// Rechecked inside each execution transaction, including across Vizor windows.
export async function assertQueueCanRun(
  tx: Prisma.TransactionClient,
  userId: string,
  id: string,
) {
  const owner = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (!owner.queueEnabled)
    throw new AppError("queue_paused", "The task queue is paused.", 409);
  const first = await tx.proposal.findFirst({
    where: { userId, status: "queued" },
    orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
  });
  if (first?.id !== id || (await queueBusy(tx, userId)))
    throw new AppError(
      "queue_waiting",
      "Waiting for the earlier task to finish and report.",
      409,
    );
}
async function queueBusy(tx: Prisma.TransactionClient, userId: string) {
  return !!(
    (await tx.terminalDispatch.findFirst({
      where: { userId, status: { in: ["ready", "claimed", "delivered"] } },
    })) ||
    (await tx.run.findFirst({
      where: {
        userId,
        status: "running",
        conversation: { agent: { kind: "agent" } },
      },
    })) ||
    (await tx.proposal.findFirst({ where: { userId, status: "executing" } }))
  );
}

const state = globalThis as unknown as {
  vizorQueueTicks?: Map<string, Promise<void>>;
};
const ticks = (state.vizorQueueTicks ??= new Map());
export function processTaskQueue(userId: string) {
  const previous = ticks.get(userId);
  if (previous) return previous;
  const task = tick(userId).finally(() => ticks.delete(userId));
  ticks.set(userId, task);
  return task;
}
async function tick(userId: string) {
  const settings = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (settings.autoApprove) {
    const drafts = await db.proposal.findMany({
      where: { userId, status: "pending" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    for (const draft of drafts) {
      try {
        await enqueueProposal(userId, draft.id, draft.version, true);
      } catch (error) {
        if (!(error instanceof AppError && error.code === "proposal_changed"))
          throw error;
      }
    }
  }
  if (!settings.queueEnabled || (await queueBusy(db, userId))) return;
  const next = await db.proposal.findFirst({
    where: { userId, status: "queued" },
    orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
  });
  if (!next) return;
  try {
    const { approveProposal } = await import("./proposals");
    await approveProposal(userId, next.id, next.version);
  } catch (error) {
    if (
      error instanceof AppError &&
      ["queue_paused", "queue_waiting", "proposal_changed"].includes(error.code)
    )
      return;
    await db.$transaction(async (tx) => {
      const result = await tx.proposal.updateMany({
        where: { id: next.id, userId, status: "queued" },
        data: { status: "failed", error: safeError(error).message },
      });
      // An execution error pauses automation for review; never blindly resubmit.
      await tx.user.update({
        where: { id: userId },
        data: { queueEnabled: false, autoApprove: false },
      });
      await audit(
        userId,
        "queue.paused_after_error",
        next.agentId,
        { reason: safeError(error).message, changed: result.count },
        { actor: "system", proposalId: next.id },
        tx,
      );
    });
    publish(userId);
  }
}
