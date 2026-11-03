import { db } from "./db";
import { agentSchema } from "./validation";
import { requireProvider } from "./agents";
import { ORCHESTRATOR_PROMPT } from "./orchestrator-context";
import { AppError } from "./errors";
import { audit } from "./audit";
import { publish } from "./events";
import { subscriptionAvailable } from "./subscription";
export async function coordinator(userId: string) {
  const agent = await db.agent.findFirst({
    where: { userId, kind: "orchestrator" },
    select: { id: true },
  });
  if (!agent)
    throw new AppError(
      "orchestrator_required",
      "Choose a provider and model for your orchestrator first.",
    );
  return agent;
}
export async function configureOrchestrator(
  userId: string,
  config: {
    provider: string;
    model: string;
    maxTokens: number;
    temperature: number;
    projectInstructions?: string;
    orchestratorMode?: "api" | "subscription";
  },
) {
  const {
    projectInstructions,
    orchestratorMode = "api",
    ...modelConfig
  } = config;
  const subscription = orchestratorMode === "subscription";
  if (
    subscription &&
    (!subscriptionAvailable() ||
      !["sonnet", "opus", "haiku"].includes(config.model))
  )
    throw new AppError(
      "subscription_setup",
      "Choose a Claude subscription model in the Windows desktop app.",
    );
  const validated = agentSchema.parse({
    ...modelConfig,
    ...(subscription
      ? { provider: "anthropic", model: "claude-sonnet-4-6" }
      : {}),
    name: "Orchestrator",
    systemPrompt:
      ORCHESTRATOR_PROMPT +
      (config.projectInstructions?.trim()
        ? "\n\nProject instructions:\n" + config.projectInstructions.trim()
        : ""),
    color: "blue",
    icon: "spark",
  });
  if (subscription) validated.model = config.model;
  else await requireProvider(userId, config.provider);
  const result = await db.$transaction(async (tx) => {
    const existing = await tx.agent.findFirst({
      where: { userId, kind: "orchestrator" },
      include: { conversation: { select: { activeRunId: true } } },
    });
    if (existing?.conversation?.activeRunId)
      throw new AppError(
        "busy",
        "Stop the orchestrator before changing its model.",
        409,
      );
    if (projectInstructions === undefined && existing)
      validated.systemPrompt = existing.systemPrompt;
    const agent = existing
      ? await tx.agent.update({
          where: { id: existing.id },
          data: { ...validated, orchestratorMode },
        })
      : await tx.agent.create({
          data: {
            userId,
            kind: "orchestrator",
            ...validated,
            orchestratorMode,
            conversation: { create: {} },
          },
        });
    await audit(
      userId,
      "orchestrator.configured",
      agent.id,
      { provider: config.provider, model: config.model },
      {},
      tx,
    );
    return { id: agent.id };
  });
  publish(userId);
  return result;
}

export async function clearOrchestratorChat(userId: string) {
  let cancelledProposals = 0;
  let retiredTasks = 0;
  await db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { userId, kind: "orchestrator" },
      select: {
        id: true,
        conversation: { select: { id: true, activeRunId: true } },
      },
    });
    if (!agent?.conversation)
      throw new AppError("not_found", "The orchestrator was not found.", 404);
    if (agent.conversation.activeRunId)
      throw new AppError(
        "busy",
        "Stop the current orchestrator response before starting a new chat.",
        409,
      );

    const proposals = await tx.proposal.findMany({
      where: {
        userId,
        status: { in: ["pending", "queued"] },
      },
      select: { id: true, agentId: true },
    });
    if (proposals.length) {
      const ids = proposals.map((proposal) => proposal.id);
      const result = await tx.proposal.updateMany({
        where: {
          userId,
          id: { in: ids },
          status: { in: ["pending", "queued"] },
        },
        data: {
          status: "rejected",
          error: "Cancelled when the Orchestrator chat was cleared.",
        },
      });
      cancelledProposals = result.count;
    }

    // Approved but unsent tasks are safe to retire. A delivered task is only
    // retired when its terminal is stopped; running work is left untouched.
    const unsent = await tx.terminalDispatch.updateMany({
      where: {
        userId,
        status: "ready",
      },
      data: {
        status: "superseded",
        error:
          "Cancelled with the old Orchestrator chat; this task was not sent.",
      },
    });
    const stopped = await tx.terminalDispatch.updateMany({
      where: {
        userId,
        status: "delivered",
        agent: { userId, terminalState: "stopped" },
      },
      data: {
        status: "superseded",
        error:
          "No report was received; retired when the Orchestrator chat was cleared.",
      },
    });
    retiredTasks = unsent.count + stopped.count;
    await tx.user.update({
      where: { id: userId },
      data: { queueEnabled: false, autoApprove: false },
    });

    await tx.message.deleteMany({
      where: {
        conversationId: agent.conversation.id,
        conversation: { agent: { userId, kind: "orchestrator" } },
      },
    });
    await tx.agent.updateMany({
      where: { id: agent.id, userId, kind: "orchestrator" },
      data: { contextSummary: "", summaryThroughPosition: -1 },
    });
    await audit(
      userId,
      "orchestrator.chat_cleared",
      agent.id,
      { cancelledProposals, retiredTasks },
      {},
      tx,
    );
  });
  publish(userId);
  return { ok: true, cancelledProposals, retiredTasks };
}
