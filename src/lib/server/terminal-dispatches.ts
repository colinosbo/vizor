import { db } from "./db";
import { AppError } from "./errors";
import { audit } from "./audit";
import { publish } from "./events";
import { reportInstructions } from "./terminal-reports";

async function ownedDispatch(userId: string, proposalId: string) {
  const dispatch = await db.terminalDispatch.findFirst({
    where: { userId, proposalId },
    select: { id: true, agentId: true, text: true, status: true },
  });
  if (!dispatch)
    throw new AppError("not_found", "This terminal task was not found.", 404);
  return dispatch;
}

export async function recoverTerminalDispatches() {
  const cutoff = new Date(Date.now() - 2 * 60_000);
  await db.$transaction(async (tx) => {
    const stale = await tx.terminalDispatch.findMany({
      where: { status: "claimed", claimedAt: { lt: cutoff } },
      select: { userId: true },
    });
    await tx.terminalDispatch.updateMany({
      where: { status: "claimed", claimedAt: { lt: cutoff } },
      data: {
        status: "failed",
        error:
          "Delivery could not be confirmed. Check the terminal before adding another task; Vizor will not resend it automatically.",
      },
    });
    if (stale.length)
      await tx.user.updateMany({
        where: { id: { in: stale.map((item) => item.userId) } },
        data: { queueEnabled: false, autoApprove: false },
      });
  });
}

export async function claimTerminalDispatch(
  userId: string,
  proposalId: string,
  automatic = false,
) {
  await recoverTerminalDispatches();
  const dispatch = await ownedDispatch(userId, proposalId);
  const claim = await db.$transaction(async (tx) => {
    if (
      automatic &&
      !(await tx.user.findUniqueOrThrow({ where: { id: userId } })).queueEnabled
    )
      throw new AppError("queue_paused", "The task queue is paused.", 409);
    const agent = await tx.agent.findFirst({
      where: { id: dispatch.agentId, userId, archived: false, paused: false },
      select: { projectPath: true },
    });
    if (!agent)
      throw new AppError(
        "worker_unavailable",
        "This worker is paused or unavailable.",
        409,
      );
    const other = await tx.terminalDispatch.findFirst({
      where: {
        userId,
        id: { not: dispatch.id },
        status: { in: ["claimed", "delivered"] },
        ...(automatic
          ? { agent: { projectPath: agent.projectPath } }
          : { agentId: dispatch.agentId }),
      },
    });
    if (other)
      throw new AppError(
        "worker_busy",
        "Waiting for the previous project task's report.",
        409,
      );
    return tx.terminalDispatch.updateMany({
      where: { id: dispatch.id, userId, status: "ready" },
      data: { status: "claimed", claimedAt: new Date(), error: null },
    });
  });
  if (!claim.count)
    throw new AppError(
      "dispatch_unavailable",
      dispatch.status === "delivered"
        ? "This task was already sent to the terminal."
        : "This task is already being sent from another Vizor window.",
      409,
    );
  await audit(userId, "terminal_task.claimed", dispatch.agentId, {}, {});
  publish(userId);
  try {
    const agent = await db.agent.findFirstOrThrow({
      where: { id: dispatch.agentId, userId },
      select: { projectPath: true },
    });
    return {
      agentId: dispatch.agentId,
      text:
        dispatch.text +
        (await reportInstructions(agent.projectPath, dispatch.id)),
    };
  } catch {
    await db.terminalDispatch.updateMany({
      where: { id: dispatch.id, userId, status: "claimed" },
      data: {
        status: "ready",
        claimedAt: null,
        error:
          "Task report folder is unavailable. Check the project folder and retry.",
      },
    });
    throw new AppError(
      "report_folder",
      "Task report folder is unavailable. Check the project folder and retry.",
      409,
    );
  }
}

export async function completeTerminalDispatch(
  userId: string,
  proposalId: string,
) {
  const dispatch = await ownedDispatch(userId, proposalId);
  const result = await db.terminalDispatch.updateMany({
    where: { id: dispatch.id, userId, status: "claimed" },
    data: { status: "delivered", deliveredAt: new Date(), error: null },
  });
  if (!result.count)
    throw new AppError(
      "dispatch_unavailable",
      "This task can no longer be marked as delivered.",
      409,
    );
  await audit(userId, "terminal_task.delivered", dispatch.agentId, {}, {});
  publish(userId);
}

export async function releaseTerminalDispatch(
  userId: string,
  proposalId: string,
  reason: string,
) {
  const dispatch = await ownedDispatch(userId, proposalId);
  await db.terminalDispatch.updateMany({
    where: { id: dispatch.id, userId, status: "claimed" },
    data: { status: "ready", claimedAt: null, error: reason.slice(0, 500) },
  });
  await audit(
    userId,
    "terminal_task.released",
    dispatch.agentId,
    { reason: reason.slice(0, 500) },
    {},
  );
  publish(userId);
}
