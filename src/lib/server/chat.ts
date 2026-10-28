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
type Active = { userId: string; controller: AbortController };
const runtime = globalThis as unknown as {
  vizorRuns?: Map<string, Active>;
  vizorRecovery?: Promise<void>;
};
const active = (runtime.vizorRuns ??= new Map());
export async function recoverRuns() {
  await (runtime.vizorRecovery ??= db.$transaction(async (tx) => {
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
  }));
}
export async function stopRun(userId: string, runId: string) {
  const run = await ownedRun(userId, runId);
  if (run.status !== "running") return;
  const current = active.get(runId);
  if (current?.userId === userId) current.controller.abort();
}
export function stopOwner(userId: string) {
  for (const entry of active.values())
    if (entry.userId === userId) entry.controller.abort();
}
export async function startChat(
  userId: string,
  agentId: string,
  input: z.infer<typeof messageSchema>,
  requestSignal?: AbortSignal,
) {
  await recoverRuns();
  const agent = await ownedAgent(userId, agentId);
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
      "Connect Claude in API keys before sending a message.",
      400,
    );
  const key = decryptKey(credential.encrypted, userId, agent.provider);
  const runId = randomUUID();
  const assistantId = randomUUID();
  const abort = new AbortController();
  active.set(runId, { userId, controller: abort });
  try {
    await db.$transaction(async (tx) => {
      const lock = await tx.conversation.updateMany({
        where: { id: conversation.id, agent: { userId }, activeRunId: null },
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
        },
      });
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
              "The Claude connection changed. Please try again.",
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
            messages.reduce(
              (n, m) => n + m.text.length,
              agent.systemPrompt.length,
            ) > 500_000
          )
            throw new AppError(
              "context_limit",
              "This conversation is too long. Start another agent conversation before continuing.",
            );
          for await (const event of getProvider(agent.provider).stream({
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
          })) {
            abort.signal.throwIfAborted();
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
                ),
              });
            }
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
