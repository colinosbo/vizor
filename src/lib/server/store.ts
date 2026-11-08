import { db } from "./db";
import { AppError } from "./errors";
import { PRICING_DATE } from "./pricing";
import { selfHost } from "./security";
import { providers } from "../providers";
import { parseLayout } from "../layout";
import { collectTerminalReports } from "./terminal-reports";
import { collectApiAgentReports } from "./api-agent-reports";
import { budgetViews } from "./budgets";
import { processTaskQueue } from "./task-queue";
import { subscriptionAvailable } from "./subscription";
import { ownedProject } from "./projects";
import { processProjectMerges } from "./project-merge";
import { scanProjectReviews } from "./pr-reviews";
import {
  sendSharedDeliveryFailures,
  sharedDecisionId,
  sharedRevision,
  watchSharedProjects,
} from "./shared-projects";
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
export async function workspace(
  user: { id: string; email: string },
  projectId?: string,
) {
  const selectedProject = projectId
    ? await ownedProject(user.id, projectId)
    : null;
  await collectTerminalReports(user.id);
  const sharedConnections = await db.sharedConnection.findMany({
    where: { project: { userId: user.id } },
  });
  const sharedPolling = sharedConnections.some(
    (connection) => connection.enabled && connection.role === "worker",
  );
  const selectedShared = sharedConnections.find(
    (connection) => connection.projectId === projectId,
  );
  const sharedDecisions = sharedConnections.flatMap((connection) => {
    const id =
      connection.enabled &&
      connection.role === "owner" &&
      sharedDecisionId(connection.projectId);
    return id ? [{ id, projectId: connection.projectId }] : [];
  });
  watchSharedProjects(user.id, sharedConnections);
  if (sharedPolling) void sendSharedDeliveryFailures(user.id).catch(() => {});
  await collectApiAgentReports(user.id);
  await processTaskQueue(user.id);
  void processProjectMerges(user.id).catch(() => {});
  const reviewProjects = await db.project.findMany({
    where: { userId: user.id, reviewEnabled: true },
    select: { id: true },
  });
  for (const project of reviewProjects)
    void scanProjectReviews(user.id, project.id).catch(() => {});
  const keys = await db.credential.findMany({
    where: { userId: user.id },
    select: { provider: true, last4: true },
  });
  const key = keys.find((key) => key.provider === "anthropic");
  const preferences = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { workspaceLayout: true, autoApprove: true, queueEnabled: true },
  });
  const templates = await db.agentTemplate.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, config: true },
  });
  const agents = await db.agent.findMany({
    where: { userId: user.id, projectId: projectId ?? null },
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
  const chatStart = agents
    .find((agent) => agent.kind === "orchestrator")
    ?.conversation?.messages.find(
      (message) => message.role === "user" && message.origin === "user",
    )?.createdAt;
  const teamTasks = chatStart
    ? await db.terminalDispatch.findMany({
        where: {
          userId: user.id,
          agent: { projectId: projectId ?? null },
          createdAt: { gte: chatStart },
          status: { notIn: ["superseded", "failed"] },
        },
        select: { agentId: true },
      })
    : [];
  const apiTasks = chatStart
    ? await db.proposal.findMany({
        where: {
          userId: user.id,
          projectId: projectId ?? null,
          createdAt: { gte: chatStart },
          action: { in: ["send_message", "create_terminal_agent"] },
          status: { in: ["approved", "executing"] },
          agentId: { not: null },
        },
        select: { agentId: true },
      })
    : [];
  return {
    mergeJobs: await db.mergeJob.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        projectId: true,
        status: true,
        prUrl: true,
        error: true,
        updatedAt: true,
      },
    }),
    notificationState: {
      messages: await db.message.findMany({
        where: {
          conversation: { agent: { userId: user.id } },
          origin: { not: "shared_project" },
          OR: [
            { role: "assistant" },
            { origin: { in: ["terminal_report", "agent_report"] } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 300,
        select: { id: true, status: true },
      }),
      pendingProposals: [
        ...sharedDecisions.map((item) => item.id),
        ...(
          await db.proposal.findMany({
            where: { userId: user.id, status: "pending" },
            orderBy: { createdAt: "desc" },
            take: 1000,
            select: { id: true },
          })
        ).map((item) => item.id),
      ],
    },
    projects: await db.project.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        folder: true,
        createdAt: true,
        sharedConnection: { select: { role: true } },
        agents: {
          where: { userId: user.id, kind: "agent", archived: false },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            color: true,
            icon: true,
            engine: true,
            terminalState: true,
            paused: true,
            conversation: { select: { activeRunId: true } },
            terminalDispatches: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { status: true, outcome: true },
            },
          },
        },
      },
    }),
    hasPlanChat: !!chatStart,
    currentTeamIds: [
      ...new Set(
        [...teamTasks, ...apiTasks].flatMap((task) =>
          task.agentId ? [task.agentId] : [],
        ),
      ),
    ],
    selfHost: selfHost(),
    subscriptionAvailable: subscriptionAvailable(),
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
    layout: parseLayout(
      selectedProject?.workspaceLayout ?? preferences.workspaceLayout,
    ),
    templates: templates.map((t) => ({ ...t, config: JSON.parse(t.config) })),
    pricingDate: PRICING_DATE,
    agents: agents
      .filter((agent) => agent.kind === "agent")
      .map(({ userId: _owner, ...agent }) => agent),
    orchestrator:
      agents
        .filter((agent) => agent.kind === "orchestrator")
        .map(({ userId: _owner, ...agent }) => agent)[0] ?? null,
    pendingProposalCount: await db.proposal.count({
      where: {
        userId: user.id,
        status: "pending",
        projectId: projectId ?? null,
      },
    }),
    proposals: (
      await Promise.all([
        db.proposal.findMany({
          where: {
            userId: user.id,
            status: "pending",
            projectId: projectId ?? null,
          },
          orderBy: { createdAt: "asc" },
          take: 100,
        }),
        db.proposal.findMany({
          where: {
            userId: user.id,
            status: "queued",
            projectId: projectId ?? null,
          },
          orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
        }),
        db.proposal.findMany({
          where: {
            userId: user.id,
            status: { not: "pending" },
            projectId: projectId ?? null,
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        db.proposal.findMany({
          where: {
            userId: user.id,
            projectId: projectId ?? null,
            id: {
              in: (
                await db.terminalDispatch.findMany({
                  where: {
                    userId: user.id,
                    status: { in: ["ready", "claimed"] },
                  },
                  select: { proposalId: true },
                })
              ).map((d) => d.proposalId),
            },
          },
        }),
      ])
    )
      .flat()
      .filter(
        (item, index, all) => all.findIndex((p) => p.id === item.id) === index,
      )
      .map((proposal) => ({
        id: proposal.id,
        action: proposal.action,
        agentId: proposal.agentId,
        status: proposal.status,
        version: proposal.version,
        createdAt: proposal.createdAt,
        resultRunId: proposal.resultRunId,
        error: proposal.error,
        payload: JSON.parse(proposal.payload),
        approvedBy: proposal.approvedBy === user.id,
      })),
    terminalDispatches: await db.terminalDispatch.findMany({
      where: {
        userId: user.id,
        agent: { projectId: projectId ?? null },
        status: { in: ["ready", "claimed", "delivered", "reported", "failed"] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        proposalId: true,
        agentId: true,
        text: true,
        status: true,
        error: true,
        outcome: true,
        autoDeliver: true,
        questions: true,
      },
    }),
    allReadyDispatches: await db.terminalDispatch.findMany({
      where: {
        userId: user.id,
        status: "ready",
        OR: [
          { sharedTurnId: null },
          { agent: { project: { sharedConnection: { enabled: true } } } },
        ],
      },
      select: {
        id: true,
        proposalId: true,
        agentId: true,
        status: true,
        autoDeliver: true,
        sharedTurnId: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    sharedPolling,
    sharedRevision: selectedShared
      ? sharedRevision(selectedShared.projectId)
      : undefined,
    sharedDecisionProjectIds: sharedDecisions.map((item) => item.projectId),
    sharedProject: selectedShared && {
      role: selectedShared.role,
      needsDecision:
        selectedShared.role === "owner" &&
        sharedDecisions.some(
          (item) => item.projectId === selectedShared.projectId,
        ),
    },
    budgets: await budgetViews(user.id),
    autopilot: preferences.autoApprove,
    queueEnabled: preferences.queueEnabled,
  };
}
