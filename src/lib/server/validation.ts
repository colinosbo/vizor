import { z } from "zod";
import { AppError } from "./errors";
import { getProvider } from "../providers";
export const agentSchema = z
  .object({
    name: z.string().trim().min(1).max(70),
    engine: z.enum(["api", "claude-code", "codex"]).default("api"),
    projectPath: z.string().max(4096).default(""),
    provider: z.string().max(40).default("anthropic"),
    model: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/)
      .max(150),
    systemPrompt: z.string().max(16000),
    temperature: z.number().min(0).max(1),
    maxTokens: z.number().int().min(64).max(8192),
    color: z.enum(["mint", "amber", "blue", "rose"]),
    icon: z.enum(["spark", "code", "pen", "search"]),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.engine !== "api") {
      if (
        !/^[a-zA-Z]:[\\/]/.test(config.projectPath) ||
        config.projectPath.includes("\0")
      )
        ctx.addIssue({
          code: "custom",
          message: "Choose a local project folder.",
          path: ["projectPath"],
        });
      return;
    }
    try {
      if (!getProvider(config.provider).acceptsModel(config.model))
        ctx.addIssue({
          code: "custom",
          message: "Model does not belong to this provider",
          path: ["model"],
        });
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Unknown provider",
        path: ["provider"],
      });
    }
  });
const ids = z
  .array(z.string().min(1).max(100))
  .max(1000)
  .refine(
    (value) => new Set(value).size === value.length,
    "Repeated agent IDs",
  );
const panel = z
  .object({
    i: z.string().min(1).max(100),
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(10000),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(2).max(40),
  })
  .strict()
  .refine((value) => value.x + value.w <= 12, "Panel exceeds grid");
export const layoutSchema = z
  .object({
    mode: z.enum(["1", "2", "4", "6", "tabs"]),
    activeId: z.string().min(1).max(100).nullable(),
    order: ids,
    pinned: ids,
    collapsed: ids,
    layouts: z.record(
      z.string().regex(/^(1|2|4|6|tabs)$/),
      z
        .array(panel)
        .max(1000)
        .refine(
          (items) => new Set(items.map((item) => item.i)).size === items.length,
        ),
    ),
  })
  .strict();
export const messageSchema = z
  .object({
    clientId: z.string().uuid(),
    text: z.string().trim().min(1).max(32000).optional(),
    mode: z.enum(["send", "regenerate", "edit"]).default("send"),
    messageId: z.string().max(100).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError("content_type", "Expected a JSON request.", 415);
  if (Number(request.headers.get("content-length") ?? 0) > 96_000)
    throw new AppError("too_large", "This request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError("invalid_input", "The request body is missing.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 96_000) {
        await reader.cancel();
        throw new AppError("too_large", "This request is too large.", 413);
      }
      chunks.push(value);
    }
    const parsed = schema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (!parsed.success)
      throw new AppError(
        "invalid_input",
        "Check the submitted fields and their allowed lengths.",
      );
    return parsed.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_input", "The request contains invalid JSON.");
  } finally {
    reader.releaseLock();
  }
}
