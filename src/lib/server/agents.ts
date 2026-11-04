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
import {
  ownedProject,
  requireCodingWorker,
  requireProjectFolder,
} from "./projects";
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
  if (config.projectId) {
    const project = await ownedProject(userId, config.projectId);
    if (config.engine !== "claude-code")
      throw new AppError(
        "coding_workers_only",
        "Projects use Claude Code coding workers.",
        400,
      );
    requireCodingWorker(config.name, config.systemPrompt);
    requireProjectFolder(project.folder, config.projectPath);
  }
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
  if (previous.projectId) requireCodingWorker(config.name, config.systemPrompt);
  requireEngine(config);
  if (
    previous.engine !== config.engine ||
    previous.projectPath !== config.projectPath ||
    (config.projectId ?? null) !== previous.projectId
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
      terminalAuthMode: agent.terminalAuthMode,
      permissionMode: agent.permissionMode,
      projectPath: agent.projectPath,
      projectId: agent.projectId,
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
  projectId: string | null = null,
) {
  if (projectId) await ownedProject(userId, projectId);
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
    where: { userId, projectId, id: { in: [...ids] } },
  });
  if (owned !== ids.size)
    throw new AppError(
      "not_found",
      "One or more layout agents were not found.",
      404,
    );
  if (projectId)
    await db.project.update({
      where: { id: projectId },
      data: { workspaceLayout: JSON.stringify(layout) },
    });
  else
    await db.user.update({
      where: { id: userId },
      data: { workspaceLayout: JSON.stringify(layout) },
    });
  publish(userId);
}
