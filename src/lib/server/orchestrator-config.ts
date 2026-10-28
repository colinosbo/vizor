import { db } from "./db";
import { agentSchema } from "./validation";
import { requireProvider } from "./agents";
import { ORCHESTRATOR_PROMPT } from "./orchestrator-context";
import { AppError } from "./errors";
import { audit } from "./audit";
import { publish } from "./events";
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
  },
) {
  const validated = agentSchema.parse({
    ...config,
    name: "Orchestrator",
    systemPrompt: ORCHESTRATOR_PROMPT,
    color: "blue",
    icon: "spark",
  });
  await requireProvider(userId, config.provider);
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
    const agent = existing
      ? await tx.agent.update({ where: { id: existing.id }, data: validated })
      : await tx.agent.create({
          data: {
            userId,
            kind: "orchestrator",
            ...validated,
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
