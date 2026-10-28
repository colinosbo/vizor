import { AppError } from "../server/errors";
import type { ProviderModel } from "../types";
import type { Provider, SendInput, StreamEvent, Usage } from "./types";
const endpoint = "https://api.anthropic.com/v1";
const acceptsTemperature = (model: string) =>
  /^claude-(haiku-4-5|sonnet-4-5|sonnet-4-20250514|opus-4-1)/.test(model);
const headers = (key: string) => ({
  "content-type": "application/json",
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
});
export function providerError(status: number, code?: string): AppError {
  if (status === 401 || status === 403)
    return new AppError(
      "invalid_key",
      "Claude could not authenticate this key. Check its permissions or create a new key.",
      400,
    );
  if (status === 402 || code === "credit_balance_too_low")
    return new AppError(
      "billing",
      "Claude requires API credits. Check Plans & Billing in the Anthropic console.",
      400,
    );
  if (status === 429)
    return new AppError(
      "rate_limited",
      "Claude is rate limited. Wait a moment, then try again.",
      429,
    );
  if (status === 404)
    return new AppError(
      "model_unavailable",
      "This model is unavailable. Refresh the model list and choose another model.",
      400,
    );
  if (status >= 500 || status === 529)
    return new AppError(
      "provider_unavailable",
      "Claude is temporarily unavailable. Please try again shortly.",
      503,
    );
  return new AppError(
    "provider_request",
    "Claude could not process this request. Check the model settings and conversation length.",
    400,
  );
}
async function checked(response: Response) {
  if (response.ok) return response;
  let code: string | undefined;
  try {
    const body = await response.json();
    code = body.error?.type;
    if (/credit balance|billing/i.test(body.error?.message ?? ""))
      code = "credit_balance_too_low";
  } catch {
    /* Never expose upstream payloads. */
  }
  throw providerError(response.status, code);
}
function signal(input?: AbortSignal) {
  return input
    ? AbortSignal.any([input, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
}
function body(input: SendInput, stream: boolean) {
  return JSON.stringify({
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: input.messages.map((message) =>
      message.role === "tool"
        ? {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: message.callId,
                content: message.content,
              },
            ],
          }
        : message.toolCalls?.length
          ? {
              role: "assistant",
              content: [
                ...(message.content
                  ? [{ type: "text", text: message.content }]
                  : []),
                ...message.toolCalls.map((call) => ({
                  type: "tool_use",
                  id: call.id,
                  name: call.name,
                  input: call.arguments,
                })),
              ],
            }
          : { role: message.role, content: message.content },
    ),
    ...(input.tools?.length
      ? {
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    ...(acceptsTemperature(input.model)
      ? { temperature: input.temperature }
      : {}),
    stream,
  });
}
// Decode SSE across arbitrary TCP and UTF-8 boundaries, including CRLF and final frames.
export async function* frames(
  stream: ReadableStream<Uint8Array>,
  abort?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      abort?.throwIfAborted();
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      pending = pending.replace(/\r\n/g, "\n");
      let at: number;
      while ((at = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, at);
        pending = pending.slice(at + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (pending.length > 2_000_000)
        throw new AppError(
          "stream_invalid",
          "Claude returned an oversized stream frame.",
          502,
        );
      if (done) {
        if (pending.startsWith("data:")) yield pending.slice(5).trim();
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const anthropic: Provider = {
  id: "anthropic",
  label: "Claude",
  company: "Anthropic",
  keyPrefix: "sk-ant-",
  consoleUrl: "https://console.anthropic.com/",
  keyInstructions: [
    "Sign in at console.anthropic.com.",
    "Go to API Keys → Create Key. Copy the key starting with sk-ant-.",
    "Set up billing or credits under Plans & Billing.",
  ],
  subscription: "Claude Pro",
  defaultModel: "claude-sonnet-4-6",
  acceptsModel: (model) => /^claude-[a-zA-Z0-9.-]+$/.test(model),
  fallbackModels: [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", temperature: false },
    {
      id: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      temperature: true,
    },
  ],
  async listModels(key, abort) {
    let after = "";
    const models: ProviderModel[] = [];
    for (let page = 0; page < 20; page++) {
      const response = await checked(
        await fetch(
          `${endpoint}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
          { headers: headers(key), signal: signal(abort), cache: "no-store" },
        ),
      );
      const data = await response.json();
      for (const m of data.data ?? [])
        if (typeof m.id === "string")
          models.push({
            id: m.id,
            name: m.display_name ?? m.id,
            temperature: acceptsTemperature(m.id),
          });
      if (!data.has_more) break;
      if (!data.last_id || after === data.last_id)
        throw new AppError(
          "models_invalid",
          "Could not finish refreshing the Claude model list.",
          502,
        );
      after = data.last_id;
    }
    if (!models.length)
      throw new AppError(
        "models_empty",
        "No Claude models are available for this key.",
        400,
      );
    return models;
  },
  async validateKey(key, abort, send) {
    const models = await this.listModels(key, abort);
    const model = models.find((m) => m.id.includes("haiku")) ?? models[0];
    await (send ?? this.send.bind(this))({
      key,
      model: model.id,
      system: "Reply OK.",
      messages: [{ role: "user", content: "Hi" }],
      maxTokens: 8,
      temperature: 0,
      signal: abort,
    });
  },
  async countTokens(input) {
    const {
      max_tokens: _max,
      temperature: _temperature,
      stream: _stream,
      ...payload
    } = JSON.parse(body(input, false));
    const response = await checked(
      await fetch(`${endpoint}/messages/count_tokens`, {
        method: "POST",
        headers: headers(input.key),
        body: JSON.stringify(payload),
        signal: signal(input.signal),
      }),
    );
    const result = await response.json();
    if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0)
      throw new AppError(
        "token_count",
        "Claude could not verify input tokens. No generation was started.",
        503,
      );
    return result.input_tokens;
  },
  async send(input) {
    const response = await checked(
      await fetch(`${endpoint}/messages`, {
        method: "POST",
        headers: headers(input.key),
        body: body(input, false),
        signal: signal(input.signal),
      }),
    );
    const result = await response.json();
    return {
      text: (result.content ?? [])
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join(""),
      usage: {
        inputTokens: result.usage?.input_tokens ?? null,
        outputTokens: result.usage?.output_tokens ?? null,
        complete: true,
      },
    };
  },
  async *stream(input): AsyncGenerator<StreamEvent> {
    const response = await checked(
      await fetch(`${endpoint}/messages`, {
        method: "POST",
        headers: headers(input.key),
        body: body(input, true),
        signal: signal(input.signal),
      }),
    );
    if (!response.body)
      throw new AppError(
        "stream_missing",
        "Claude did not return a response stream.",
        502,
      );
    const usage: Usage = {
      inputTokens: null,
      outputTokens: null,
      complete: false,
    };
    let completed = false;
    const calls = new Map<
      number,
      { id: string; name: string; input: unknown; json: string }
    >();
    for await (const raw of frames(response.body, input.signal)) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        throw new AppError(
          "stream_invalid",
          "Claude returned an unreadable response.",
          502,
        );
      }
      if (event.type === "error")
        throw providerError(
          event.error?.type === "overloaded_error" ? 529 : 400,
          event.error?.type,
        );
      if (event.type === "message_start") {
        usage.inputTokens = event.message?.usage?.input_tokens ?? null;
        yield { type: "usage", usage: { ...usage } };
      }
      if (
        event.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      )
        calls.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          input: event.content_block.input ?? {},
          json: "",
        });
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta"
      ) {
        const call = calls.get(event.index);
        if (call) {
          call.json += event.delta.partial_json;
          if (call.json.length > 64000)
            throw new AppError(
              "tool_invalid",
              "The tool proposal was too large.",
              502,
            );
        }
      }
      if (event.type === "content_block_stop") {
        const call = calls.get(event.index);
        if (call) {
          let args: unknown;
          try {
            args = call.json ? JSON.parse(call.json) : call.input;
          } catch {
            throw new AppError(
              "tool_invalid",
              "Claude returned an incomplete tool proposal.",
              502,
            );
          }
          yield {
            type: "tool",
            call: { id: call.id, name: call.name, arguments: args },
          };
          calls.delete(event.index);
        }
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      )
        yield { type: "delta", text: event.delta.text };
      if (event.type === "message_delta") {
        usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
        yield { type: "usage", usage: { ...usage } };
      }
      if (event.type === "message_stop") {
        completed = true;
        usage.complete =
          usage.inputTokens !== null && usage.outputTokens !== null;
        yield { type: "usage", usage: { ...usage } };
      }
    }
    if (!completed)
      throw new AppError(
        "stream_interrupted",
        "The response was interrupted. Your partial response has been saved.",
        502,
      );
  },
};
