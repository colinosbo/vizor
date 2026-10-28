import { AppError } from "../server/errors";
import { frames } from "./anthropic";
import type { Provider, SendInput, StreamEvent } from "./types";
const endpoint = "https://api.openai.com/v1";
const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});
const acceptsModel = (id: string) =>
  /^(gpt-(4\.1|4o|5|6)|o[134])([-.]|$)/.test(id) &&
  !/audio|realtime|transcrib|image|search|tts|embedding|instruct/.test(id);
const temperature = (id: string) => /^gpt-(4\.1|4o)([-.]|$)/.test(id);
const signal = (abort?: AbortSignal) =>
  abort
    ? AbortSignal.any([abort, AbortSignal.timeout(120000)])
    : AbortSignal.timeout(120000);
export function openaiError(status: number, code?: string) {
  if (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    status === 402
  )
    return new AppError(
      "billing",
      "OpenAI API credits or billing are required. Check Billing on the OpenAI platform.",
      400,
    );
  if (status === 401 || status === 403)
    return new AppError(
      "invalid_key",
      "OpenAI could not authenticate this key. Check its permissions or create a new key.",
      400,
    );
  if (status === 429)
    return new AppError(
      "rate_limited",
      "OpenAI is rate limited. Wait a moment, then try again.",
      429,
    );
  if (status === 404)
    return new AppError(
      "model_unavailable",
      "This OpenAI model is unavailable. Refresh the model list and choose another model.",
      400,
    );
  if (status >= 500)
    return new AppError(
      "provider_unavailable",
      "OpenAI is temporarily unavailable. Please try again shortly.",
      503,
    );
  return new AppError(
    "provider_request",
    "OpenAI could not process this request. Check the model settings and conversation length.",
    400,
  );
}
async function checked(response: Response) {
  if (response.ok) return response;
  let code: string | undefined;
  try {
    const data = await response.json();
    code = data.error?.code ?? data.error?.type;
  } catch {
    /* Never expose upstream bodies. */
  }
  throw openaiError(response.status, code);
}
function body(input: SendInput, stream: boolean) {
  return JSON.stringify({
    model: input.model,
    instructions: input.system,
    input: input.messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: input.maxTokens,
    ...(temperature(input.model) ? { temperature: input.temperature } : {}),
    store: false,
    stream,
  });
}
function usage(
  value: { input_tokens?: number; output_tokens?: number } | undefined,
  complete: boolean,
) {
  return {
    inputTokens: value?.input_tokens ?? null,
    outputTokens: value?.output_tokens ?? null,
    complete:
      complete && value?.input_tokens != null && value?.output_tokens != null,
  };
}
export const openai: Provider = {
  id: "openai",
  label: "ChatGPT",
  company: "OpenAI",
  keyPrefix: "sk-",
  consoleUrl: "https://platform.openai.com/",
  keyInstructions: [
    "Sign in at platform.openai.com.",
    "Open API keys → Create new secret key. Copy the key starting with sk-.",
    "Add a payment method or credits under Billing.",
  ],
  subscription: "ChatGPT Plus",
  defaultModel: "gpt-4.1-mini",
  acceptsModel,
  fallbackModels: [
    { id: "gpt-4.1-mini", name: "GPT-4.1 mini", temperature: true },
    { id: "gpt-4.1", name: "GPT-4.1", temperature: true },
  ],
  async listModels(key, abort) {
    const response = await checked(
      await fetch(`${endpoint}/models`, {
        headers: headers(key),
        signal: signal(abort),
        cache: "no-store",
      }),
    );
    const data = await response.json();
    const models = (data.data ?? [])
      .filter(
        (m: { id?: string }) => typeof m.id === "string" && acceptsModel(m.id),
      )
      .map((m: { id: string }) => ({
        id: m.id,
        name: m.id,
        temperature: temperature(m.id),
      }));
    if (!models.length)
      throw new AppError(
        "models_empty",
        "No compatible OpenAI text models are available for this key.",
        400,
      );
    return models.sort((a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id),
    );
  },
  async validateKey(key, abort) {
    const models = await this.listModels(key, abort);
    const model =
      models.find((m) => m.id === this.defaultModel) ??
      models.find((m) => m.id.includes("mini")) ??
      models[0];
    await this.send({
      key,
      model: model.id,
      system: "Reply OK.",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0,
      maxTokens: 16,
      signal: abort,
    });
  },
  async send(input) {
    const response = await checked(
      await fetch(`${endpoint}/responses`, {
        method: "POST",
        headers: headers(input.key),
        body: body(input, false),
        signal: signal(input.signal),
      }),
    );
    const data = await response.json();
    if (data.status === "failed") throw openaiError(400, data.error?.code);
    return {
      text: (data.output ?? [])
        .filter((o: { type: string }) => o.type === "message")
        .flatMap(
          (o: {
            content: { type: string; text?: string; refusal?: string }[];
          }) => o.content,
        )
        .map(
          (c: { text?: string; refusal?: string }) => c.text ?? c.refusal ?? "",
        )
        .join(""),
      usage: usage(data.usage, data.status === "completed"),
    };
  },
  async *stream(input): AsyncGenerator<StreamEvent> {
    const response = await checked(
      await fetch(`${endpoint}/responses`, {
        method: "POST",
        headers: headers(input.key),
        body: body(input, true),
        signal: signal(input.signal),
      }),
    );
    if (!response.body)
      throw new AppError(
        "stream_missing",
        "OpenAI did not return a response stream.",
        502,
      );
    let ended = false;
    for await (const raw of frames(response.body, input.signal)) {
      if (raw === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        throw new AppError(
          "stream_invalid",
          "OpenAI returned an unreadable response.",
          502,
        );
      }
      if (
        event.type === "response.output_text.delta" ||
        event.type === "response.refusal.delta"
      )
        yield { type: "delta", text: event.delta };
      if (event.type === "error" || event.type === "response.failed")
        throw openaiError(400, event.code ?? event.response?.error?.code);
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete"
      ) {
        ended = true;
        yield {
          type: "usage",
          usage: usage(
            event.response?.usage,
            event.type === "response.completed",
          ),
        };
        if (event.type === "response.incomplete")
          throw new AppError(
            "output_limit",
            "OpenAI reached the output limit. Your partial response has been saved; increase maximum output tokens to continue.",
            400,
          );
      }
    }
    if (!ended)
      throw new AppError(
        "stream_interrupted",
        "The OpenAI response was interrupted. Your partial response has been saved.",
        502,
      );
  },
};
