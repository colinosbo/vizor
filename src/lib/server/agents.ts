import type { z } from "zod";
import { db } from "./db";
import { agentSchema, layoutSchema } from "./validation";
import { ownedAgent } from "./store";
import { stopAgent } from "./chat";
import { publish } from "./events";
import { AppError } from "./errors";
export async function requireProvider(userId: string, provider: string) {
  const key = await db.credential.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { id: true },
  });
  if (!key)
    throw new AppError(
      "provider_required",
      "Connect this provider in API keys before using it for an agent.",
    );
}
export async function createAgent(
  userId: string,
  config: z.infer<typeof agentSchema>,
) {
  await requireProvider(userId, config.provider);
  const agent = await db.agent.create({
    data: { userId, ...config, conversation: { create: {} } },
    select: { id: true },
  });
  publish(userId);
  return agent;
}
export async function editAgent(
  userId: string,
  id: string,
  config: z.infer<typeof agentSchema>,
) {
  await ownedAgent(userId, id);
  await requireProvider(userId, config.provider);
  await db.$transaction(async (tx) => {
    const result = await tx.agent.updateMany({
      where: { id, userId, conversation: { activeRunId: null } },
      data: config,
    });
    if (!result.count)
      throw new AppError(
        "busy",
        "Stop the current response before changing agent settings.",
        409,
      );
  });
  publish(userId);
}
export async function agentAction(
  userId: string,
  id: string,
  action: "duplicate" | "archive" | "restore" | "pause" | "resume",
) {
  const agent = await ownedAgent(userId, id);
  if (action === "duplicate") {
    const config = agentSchema.parse({
      name: `${agent.name.slice(0, 64)} copy`,
      provider: agent.provider,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      color: agent.color,
      icon: agent.icon,
    });
    return createAgent(userId, config);
  }
  await db.agent.updateMany({
    where: { id, userId },
    data:
      action === "archive"
        ? { archived: true }
        : action === "restore"
          ? { archived: false }
          : { paused: action === "pause" },
  });
  if (action === "archive" || action === "pause") stopAgent(userId, id);
  publish(userId);
  return { id };
}
export async function saveLayout(
  userId: string,
  layout: z.infer<typeof layoutSchema>,
) {
  const ids = new Set([
    ...layout.order,
    ...layout.pinned,
    ...layout.collapsed,
    ...(layout.activeId ? [layout.activeId] : []),
    ...Object.values(layout.layouts).flatMap((items) =>
      items.map((item) => item.i),
    ),
  ]);
  const owned = await db.agent.count({
    where: { userId, id: { in: [...ids] } },
  });
  if (owned !== ids.size)
    throw new AppError(
      "not_found",
      "One or more layout agents were not found.",
      404,
    );
  await db.user.update({
    where: { id: userId },
    data: { workspaceLayout: JSON.stringify(layout) },
  });
  publish(userId);
}
