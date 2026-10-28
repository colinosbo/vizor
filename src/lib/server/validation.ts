import { z } from "zod";
import { AppError } from "./errors";
export const agentSchema = z
  .object({
    name: z.string().trim().min(1).max(70),
    model: z
      .string()
      .regex(/^claude-[a-zA-Z0-9.-]+$/)
      .max(150),
    systemPrompt: z.string().max(16000),
    temperature: z.number().min(0).max(1),
    maxTokens: z.number().int().min(64).max(8192),
    color: z.enum(["mint", "amber", "blue", "rose"]),
    icon: z.enum(["spark", "code", "pen", "search"]),
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
