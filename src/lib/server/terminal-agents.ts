import { z } from "zod";
import { db } from "./db";
import { ownedAgent } from "./store";
import { selfHost } from "./security";
import { AppError } from "./errors";
import { audit } from "./audit";
import { decryptKey } from "./crypto";
export async function terminalAgent(userId: string, id: string) {
  if (!selfHost() || process.env.VIZOR_TERMINALS !== "1")
    throw new AppError(
      "desktop_required",
      "Terminal agents require the Windows desktop app.",
      403,
    );
  const agent = await ownedAgent(userId, id);
  if (
    agent.kind !== "agent" ||
    !["claude-code", "codex"].includes(agent.engine)
  )
    throw new AppError("not_found", "This terminal agent is unavailable.", 404);
  return {
    id: agent.id,
    name: agent.name,
    engine: agent.engine,
    projectPath: agent.projectPath,
    nativeSessionId: agent.nativeSessionId,
    terminalStarted: agent.terminalStarted,
    terminalState: agent.terminalState,
    permissionMode: agent.permissionMode,
    archived: agent.archived,
    paused: agent.paused,
  };
}
export async function terminalClaudeApiKey(userId: string) {
  if (!selfHost() || process.env.VIZOR_TERMINALS !== "1")
    throw new AppError(
      "desktop_required",
      "Terminal agents require the Windows desktop app.",
      403,
    );
  const credential = await db.credential.findUnique({
    where: { userId_provider: { userId, provider: "anthropic" } },
  });
  return credential
    ? decryptKey(credential.encrypted, userId, "anthropic")
    : null;
}
export const terminalRecord = z
  .object({
    nativeSessionId: z.string().uuid(),
    event: z.enum(["started", "stopped"]),
  })
  .strict();
export async function recordTerminal(
  userId: string,
  id: string,
  input: z.infer<typeof terminalRecord>,
) {
  const current = await terminalAgent(userId, id);
  if (
    current.nativeSessionId &&
    current.nativeSessionId !== input.nativeSessionId
  )
    throw new AppError(
      "session_locked",
      "This agent already has its own native session.",
      409,
    );
  await db.agent.updateMany({
    where: { id, userId },
    data: {
      nativeSessionId: input.nativeSessionId,
      terminalStarted: true,
      terminalState: input.event === "started" ? "running" : "stopped",
    },
  });
  await audit(userId, `terminal.${input.event}`, id);
}
