import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { ownedAgent, ownedRun } from "./store";
import { AppError, safeError } from "./errors";
import { decryptKey } from "./crypto";
import { getProvider } from "../providers";
import { messageSchema } from "./validation";
import { estimateCost } from "./pricing";
import type { Usage } from "../providers/types";
import { publish } from "./events";
import { meteredStream, recoverSpending } from "./budgets";
import { streamOrchestrator } from "./orchestrator-stream";
import { audit } from "./audit";
type Active = {
  userId: string;
  agentId: string;
  provider: string;
  controller: AbortController;
};
const runtime = globalThis as unknown as {
  vizorRuns?: Map<string, Active>;
  vizorRecovery?: Promise<void>;
};
const active = (runtime.vizorRuns ??= new Map());
export async function recoverRuns() {
  await (runtime.vizorRecovery ??= (async () => {
    await recoverSpending();
    await db.$transaction(async (tx) => {
      await tx.agent.updateMany({
        where: { engine: { not: "api" }, terminalState: "running" },
        data: { terminalState: "stopped" },
      });
      const abandoned = await tx.run.findMany({ where: { status: "running" } });
      for (const run of abandoned) {
        await tx.message.updateMany({
          where: { id: run.assistantId, conversationId: run.conversationId },
          data: { status: "interrupted" },
        });
        await tx.run.update({
          where: { id: run.id },
          data: {
            status: "interrupted",
            errorCode: "server_restarted",
            usageComplete: false,
            endedAt: new Date(),
          },
        });
        await tx.conversation.updateMany({
          where: { id: run.conversationId, activeRunId: run.id },
          data: { activeRunId: null },
        });
      }
      for (const proposal of await tx.proposal.findMany({
        where: { status: "executing" },
      })) {
        await tx.proposal.update({
          where: { id: proposal.id },
          data: {
            status: "failed",
            error:
              "The server restarted during approval. Review the agent history before proposing another message.",
          },
        });
        await audit(
          proposal.userId,
          "proposal.interrupted",
          proposal.agentId,
          {},
          {
            actor: "system",
            proposalId: proposal.id,
            approvedBy: proposal.approvedBy ?? undefined,
          },
          tx,
        );
      }
    });
  })());
}
export async function stopRun(userId: string, runId: string) {
  const run = await ownedRun(userId, runId);
  if (run.status !== "running") return;
  const current = active.get(runId);
  if (current?.userId === userId) current.controller.abort();
  await audit(userId, "response.stopped", run.id);
}
export function stopOwner(userId: string, provider?: string) {
  for (const entry of active.values())
    if (entry.userId === userId && (!provider || entry.provider === provider))
      entry.controller.abort();
}
export function stopAgent(userId: string, agentId: string) {
  for (const entry of active.values())
    if (entry.userId === userId && entry.agentId === agentId)
      entry.controller.abort();
}
export async function startChat(
  userId: string,
  agentId: string,
  input: z.infer<typeof messageSchema>,
  requestSignal?: AbortSignal,
  options: {
    orchestrator?: boolean;
    scope?: string[];
    proposalId?: string;
  } = {},
) {
  await recoverRuns();
  const agent = await ownedAgent(userId, agentId);
  if (agent.engine !== "api")
    throw new AppError(
      "terminal_manual",
      "Open this agent's terminal to send instructions directly.",
      403,
    );
  if ((agent.kind === "orchestrator") !== !!options.orchestrator)
    throw new AppError("not_found", "This agent was not found.", 404);
  if (options.proposalId) {
    const proposal = await db.proposal.findFirst({
      where: {
        id: options.proposalId,
        userId,
        status: "executing",
        approvedBy: userId,
        action: "send_message",
        agentId,
      },
    });
    if (!proposal || JSON.parse(proposal.payload).text !== input.text)
      throw new AppError(
        "approval_required",
        "This message has not been approved.",
        403,
      );
  }
  if (agent.archived || agent.paused)
    throw new AppError(
      "agent_inactive",
      "Restore or resume this agent before sending a message.",
      409,
    );
  const conversation = agent.conversation!;
  const previous = await db.run.findUnique({
    where: { userId_clientId: { userId, clientId: input.clientId } },
  });
  if (previous) {
    if (previous.conversationId !== conversation.id)
      throw new AppError(
        "duplicate_id",
        "This submission ID belongs to another conversation.",
        409,
      );
    return Response.json({
      existing: true,
      runId: previous.id,
      status: previous.status,
    });
  }
  const credential = await db.credential.findUnique({
    where: { userId_provider: { userId, provider: agent.provider } },
  });
  if (!credential)
    throw new AppError(
      "provider_required",
      `Connect ${getProvider(agent.provider).label} in API keys before sending a message.`,
      400,
    );
  const key = decryptKey(credential.encrypted, userId, agent.provider);
  const runId = randomUUID();
  const assistantId = randomUUID();
  const abort = new AbortController();
  active.set(runId, {
    userId,
    agentId,
    provider: agent.provider,
    controller: abort,
  });
  try {
    await db.$transaction(async (tx) => {
      const lock = await tx.conversation.updateMany({
        where: {
          id: conversation.id,
          agent: { userId, paused: false, archived: false },
          activeRunId: null,
        },
        data: { activeRunId: runId },
      });
      if (!lock.count)
        throw new AppError(
          "busy",
          "This conversation already has a response in progress.",
          409,
        );
      const messages = await tx.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { position: "asc" },
      });
      let position = messages.length ? messages.at(-1)!.position + 1 : 0;
      if (input.mode === "edit") {
        const edited = messages.find(
          (m) => m.id === input.messageId && m.role === "user",
        );
        if (!edited || !input.confirm || !input.text)
          throw new AppError(
            "edit_confirmation",
            "Confirm replacing this message and its subsequent conversation.",
          );
        await tx.message.deleteMany({
          where: {
            conversationId: conversation.id,
            position: { gte: edited.position },
          },
        });
        position = edited.position;
        await tx.agent.updateMany({
          where: { id: agentId, userId },
          data: { contextSummary: "", summaryThroughPosition: -1 },
        });
      } else if (input.mode === "regenerate") {
        const last = messages.at(-1);
        if (!last || last.role !== "assistant")
          throw new AppError(
            "regenerate",
            "There is no assistant response to regenerate.",
          );
        await tx.message.delete({ where: { id: last.id } });
        position = last.position;
      }
      if (input.mode !== "regenerate") {
        if (!input.text)
          throw new AppError("message_required", "Write a message first.");
        await tx.message.create({
          data: {
            conversationId: conversation.id,
            role: "user",
            text: input.text,
            position: position++,
            origin: options.proposalId ? "orchestrator" : "user",
            proposalId: options.proposalId,
          },
        });
      }
      await tx.message.create({
        data: {
          id: assistantId,
          conversationId: conversation.id,
          role: "assistant",
          text: "",
          position,
          status: "streaming",
        },
      });
      await tx.run.create({
        data: {
          id: runId,
          userId,
          conversationId: conversation.id,
          clientId: input.clientId,
          assistantId,
          model: agent.model,
          provider: agent.provider,
          proposalId: options.proposalId,
        },
      });
      await audit(
        userId,
        "message.submitted",
        agentId,
        {
          runId,
          mode: input.mode,
          provider: agent.provider,
          model: agent.model,
        },
        {
          actor: options.proposalId ? "orchestrator" : "user",
          proposalId: options.proposalId,
          approvedBy: options.proposalId ? userId : undefined,
        },
        tx,
      );
    });
  } catch (error) {
    active.delete(runId);
    const duplicate = await db.run.findUnique({
      where: { userId_clientId: { userId, clientId: input.clientId } },
    });
    if (duplicate?.conversationId === conversation.id)
      return Response.json({
        existing: true,
        runId: duplicate.id,
        status: duplicate.status,
      });
    throw error;
  }
  const disconnect = () => abort.abort();
  publish(userId);
  requestSignal?.addEventListener("abort", disconnect, { once: true });
  if (requestSignal?.aborted) abort.abort();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const emit = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          closed = true;
          abort.abort();
        }
      };
      const heartbeat = setInterval(() => emit("ping", {}), 10_000);
      const generate = async () => {
        let text = "";
        let lastSave = 0;
        let status = "complete";
        let errorCode: string | null = null;
        let usage: Usage = {
          inputTokens: null,
          outputTokens: null,
          complete: false,
        };
        const pushLive = () =>
          publish(userId, {
            type: "run",
            run: {
              agentId,
              runId,
              assistantId,
              model: agent.model,
              provider: agent.provider,
              text,
              status: "running",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cost: estimateCost(
                agent.model,
                usage.inputTokens,
                usage.outputTokens,
                agent.provider,
              ),
              usageComplete: usage.complete,
              errorCode,
              createdAt: new Date().toISOString(),
            },
          });
        emit("start", { runId, assistantId });
        try {
          // Recheck after registering cancellation, so key deletion cannot race a new call.
          const present = await db.credential.findFirst({
            where: {
              id: credential.id,
              userId,
              encrypted: credential.encrypted,
            },
            select: { id: true },
          });
          if (!present)
            throw new AppError(
              "provider_required",
              "The provider connection changed. Please try again.",
            );
          abort.signal.throwIfAborted();
          const messages = await db.message.findMany({
            where: {
              conversationId: conversation.id,
              id: { not: assistantId },
            },
            orderBy: { position: "asc" },
          });
          if (
            agent.kind !== "orchestrator" &&
            messages.reduce(
              (n, m) => n + m.text.length,
              agent.systemPrompt.length,
            ) > 500_000
          )
            throw new AppError(
              "context_limit",
              "This conversation is too long. Start another agent conversation before continuing.",
            );
          const modelInput = {
            key,
            model: agent.model,
            system: agent.systemPrompt,
            messages: messages
              .filter((m) => m.text)
              .map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.text,
              })),
            temperature: agent.temperature,
            maxTokens: agent.maxTokens,
            signal: abort.signal,
          };
          const events =
            agent.kind === "orchestrator"
              ? streamOrchestrator(
                  userId,
                  runId,
                  agent.provider,
                  modelInput,
                  options.scope,
                )
              : meteredStream(userId, agent.provider, modelInput, {
                  source: "chat",
                  referenceId: runId,
                });
          for await (const event of events) {
            abort.signal.throwIfAborted();
            if (event.type === "tool")
              throw new AppError(
                "unexpected_tool",
                "Agent tool calls cannot execute actions.",
                502,
              );
            if (event.type === "delta") {
              text += event.text;
              emit("delta", { text: event.text });
            } else {
              usage = event.usage;
              emit("usage", {
                ...usage,
                cost: estimateCost(
                  agent.model,
                  usage.inputTokens,
                  usage.outputTokens,
                  agent.provider,
                ),
              });
            }
            pushLive();
            if (Date.now() - lastSave > 250) {
              await db.message.updateMany({
                where: { id: assistantId, conversation: { agent: { userId } } },
                data: { text },
              });
              lastSave = Date.now();
            }
            // A client can disconnect while the checkpoint write is in flight.
            // Do not ask the adapter for another chunk after cancellation.
            abort.signal.throwIfAborted();
          }
        } catch (error) {
          status = abort.signal.aborted ? "stopped" : "error";
          usage.complete = false;
          const safe = safeError(error);
          errorCode = abort.signal.aborted ? "cancelled" : safe.code;
          if (status === "error")
            emit("error", { code: safe.code, message: safe.message });
        } finally {
          try {
            await db.$transaction(async (tx) => {
              await tx.message.updateMany({
                where: { id: assistantId, conversation: { agent: { userId } } },
                data: { text, status },
              });
              await tx.run.updateMany({
                where: { id: runId, userId },
                data: {
                  status,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  usageComplete: usage.complete,
                  cost: estimateCost(
                    agent.model,
                    usage.inputTokens,
                    usage.outputTokens,
                    agent.provider,
                  ),
                  errorCode,
                  endedAt: new Date(),
                },
              });
              await tx.conversation.updateMany({
                where: {
                  id: conversation.id,
                  agent: { userId },
                  activeRunId: runId,
                },
                data: { activeRunId: null },
              });
            });
            emit("done", { status, runId });
            if (status === "error")
              await audit(
                userId,
                "response.failed",
                agentId,
                { runId, code: errorCode },
                { actor: "system" },
              );
            publish(userId);
          } catch {
            emit("error", {
              code: "persistence",
              message:
                "The response could not be saved. Reload to check the saved conversation.",
            });
          }
          clearInterval(heartbeat);
          active.delete(runId);
          requestSignal?.removeEventListener("abort", disconnect);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* Disconnected. */
            }
          }
        }
      };
      void generate();
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
