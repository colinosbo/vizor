import { db } from "./db";
import { AppError } from "./errors";
import { PRICING_DATE } from "./pricing";
import { selfHost } from "./security";
export const defaultAgent = {
  name: "My assistant",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "You are a thoughtful, practical assistant. Be clear, accurate, and concise. Ask when essential information is missing.",
  temperature: 0.7,
  maxTokens: 2048,
  color: "mint",
  icon: "spark",
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
  const key = await db.credential.findUnique({
    where: { userId_provider: { userId: user.id, provider: "anthropic" } },
    select: { last4: true },
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
    pricingDate: PRICING_DATE,
    agents: agents.map(({ userId: _owner, ...agent }) => agent),
  };
}
