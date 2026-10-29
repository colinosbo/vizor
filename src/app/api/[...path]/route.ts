import { z } from "zod";
import { db } from "@/lib/server/db";
import {
  checkRequest,
  owner,
  rateLimit,
  authenticate,
  cookie,
  logout,
} from "@/lib/server/security";
import { AppError, safeError } from "@/lib/server/errors";
import {
  readJson,
  agentSchema,
  messageSchema,
  layoutSchema,
} from "@/lib/server/validation";
import { workspace, defaultAgent, ownedAgent } from "@/lib/server/store";
import { encryptKey, decryptKey } from "@/lib/server/crypto";
import { getProvider } from "@/lib/providers";
import { recoverRuns, startChat, stopOwner, stopRun } from "@/lib/server/chat";
import { publish, eventStream } from "@/lib/server/events";
import {
  coordinator,
  configureOrchestrator,
} from "@/lib/server/orchestrator-config";
import {
  approveMany,
  approveProposal,
  editProposal,
  rejectProposal,
} from "@/lib/server/proposals";
import { proposalPayload } from "@/lib/server/orchestrator-tools";
import { meteredSend, setBudget, usd } from "@/lib/server/budgets";
import { audit } from "@/lib/server/audit";
import {
  terminalAgent,
  terminalRecord,
  recordTerminal,
} from "@/lib/server/terminal-agents";
import {
  createAgent,
  editAgent,
  agentAction,
  saveLayout,
} from "@/lib/server/agents";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    checkRequest(request);
    await recoverRuns();
    const { path } = await context.params;
    const route = path.join("/");
    const method = request.method;
    if (/^auth\/(login|register)$/.test(route) && method === "POST") {
      const input = await readJson(
        request,
        z
          .object({
            email: z
              .string()
              .trim()
              .email()
              .max(254)
              .transform((v) => v.toLowerCase()),
            password: z
              .string()
              .min(route.endsWith("register") ? 12 : 1)
              .max(128),
          })
          .strict(),
      );
      const token = await authenticate(
        input.email,
        input.password,
        route.endsWith("register"),
      );
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": cookie(token) } },
      );
    }
    if (route === "auth/logout" && method === "POST") {
      try {
        const user = await owner(request);
        stopOwner(user.id);
        publish(user.id);
      } catch {
        /* Expired sessions can still clear their cookie. */
      }
      await logout(request);
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": cookie("", true) } },
      );
    }
    const user = await owner(request);
    await rateLimit(`requests:${user.id}`, 180);
    if (path[0] === "terminal-agents" && path.length === 2) {
      if (method === "GET")
        return Response.json(await terminalAgent(user.id, path[1]));
      if (method === "PATCH") {
        await recordTerminal(
          user.id,
          path[1],
          await readJson(request, terminalRecord),
        );
        return Response.json({ ok: true });
      }
    }
    if (route === "workspace" && method === "GET")
      return Response.json(await workspace(user));
    if (route === "orchestrator" && method === "PATCH") {
      const input = await readJson(
        request,
        z
          .object({
            provider: z.string().max(40),
            model: z.string().max(150),
            temperature: z.number().min(0).max(1),
            maxTokens: z.number().int().min(64).max(8192),
          })
          .strict()
          .refine(
            (config) =>
              agentSchema.safeParse({ ...defaultAgent, ...config }).success,
          ),
      );
      return Response.json(await configureOrchestrator(user.id, input));
    }
    if (route === "orchestrator/messages" && method === "POST") {
      await rateLimit(`chat:${user.id}`, 20);
      const input = await readJson(
        request,
        messageSchema.extend({
          agentIds: z.array(z.string().min(1).max(100)).max(20).optional(),
        }),
      );
      return await startChat(
        user.id,
        (await coordinator(user.id)).id,
        input,
        request.signal,
        { orchestrator: true, scope: input.agentIds },
      );
    }
    if (path[0] === "proposals" && path.length === 2 && method === "PATCH") {
      const input = await readJson(
        request,
        z
          .object({
            version: z.number().int().min(0),
            payload: proposalPayload,
          })
          .strict(),
      );
      await editProposal(user.id, path[1], input.version, input.payload);
      return Response.json({ ok: true });
    }
    if (
      path[0] === "proposals" &&
      path.length === 3 &&
      ["approve", "reject"].includes(path[2]) &&
      method === "POST"
    ) {
      const input = await readJson(
        request,
        z.object({ version: z.number().int().min(0) }).strict(),
      );
      if (path[2] === "approve")
        return Response.json(
          await approveProposal(user.id, path[1], input.version),
        );
      await rejectProposal(user.id, path[1], input.version);
      return Response.json({ ok: true });
    }
    if (route === "proposals/approve-many" && method === "POST") {
      const input = await readJson(
        request,
        z
          .object({
            items: z
              .array(
                z
                  .object({
                    id: z.string().min(1).max(100),
                    version: z.number().int().min(0),
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
          })
          .strict(),
      );
      return Response.json({
        results: await approveMany(user.id, input.items),
      });
    }
    if (path[0] === "budgets" && path.length === 2 && method === "PATCH") {
      const dollars = z
        .number()
        .finite()
        .min(0)
        .max(1000000)
        .refine(
          (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
        );
      const input = await readJson(
        request,
        z
          .object({
            limit: dollars.nullable(),
            openingBalance: dollars.optional(),
          })
          .strict(),
      );
      await setBudget(user.id, path[1], input.limit, input.openingBalance);
      return Response.json({ ok: true });
    }
    if (route === "audit" && method === "GET") {
      const cursor = new URL(request.url).searchParams.get("before");
      if (
        cursor &&
        !(await db.auditEntry.findFirst({
          where: { id: cursor, userId: user.id },
          select: { id: true },
        }))
      )
        throw new AppError(
          "not_found",
          "This audit cursor was not found.",
          404,
        );
      const entries = await db.auditEntry.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: 51,
      });
      return Response.json({
        entries: entries.slice(0, 50).map(({ userId: _owner, ...entry }) => ({
          ...entry,
          details: JSON.parse(entry.details),
          approvedBy: entry.approvedBy === user.id,
        })),
        nextCursor: entries.length > 50 ? entries[49].id : null,
      });
    }
    if (route === "spending" && method === "GET") {
      const entries = await db.spendEntry.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return Response.json({
        entries: entries.map((entry) => ({
          id: entry.id,
          provider: entry.provider,
          model: entry.model,
          source: entry.source,
          period: entry.period,
          status: entry.status,
          quoted:
            entry.inputRate == null &&
            entry.outputRate == null &&
            entry.quotedMicros === 0n
              ? null
              : usd(entry.quotedMicros),
          charged:
            entry.chargedMicros == null ||
            ["unknown", "reconciled"].includes(entry.status)
              ? null
              : usd(entry.chargedMicros),
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          estimated: entry.estimated,
          createdAt: entry.createdAt,
        })),
      });
    }
    if (route === "events" && method === "GET") {
      return eventStream(
        user.id,
        async () => {
          try {
            return (await owner(request)).id === user.id;
          } catch {
            return false;
          }
        },
        request.signal,
      );
    }
    if (route === "layout" && method === "PATCH") {
      await saveLayout(user.id, await readJson(request, layoutSchema));
      return Response.json({ ok: true });
    }
    if (path[0] === "providers" && path.length === 2 && method === "POST") {
      const provider = getProvider(path[1]);
      await rateLimit(`connection:${user.id}`, 5);
      const input = await readJson(
        request,
        z
          .object({
            key: z
              .string()
              .trim()
              .startsWith(provider.keyPrefix)
              .min(16)
              .max(512)
              .refine(
                (value) =>
                  provider.id !== "openai" || !value.startsWith("sk-ant-"),
              ),
          })
          .strict(),
      );
      const encrypted = encryptKey(input.key, user.id, provider.id);
      await provider.validateKey(input.key, request.signal, (modelInput) =>
        meteredSend(user.id, provider.id, modelInput, { source: "connection" }),
      );
      stopOwner(user.id, provider.id);
      await db.credential.upsert({
        where: { userId_provider: { userId: user.id, provider: provider.id } },
        create: {
          userId: user.id,
          provider: provider.id,
          encrypted,
          last4: input.key.slice(-4),
        },
        update: { encrypted, last4: input.key.slice(-4) },
      });
      publish(user.id);
      await audit(user.id, "provider.connected", provider.id);
      return Response.json({ connected: true, last4: input.key.slice(-4) });
    }
    if (path[0] === "providers" && path.length === 2 && method === "DELETE") {
      const provider = getProvider(path[1]);
      await db.credential.deleteMany({
        where: { userId: user.id, provider: provider.id },
      });
      stopOwner(user.id, provider.id);
      publish(user.id);
      await audit(user.id, "provider.removed", provider.id);
      return Response.json({ connected: false, last4: null });
    }
    if (
      path[0] === "providers" &&
      path[2] === "models" &&
      path.length === 3 &&
      method === "GET"
    ) {
      const provider = getProvider(path[1]);
      await rateLimit(`models:${user.id}`, 12);
      const key = await db.credential.findUnique({
        where: { userId_provider: { userId: user.id, provider: provider.id } },
      });
      if (!key)
        throw new AppError(
          "provider_required",
          `Connect ${provider.label} first.`,
        );
      const value = decryptKey(key.encrypted, user.id, provider.id);
      try {
        return Response.json({
          models: await provider.listModels(value, request.signal),
          fallback: false,
        });
      } catch (error) {
        const safe = safeError(error);
        return Response.json({
          models: provider.fallbackModels,
          fallback: true,
          message: safe.message,
        });
      }
    }
    if (route === "agents" && method === "POST") {
      const input = await readJson(request, agentSchema);
      const agent = await createAgent(user.id, input);
      return Response.json(agent, { status: 201 });
    }
    if (path[0] === "agents" && path.length === 2 && method === "PATCH") {
      const input = await readJson(request, agentSchema);
      await editAgent(user.id, path[1], input);
      return Response.json({ ok: true });
    }
    if (
      path[0] === "agents" &&
      path.length === 3 &&
      ["duplicate", "archive", "restore", "pause", "resume"].includes(
        path[2],
      ) &&
      method === "POST"
    ) {
      return Response.json(
        await agentAction(
          user.id,
          path[1],
          path[2] as "duplicate" | "archive" | "restore" | "pause" | "resume",
        ),
      );
    }
    if (route === "templates" && method === "POST") {
      const input = await readJson(
        request,
        z
          .object({
            name: z.string().trim().min(1).max(70),
            agentId: z.string().min(1).max(100),
            config: agentSchema.optional(),
          })
          .strict(),
      );
      const agent = await ownedAgent(user.id, input.agentId);
      const config = agentSchema.parse(
        input.config ?? {
          name: agent.name,
          provider: agent.provider,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          color: agent.color,
          icon: agent.icon,
        },
      );
      const template = await db.agentTemplate.create({
        data: {
          userId: user.id,
          name: input.name,
          config: JSON.stringify(config),
        },
        select: { id: true },
      });
      publish(user.id);
      return Response.json(template, { status: 201 });
    }
    if (path[0] === "templates" && path.length === 2 && method === "DELETE") {
      const result = await db.agentTemplate.deleteMany({
        where: { id: path[1], userId: user.id },
      });
      if (!result.count)
        throw new AppError("not_found", "This template was not found.", 404);
      publish(user.id);
      return Response.json({ ok: true });
    }
    if (
      path[0] === "agents" &&
      path[2] === "messages" &&
      path.length === 3 &&
      method === "POST"
    ) {
      await rateLimit(`chat:${user.id}`, 20);
      return await startChat(
        user.id,
        path[1],
        await readJson(request, messageSchema),
        request.signal,
      );
    }
    if (
      path[0] === "runs" &&
      path[2] === "stop" &&
      path.length === 3 &&
      method === "POST"
    ) {
      await stopRun(user.id, path[1]);
      return Response.json({ ok: true });
    }
    // A default configuration is returned as data, never silently created on GET.
    if (route === "defaults" && method === "GET")
      return Response.json(defaultAgent);
    throw new AppError("not_found", "This endpoint was not found.", 404);
  } catch (error) {
    const safe = safeError(error);
    return Response.json(
      { code: safe.code, message: safe.message },
      { status: safe.status },
    );
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
