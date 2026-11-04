import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { agentSchema } from "./validation";
import { compactAgent } from "./orchestrator-context";
import { audit } from "./audit";
import { publish } from "./events";
import type { ToolCall } from "../providers/types";
import { answerWorkerQuestion } from "./worker-questions";
import { writePathsSchema } from "./work-scopes";
import { requireCodingWorker, requireProjectFolder } from "./projects";
export const proposalActions = [
  "send_message",
  "dispatch_terminal",
  "create_terminal_agent",
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
  z
    .object({
      action: z.literal("dispatch_terminal"),
      agentId: z.string().min(1).max(100),
      text: z.string().trim().min(1).max(32000),
      writePaths: writePathsSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create_terminal_agent"),
      config: z
        .object({
          name: z.string().trim().min(1).max(70),
          projectPath: z.string().min(3).max(4096),
          systemPrompt: z.string().max(16000),
          color: z.enum(["mint", "amber", "blue", "rose"]),
          icon: z.enum(["spark", "code", "pen", "search"]),
        })
        .strict(),
      text: z.string().trim().max(32000),
      writePaths: writePathsSchema.optional(),
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
    const sourceRun = await db.run.findFirst({
      where: {
        id: runId,
        userId,
        conversation: { agent: { kind: "orchestrator", userId } },
      },
      select: {
        id: true,
        conversation: { select: { agent: { select: { projectId: true } } } },
      },
    });
    if (!sourceRun)
      throw new AppError(
        "not_found",
        "This orchestrator run is unavailable.",
        404,
      );
    const projectId = sourceRun.conversation.agent.projectId;
    if (call.name === "finish_project") {
      if (!projectId)
        throw new AppError(
          "project_required",
          "Choose a project before requesting a merge.",
          400,
        );
      const { requestProjectMerge } = await import("./project-merge");
      return await requestProjectMerge(userId, projectId, runId, call);
    }
    if (call.name === "answer_worker_question")
      return await answerWorkerQuestion(userId, runId, call);
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
      if (projectId)
        throw new AppError(
          "coding_workers_only",
          "Projects use Claude Code coding workers.",
          400,
        );
      const input = z
        .object({ config: agentSchema })
        .strict()
        .parse(call.arguments);
      if (input.config.engine !== "api")
        throw new AppError(
          "terminal_manual",
          "Create terminal agents directly from the dashboard.",
        );
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
    } else if (call.name === "dispatch_terminal") {
      const input = z
        .object({
          agent_id: z.string().min(1).max(100),
          text: z.string().trim().min(1).max(32000),
          write_paths: writePathsSchema.default([]),
        })
        .strict()
        .parse(call.arguments);
      payload = {
        action: "dispatch_terminal",
        agentId: input.agent_id,
        text: input.text,
        writePaths: input.write_paths,
      };
    } else if (call.name === "create_terminal_agent") {
      const input = z
        .object({
          name: z.string().trim().min(1).max(70),
          project_path: z.string().min(3).max(4096),
          role_prompt: z.string().max(16000),
          color: z.enum(["mint", "amber", "blue", "rose"]),
          icon: z.enum(["spark", "code", "pen", "search"]),
          task: z.string().trim().max(32000),
          write_paths: writePathsSchema.default([]),
        })
        .strict()
        .parse(call.arguments);
      if (projectId) requireCodingWorker(input.name, input.role_prompt);
      const config = agentSchema.parse({
        name: input.name,
        engine: "claude-code",
        projectPath: input.project_path,
        provider: "anthropic",
        model: "claude-code",
        systemPrompt: input.role_prompt,
        temperature: 0.2,
        maxTokens: 4096,
        color: input.color,
        icon: input.icon,
      });
      if (projectId) {
        const project = await db.project.findFirst({
          where: { id: projectId, userId },
        });
        if (!project)
          throw new AppError(
            "project_folder",
            "Workers must use the selected project folder.",
            400,
          );
        requireProjectFolder(project.folder, config.projectPath);
      }
      payload = {
        action: "create_terminal_agent",
        config: {
          name: config.name,
          projectPath: config.projectPath,
          systemPrompt: config.systemPrompt,
          color: config.color,
          icon: config.icon,
        },
        text: input.task,
        writePaths: input.write_paths,
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
    const terminalDispatch = payload.action === "dispatch_terminal";
    if (
      "agentId" in payload &&
      !(await db.agent.findFirst({
        where: {
          id: payload.agentId,
          userId,
          projectId,
          kind: "agent",
          archived: false,
          engine: terminalDispatch ? "claude-code" : "api",
        },
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
          projectId,
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
    const settings = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { autoApprove: true },
    });
    if (settings.autoApprove && proposal.status === "pending") {
      const { enqueueProposal } = await import("./task-queue");
      await enqueueProposal(userId, proposal.id, proposal.version, true);
      const current = await db.proposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      return {
        proposalId: proposal.id,
        status: current.status,
        requiresHumanApproval: current.status === "pending",
        executed: false,
      };
    }
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
