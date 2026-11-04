import { db } from "./db";
import { AppError } from "./errors";
import { audit } from "./audit";
import { publish } from "./events";
import { reportInstructions } from "./terminal-reports";
import { parseWritePaths, scopesConflict } from "./work-scopes";

async function ownedDispatch(userId: string, proposalId: string) {
  const dispatch = await db.terminalDispatch.findFirst({
    where: { userId, proposalId },
    select: {
      id: true,
      agentId: true,
      text: true,
      status: true,
      writePaths: true,
    },
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
      select: { projectPath: true, projectId: true },
    });
    if (!agent)
      throw new AppError(
        "worker_unavailable",
        "This worker is paused or unavailable.",
        409,
      );
    const merges = await tx.mergeJob.findMany({
      where: {
        userId,
        status: {
          in: [
            "queued",
            "checking",
            "waiting_checks",
            "merging",
            "waiting_merge",
          ],
        },
      },
      select: { project: { select: { folder: true } } },
    });
    if (
      merges.some((job) =>
        scopesConflict(agent.projectPath, [], job.project.folder, []),
      )
    )
      throw new AppError(
        "merge_busy",
        "GitHub verification is using this project folder. Wait for it to finish.",
        409,
      );
    const others = await tx.terminalDispatch.findMany({
      where: {
        userId,
        id: { not: dispatch.id },
        status: { in: ["claimed", "delivered"] },
      },
      select: {
        agentId: true,
        writePaths: true,
        agent: { select: { projectPath: true, projectId: true } },
      },
    });
    const paths = parseWritePaths(dispatch.writePaths);
    const conflict = others.some(
      (other) =>
        other.agentId === dispatch.agentId ||
        (agent.projectId &&
          other.agent.projectId !== agent.projectId &&
          scopesConflict(agent.projectPath, [], other.agent.projectPath, [])) ||
        (agent.projectId
          ? scopesConflict(
              agent.projectPath,
              paths,
              other.agent.projectPath,
              parseWritePaths(other.writePaths),
            )
          : automatic &&
            other.agent.projectPath.toLowerCase() ===
              agent.projectPath.toLowerCase()),
    );
    if (conflict)
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
      select: { projectPath: true, projectId: true },
    });
    return {
      agentId: dispatch.agentId,
      sharedApproved:
        !!agent.projectId && parseWritePaths(dispatch.writePaths).length > 0,
      text:
        dispatch.text +
        (parseWritePaths(dispatch.writePaths).length
          ? `\n\nVIZOR WRITE SCOPE\nEdit only these project-relative paths: ${parseWritePaths(dispatch.writePaths).join(", ")}. Other workers may edit different paths concurrently. Do not run Git commit, checkout, reset, merge, rebase, push, or pull while parallel tasks are running; report when your scoped edits are ready.`
          : "") +
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

export async function cancelTerminalDispatch(
  userId: string,
  proposalId: string,
) {
  const dispatch = await ownedDispatch(userId, proposalId);
  await db.$transaction(async (tx) => {
    const result = await tx.terminalDispatch.updateMany({
      where: { id: dispatch.id, userId, status: "ready" },
      data: {
        status: "superseded",
        error: "Cancelled by the user before delivery.",
      },
    });
    if (!result.count)
      throw new AppError(
        "dispatch_unavailable",
        "Only an unsent task can be cancelled. Check the worker before stopping delivered work.",
        409,
      );
    await audit(
      userId,
      "terminal_task.cancelled",
      dispatch.agentId,
      {},
      { proposalId },
      tx,
    );
  });
  publish(userId);
}
