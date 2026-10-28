import { db } from "./db";
import { AppError } from "./errors";
import { PRICING_DATE } from "./pricing";
import { selfHost } from "./security";
import { providers } from "../providers";
import { parseLayout } from "../layout";
export const defaultAgent = {
  name: "My assistant",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "You are a thoughtful, practical assistant. Be clear, accurate, and concise. Ask when essential information is missing.",
  temperature: 0.7,
  maxTokens: 2048,
  color: "mint" as const,
  icon: "spark" as const,
};
export async function ownedAgent(userId: string, id: string) {
  const agent = await db.agent.findFirst({
    where: { id, userId },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { position: "asc" } },
          runs: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!agent?.conversation)
    throw new AppError("not_found", "This agent was not found.", 404);
  return agent;
}
export async function ownedRun(userId: string, id: string) {
  const run = await db.run.findFirst({ where: { id, userId } });
  if (!run)
    throw new AppError("not_found", "This response was not found.", 404);
  return run;
}
export async function workspace(user: { id: string; email: string }) {
  const keys = await db.credential.findMany({
    where: { userId: user.id },
    select: { provider: true, last4: true },
  });
  const key = keys.find((key) => key.provider === "anthropic");
  const preferences = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { workspaceLayout: true },
  });
  const templates = await db.agentTemplate.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, config: true },
  });
  const agents = await db.agent.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { position: "asc" } },
          runs: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              assistantId: true,
              model: true,
              provider: true,
              status: true,
              inputTokens: true,
              outputTokens: true,
              cost: true,
              usageComplete: true,
              errorCode: true,
            },
          },
        },
      },
    },
  });
  return {
    selfHost: selfHost(),
    email: user.email,
    provider: { connected: !!key, last4: key?.last4 ?? null },
    providers: providers.map((p) => ({
      id: p.id,
      label: p.label,
      company: p.company,
      keyPrefix: p.keyPrefix,
      consoleUrl: p.consoleUrl,
      keyInstructions: p.keyInstructions,
      subscription: p.subscription,
      defaultModel: p.defaultModel,
      connected: keys.some((k) => k.provider === p.id),
      last4: keys.find((k) => k.provider === p.id)?.last4 ?? null,
    })),
    layout: parseLayout(preferences.workspaceLayout),
    templates: templates.map((t) => ({ ...t, config: JSON.parse(t.config) })),
    pricingDate: PRICING_DATE,
    agents: agents.map(({ userId: _owner, ...agent }) => agent),
  };
}
