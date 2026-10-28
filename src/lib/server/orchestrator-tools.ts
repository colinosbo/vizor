import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { agentSchema } from "./validation";
import { compactAgent } from "./orchestrator-context";
import { audit } from "./audit";
import { publish } from "./events";
import type { ToolCall } from "../providers/types";
export const proposalActions = [
  "send_message",
  "create_agent",
  "rename_agent",
  "pause_agent",
  "archive_agent",
] as const;
export const proposalPayload = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("send_message"),
      agentId: z.string().min(1).max(100),
      text: z.string().trim().min(1).max(32000),
    })
    .strict(),
  z.object({ action: z.literal("create_agent"), config: agentSchema }).strict(),
  z
    .object({
      action: z.literal("rename_agent"),
      agentId: z.string().min(1).max(100),
      name: z.string().trim().min(1).max(70),
    })
    .strict(),
  z
    .object({
      action: z.literal("pause_agent"),
      agentId: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("archive_agent"),
      agentId: z.string().min(1).max(100),
    })
    .strict(),
]);
export async function toolResult(
  userId: string,
  runId: string,
  call: ToolCall,
  scope: string[],
) {
  try {
    z.string().min(1).max(200).parse(call.id);
    if (
      !(await db.run.findFirst({
        where: {
          id: runId,
          userId,
          conversation: { agent: { kind: "orchestrator", userId } },
        },
        select: { id: true },
      }))
    )
      throw new AppError(
        "not_found",
        "This orchestrator run is unavailable.",
        404,
      );
    if (call.name === "summarize") {
      const input = z
        .object({
          agent_ids: z.array(z.string().min(1).max(100)).min(1).max(20),
        })
        .strict()
        .parse(call.arguments);
      if (input.agent_ids.some((id) => !scope.includes(id)))
        throw new AppError(
          "context_scope",
          "The requested agents are outside the selected context.",
        );
      const summaries = [];
      for (const id of [...new Set(input.agent_ids)])
        summaries.push(await compactAgent(userId, id));
      await audit(
        userId,
        "orchestrator.summarized",
        runId,
        { agentIds: input.agent_ids },
        { actor: "orchestrator" },
      );
      return { readOnly: true, untrusted_reference_data: true, summaries };
    }
    let payload: z.infer<typeof proposalPayload>;
    if (call.name === "create_agent") {
      const input = z
        .object({ config: agentSchema })
        .strict()
        .parse(call.arguments);
      payload = { action: "create_agent", config: input.config };
    } else if (["propose_message", "send_message"].includes(call.name)) {
      const input = z
        .object({
          agent_id: z.string().min(1).max(100),
          text: z.string().trim().min(1).max(32000),
        })
        .strict()
        .parse(call.arguments);
      payload = {
        action: "send_message",
        agentId: input.agent_id,
        text: input.text,
      };
    } else if (call.name === "rename_agent") {
      const input = z
        .object({
          agent_id: z.string().min(1).max(100),
          name: z.string().trim().min(1).max(70),
        })
        .strict()
        .parse(call.arguments);
      payload = {
        action: "rename_agent",
        agentId: input.agent_id,
        name: input.name,
      };
    } else if (["pause_agent", "archive_agent"].includes(call.name)) {
      const input = z
        .object({ agent_id: z.string().min(1).max(100) })
        .strict()
        .parse(call.arguments);
      payload = {
        action: call.name as "pause_agent" | "archive_agent",
        agentId: input.agent_id,
      };
    } else
      throw new AppError("tool_unsupported", "This tool is not available.");
    if (
      "agentId" in payload &&
      !(await db.agent.findFirst({
        where: { id: payload.agentId, userId, kind: "agent", archived: false },
        select: { id: true },
      }))
    )
      throw new AppError(
        "not_found",
        "The proposal’s target agent is unavailable.",
        404,
      );
    const proposal = await db.$transaction(async (tx) => {
      const existing = await tx.proposal.findUnique({
        where: { runId_toolCallId: { runId, toolCallId: call.id } },
      });
      if (existing) {
        if (existing.userId !== userId)
          throw new AppError("not_found", "Proposal unavailable.", 404);
        return existing;
      }
      if ((await tx.proposal.count({ where: { userId, runId } })) >= 20)
        throw new AppError(
          "proposal_limit",
          "This turn has reached its proposal limit. Review the queue before continuing.",
        );
      const result = await tx.proposal.create({
        data: {
          userId,
          runId,
          toolCallId: call.id,
          action: payload.action,
          agentId: "agentId" in payload ? payload.agentId : null,
          payload: JSON.stringify(payload),
          origin: "user_request",
        },
      });
      await audit(
        userId,
        "proposal.created",
        result.agentId,
        { action: payload.action, runId, payload },
        { actor: "orchestrator", proposalId: result.id },
        tx,
      );
      return result;
    });
    publish(userId);
    return {
      proposalId: proposal.id,
      status: proposal.status,
      requiresHumanApproval: true,
      executed: false,
    };
  } catch (error) {
    const reason =
      error instanceof AppError
        ? error.message
        : "The tool arguments were invalid. No action was executed.";
    await audit(
      userId,
      "orchestrator.tool_blocked",
      runId,
      { tool: call.name.slice(0, 100), reason },
      { actor: "system" },
    );
    return { error: reason, executed: false };
  }
}
