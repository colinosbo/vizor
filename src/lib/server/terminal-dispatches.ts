import { db } from "./db";
import { AppError } from "./errors";
import { audit } from "./audit";
import { publish } from "./events";

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
  await db.terminalDispatch.updateMany({
    where: { status: "claimed", claimedAt: { lt: cutoff } },
    data: {
      status: "ready",
      claimedAt: null,
      error: "The previous terminal delivery did not finish. Retry when ready.",
    },
  });
}

export async function claimTerminalDispatch(
  userId: string,
  proposalId: string,
) {
  await recoverTerminalDispatches();
  const dispatch = await ownedDispatch(userId, proposalId);
  const claim = await db.terminalDispatch.updateMany({
    where: { id: dispatch.id, userId, status: "ready" },
    data: { status: "claimed", claimedAt: new Date(), error: null },
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
  return { agentId: dispatch.agentId, text: dispatch.text };
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
