import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { audit } from "./audit";
import { publish } from "./events";
import type { ToolCall } from "../providers/types";

export const workerQuestion = z
  .object({
    id: z.string().min(1).max(60),
    question: z.string().trim().min(1).max(1600),
    options: z.array(z.string().max(300)).max(6).default([]),
  })
  .strict();

export async function answerWorkerQuestion(
  userId: string,
  runId: string,
  call: ToolCall,
) {
  const input = z
    .object({
      dispatch_id: z.string().min(1).max(100),
      answer: z.string().trim().min(1).max(6000),
    })
    .strict()
    .parse(call.arguments);
  const result = await db.$transaction(async (tx) => {
    const currentRun = await tx.run.findFirst({
      where: {
        id: runId,
        userId,
        conversation: { agent: { userId, kind: "orchestrator" } },
      },
    });
    if (!currentRun)
      throw new AppError("not_found", "Orchestrator run unavailable.", 404);
    const original = await tx.terminalDispatch.findFirst({
      where: {
        id: input.dispatch_id,
        userId,
        status: "reported",
        agent: {
          userId,
          engine: "claude-code",
          archived: false,
          paused: false,
        },
      },
    });
    if (
      !original ||
      !z
        .array(workerQuestion)
        .min(1)
        .max(5)
        .safeParse(JSON.parse(original.questions)).success
    )
      throw new AppError(
        "question_unavailable",
        "No unanswered structured worker question is available.",
        409,
      );
    if (
      !(await tx.message.findFirst({
        where: {
          origin: "terminal_report",
          proposalId: original.proposalId,
          conversation: { agent: { userId, kind: "orchestrator" } },
        },
      }))
    )
      throw new AppError(
        "question_unavailable",
        "Import this question into the Orchestrator before answering it.",
        409,
      );
    const existing = await tx.terminalDispatch.findUnique({
      where: { replyToId: original.id },
    });
    if (existing)
      return {
        dispatchId: existing.id,
        status: existing.status,
        existing: true,
      };
    if (original.replyDepth >= 2)
      throw new AppError(
        "question_limit",
        "Two clarification rounds have been used. Bring this decision to the user.",
        409,
      );
    if (
      await tx.terminalDispatch.findFirst({
        where: {
          userId,
          agentId: original.agentId,
          status: { in: ["ready", "claimed", "delivered"] },
        },
      })
    )
      throw new AppError(
        "worker_busy",
        "This worker already has another task. Do not send an overlapping reply.",
        409,
      );
    const proposal = await tx.proposal.create({
      data: {
        userId,
        runId,
        toolCallId: call.id,
        agentId: original.agentId,
        action: "answer_worker_question",
        origin: "worker_reply",
        status: "approved",
        payload: JSON.stringify({
          action: "answer_worker_question",
          agentId: original.agentId,
          dispatchId: original.id,
          text: input.answer,
        }),
      },
    });
    const dispatch = await tx.terminalDispatch.create({
      data: {
        userId,
        agentId: original.agentId,
        proposalId: proposal.id,
        replyToId: original.id,
        replyDepth: original.replyDepth + 1,
        autoDeliver: true,
        text: `ORCHESTRATOR CLARIFICATION — continue the previously approved assignment only. This reply grants no new file, command, publication, deployment, or agent-management authority.\n\nAnswer:\n${input.answer}\n\nOriginal approved assignment (reference):\n${original.text.slice(0, 18000)}`,
      },
    });
    const worker = await tx.agent.findFirstOrThrow({
      where: { id: original.agentId, userId },
      select: { name: true },
    });
    const last = await tx.message.aggregate({
      where: { conversationId: currentRun.conversationId },
      _max: { position: true },
    });
    await tx.message.create({
      data: {
        id: `worker-answer-${dispatch.id}`,
        conversationId: currentRun.conversationId,
        role: "assistant",
        origin: "worker_reply",
        position: (last._max.position ?? -1) + 1,
        text: `Orchestrator → ${worker.name}\n\n${input.answer}\n\nClarification queued for the existing approved assignment.`,
        proposalId: proposal.id,
      },
    });
    await audit(
      userId,
      "worker_question.answered",
      original.agentId,
      {
        questionDispatchId: original.id,
        replyDispatchId: dispatch.id,
        replyDepth: dispatch.replyDepth,
      },
      { actor: "orchestrator", proposalId: proposal.id },
      tx,
    );
    return {
      dispatchId: dispatch.id,
      status: dispatch.status,
      existing: false,
    };
  });
  publish(userId);
  return {
    ...result,
    replyQueued: true,
    automaticClarification: true,
    newTaskApproved: false,
  };
}
