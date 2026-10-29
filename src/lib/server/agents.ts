import type { z } from "zod";
import { db } from "./db";
import { agentSchema, layoutSchema } from "./validation";
import { ownedAgent } from "./store";
import { stopAgent } from "./chat";
import { publish } from "./events";
import { AppError } from "./errors";
import { audit } from "./audit";
import { selfHost } from "./security";
import { randomUUID } from "node:crypto";
function requireEngine(config: z.infer<typeof agentSchema>) {
  if (
    config.engine !== "api" &&
    (!selfHost() || process.env.VIZOR_TERMINALS !== "1")
  )
    throw new AppError(
      "desktop_required",
      "Terminal agents are available in the Windows desktop app.",
      403,
    );
}
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
  input: z.input<typeof agentSchema>,
) {
  const config = agentSchema.parse(input);
  requireEngine(config);
  if (config.engine === "api") await requireProvider(userId, config.provider);
  const agent = await db.$transaction(async (tx) => {
    const created = await tx.agent.create({
      data: {
        userId,
        ...config,
        nativeSessionId: config.engine === "claude-code" ? randomUUID() : null,
        conversation: { create: {} },
      },
      select: { id: true },
    });
    await audit(
      userId,
      "agent.created",
      created.id,
      { name: config.name, provider: config.provider, model: config.model },
      {},
      tx,
    );
    return created;
  });
  publish(userId);
  return agent;
}
export async function editAgent(
  userId: string,
  id: string,
  input: z.input<typeof agentSchema>,
) {
  const config = agentSchema.parse(input);
  const previous = await ownedAgent(userId, id);
  if (previous.kind !== "agent")
    throw new AppError("not_found", "This agent was not found.", 404);
  requireEngine(config);
  if (
    previous.engine !== config.engine ||
    previous.projectPath !== config.projectPath
  )
    throw new AppError(
      "engine_locked",
      "Create a new agent to use a different engine or project.",
      409,
    );
  if (config.engine === "api") await requireProvider(userId, config.provider);
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
    await audit(
      userId,
      "agent.updated",
      id,
      { name: config.name, provider: config.provider, model: config.model },
      {},
      tx,
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
  if (agent.kind !== "agent")
    throw new AppError("not_found", "This agent was not found.", 404);
  if (action === "duplicate") {
    const config = agentSchema.parse({
      name: `${agent.name.slice(0, 64)} copy`,
      engine: agent.engine,
      projectPath: agent.projectPath,
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
  await db.$transaction(async (tx) => {
    await tx.agent.updateMany({
      where: { id, userId },
      data:
        action === "archive"
          ? { archived: true }
          : action === "restore"
            ? { archived: false }
            : { paused: action === "pause" },
    });
    await audit(userId, `agent.${action}`, id, {}, {}, tx);
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
