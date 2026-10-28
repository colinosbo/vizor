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
import { readJson, agentSchema, messageSchema } from "@/lib/server/validation";
import { workspace, defaultAgent, ownedAgent } from "@/lib/server/store";
import { encryptKey, decryptKey } from "@/lib/server/crypto";
import { getProvider } from "@/lib/providers";
import { recoverRuns, startChat, stopOwner, stopRun } from "@/lib/server/chat";
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
      await logout(request);
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": cookie("", true) } },
      );
    }
    const user = await owner(request);
    await rateLimit(`requests:${user.id}`, 180);
    if (route === "workspace" && method === "GET")
      return Response.json(await workspace(user));
    if (route === "providers/anthropic" && method === "POST") {
      await rateLimit(`connection:${user.id}`, 5);
      const input = await readJson(
        request,
        z
          .object({
            key: z.string().trim().startsWith("sk-ant-").min(16).max(512),
          })
          .strict(),
      );
      const encrypted = encryptKey(input.key, user.id, "anthropic");
      await getProvider("anthropic").validateKey(input.key, request.signal);
      stopOwner(user.id);
      await db.credential.upsert({
        where: { userId_provider: { userId: user.id, provider: "anthropic" } },
        create: {
          userId: user.id,
          provider: "anthropic",
          encrypted,
          last4: input.key.slice(-4),
        },
        update: { encrypted, last4: input.key.slice(-4) },
      });
      return Response.json({ connected: true, last4: input.key.slice(-4) });
    }
    if (route === "providers/anthropic" && method === "DELETE") {
      await db.credential.deleteMany({
        where: { userId: user.id, provider: "anthropic" },
      });
      stopOwner(user.id);
      return Response.json({ connected: false, last4: null });
    }
    if (route === "providers/anthropic/models" && method === "GET") {
      await rateLimit(`models:${user.id}`, 12);
      const key = await db.credential.findUnique({
        where: { userId_provider: { userId: user.id, provider: "anthropic" } },
      });
      if (!key)
        throw new AppError("provider_required", "Connect Claude first.");
      const value = decryptKey(key.encrypted, user.id, "anthropic");
      const provider = getProvider("anthropic");
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
      const agent = await db.agent.create({
        data: { userId: user.id, ...input, conversation: { create: {} } },
        select: { id: true },
      });
      return Response.json(agent, { status: 201 });
    }
    if (path[0] === "agents" && path.length === 2 && method === "PATCH") {
      const input = await readJson(request, agentSchema);
      const agent = await ownedAgent(user.id, path[1]);
      if (agent.conversation?.activeRunId)
        throw new AppError(
          "busy",
          "Stop the current response before changing agent settings.",
          409,
        );
      await db.agent.updateMany({
        where: { id: path[1], userId: user.id },
        data: input,
      });
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
