import { randomUUID } from "node:crypto";
import { db } from "./db";
import { AppError, safeError } from "./errors";
import { proposalPayload } from "./orchestrator-tools";
import { audit } from "./audit";
import { publish } from "./events";
import { startChat, stopAgent } from "./chat";
export async function ownedProposal(userId: string, id: string) {
  const proposal = await db.proposal.findFirst({ where: { id, userId } });
  if (!proposal)
    throw new AppError("not_found", "This proposal was not found.", 404);
  return proposal;
}
export async function editProposal(
  userId: string,
  id: string,
  version: number,
  value: unknown,
) {
  const original = await ownedProposal(userId, id);
  const payload = proposalPayload.parse(value);
  if (payload.action !== original.action)
    throw new AppError(
      "proposal_target",
      "Editing cannot change a proposal’s action.",
    );
  if (
    "agentId" in payload &&
    !(await db.agent.findFirst({
      where: {
        id: payload.agentId,
        userId,
        kind: "agent",
        archived: false,
        engine: "api",
      },
      select: { id: true },
    }))
  )
    throw new AppError("not_found", "The selected target is unavailable.", 404);
  await db.$transaction(async (tx) => {
    const result = await tx.proposal.updateMany({
      where: { id, userId, status: "pending", version },
      data: {
        payload: JSON.stringify(payload),
        agentId: "agentId" in payload ? payload.agentId : null,
        version: { increment: 1 },
        error: null,
      },
    });
    if (!result.count)
      throw new AppError(
        "proposal_changed",
        "This proposal changed or was already reviewed. Refresh the queue.",
        409,
      );
    await audit(
      userId,
      "proposal.edited",
      original.agentId,
      {
        fromVersion: version,
        toVersion: version + 1,
        before: JSON.parse(original.payload),
        after: payload,
      },
      { proposalId: id },
      tx,
    );
  });
  publish(userId);
}
export async function rejectProposal(
  userId: string,
  id: string,
  version: number,
) {
  const proposal = await ownedProposal(userId, id);
  await db.$transaction(async (tx) => {
    const result = await tx.proposal.updateMany({
      where: { id, userId, status: "pending", version },
      data: { status: "rejected", version: { increment: 1 } },
    });
    if (!result.count)
      throw new AppError(
        "proposal_changed",
        "This proposal changed or was already reviewed. Refresh the queue.",
        409,
      );
    await audit(
      userId,
      "proposal.rejected",
      proposal.agentId,
      {},
      { proposalId: id },
      tx,
    );
  });
  publish(userId);
}
async function failProposal(userId: string, id: string, error: unknown) {
  const safe = safeError(error);
  await db.$transaction(async (tx) => {
    await tx.proposal.updateMany({
      where: { id, userId },
      data: { status: "failed", error: safe.message },
    });
    await audit(
      userId,
      "proposal.failed",
      null,
      { code: safe.code, reason: safe.message },
      { actor: "system", proposalId: id, approvedBy: userId },
      tx,
    );
  });
  publish(userId);
}
export async function approveProposal(
  userId: string,
  id: string,
  version: number,
) {
  const existing = await ownedProposal(userId, id);
  if (["approved", "executing"].includes(existing.status))
    return {
      id,
      status: existing.status,
      runId: existing.resultRunId,
      alreadyReviewed: true,
    };
  const payload = proposalPayload.parse(JSON.parse(existing.payload));
  if (payload.action !== "send_message") {
    let stopId: string | undefined;
    await db.$transaction(async (tx) => {
      const claim = await tx.proposal.updateMany({
        where: { id, userId, status: "pending", version },
        data: {
          status: "approved",
          approvedBy: userId,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (!claim.count)
        throw new AppError(
          "proposal_changed",
          "This proposal changed or was already reviewed. Refresh the queue.",
          409,
        );
      await audit(
        userId,
        "proposal.approved",
        existing.agentId,
        { action: payload.action, version, payload },
        { proposalId: id, approvedBy: userId },
        tx,
      );
      let subjectId: string;
      if (payload.action === "create_agent") {
        if (payload.config.engine !== "api")
          throw new AppError(
            "terminal_manual",
            "Create terminal agents directly from the dashboard.",
          );
        if (
          !(await tx.credential.findUnique({
            where: {
              userId_provider: { userId, provider: payload.config.provider },
            },
            select: { id: true },
          }))
        )
          throw new AppError(
            "provider_required",
            "Connect the proposed agent’s provider before approval.",
          );
        const agent = await tx.agent.create({
          data: { userId, ...payload.config, conversation: { create: {} } },
          select: { id: true },
        });
        subjectId = agent.id;
      } else {
        const agent = await tx.agent.findFirst({
          where: {
            id: payload.agentId,
            userId,
            kind: "agent",
            archived: false,
            engine: "api",
          },
          select: { id: true },
        });
        if (!agent)
          throw new AppError(
            "not_found",
            "The target agent is unavailable.",
            404,
          );
        subjectId = agent.id;
        await tx.agent.update({
          where: { id: agent.id },
          data:
            payload.action === "rename_agent"
              ? { name: payload.name }
              : payload.action === "pause_agent"
                ? { paused: true }
                : { archived: true },
        });
        if (payload.action !== "rename_agent") stopId = agent.id;
      }
      await audit(
        userId,
        payload.action,
        subjectId,
        payload.action === "rename_agent" ? { name: payload.name } : {},
        { actor: "orchestrator", proposalId: id, approvedBy: userId },
        tx,
      );
    });
    if (stopId) stopAgent(userId, stopId);
    publish(userId);
    return { id, status: "approved", runId: null };
  }
  await db.$transaction(async (tx) => {
    const claim = await tx.proposal.updateMany({
      where: { id, userId, status: "pending", version },
      data: {
        status: "executing",
        approvedBy: userId,
        approvedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (!claim.count)
      throw new AppError(
        "proposal_changed",
        "This proposal changed or was already reviewed. Refresh the queue.",
        409,
      );
    await audit(
      userId,
      "proposal.approved",
      payload.agentId,
      { action: payload.action, version, payload },
      { proposalId: id, approvedBy: userId },
      tx,
    );
  });
  publish(userId);
  try {
    const response = await startChat(
      userId,
      payload.agentId,
      { clientId: randomUUID(), mode: "send", text: payload.text },
      undefined,
      { proposalId: id },
    );
    const run = await db.run.findFirstOrThrow({
      where: { userId, proposalId: id },
      select: { id: true },
    });
    await db.proposal.updateMany({
      where: { id, userId },
      data: { status: "approved", resultRunId: run.id },
    });
    publish(userId);
    // Explicitly approved messages continue in the local Node process until stopped.
    void (async () => {
      const reader = response.body?.getReader();
      let failure: string | undefined;
      const decoder = new TextDecoder();
      let pending = "";
      if (reader)
        while (true) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          let at: number;
          while ((at = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, at);
            pending = pending.slice(at + 2);
            if (frame.startsWith("event: error")) {
              const raw = frame.match(/^data: (.+)$/m)?.[1];
              if (raw) failure = JSON.parse(raw).message;
            }
          }
          if (done) break;
        }
      if (failure)
        await failProposal(
          userId,
          id,
          new AppError("delivery_failed", failure),
        );
    })().catch(async (error) => {
      await failProposal(userId, id, error).catch(() => {});
    });
    return { id, status: "approved", runId: run.id };
  } catch (error) {
    await failProposal(userId, id, error);
    throw error;
  }
}
export async function approveMany(
  userId: string,
  items: { id: string; version: number }[],
) {
  const ids = items.map((item) => item.id);
  if (
    new Set(ids).size !== ids.length ||
    (await db.proposal.count({ where: { userId, id: { in: ids } } })) !==
      ids.length
  )
    throw new AppError(
      "not_found",
      "One or more proposals were not found.",
      404,
    );
  const results = [];
  for (const item of items) {
    try {
      results.push(await approveProposal(userId, item.id, item.version));
    } catch (error) {
      results.push({
        id: item.id,
        status: "failed",
        error: safeError(error).message,
      });
    }
  }
  return results;
}
