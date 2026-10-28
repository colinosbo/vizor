import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropic,
  frames,
  providerError,
} from "../src/lib/providers/anthropic";
const input = {
  key: "sk-ant-test-only",
  model: "claude-sonnet-4-6",
  system: "Be helpful",
  messages: [{ role: "user" as const, content: "hello" }],
  temperature: 0.7,
  maxTokens: 64,
};
function sse(events: unknown[], fragment = 7) {
  const bytes = new TextEncoder().encode(
    events
      .map((e) => `event: message\r\ndata: ${JSON.stringify(e)}\r\n\r\n`)
      .join(""),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += fragment)
          c.enqueue(bytes.slice(i, i + fragment));
        c.close();
      },
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe("Anthropic adapter (mocked HTTP only)", () => {
  it("discovers live models across pages without leaking keys into URLs", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "claude-sonnet-4-6", display_name: "Sonnet" }],
          has_more: true,
          last_id: "first",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "claude-haiku-4-5-20251001", display_name: "Haiku" }],
          has_more: false,
        }),
      );
    vi.stubGlobal("fetch", mock);
    const models = await anthropic.listModels(input.key);
    expect(models).toHaveLength(2);
    expect(models[0].temperature).toBe(false);
    expect(models[1].temperature).toBe(true);
    expect(mock.mock.calls[1][0]).toContain("after_id=first");
    expect(mock.mock.calls[0][0]).not.toContain(input.key);
  });
  it("validates with a minimal capped inference, not just model access", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "claude-haiku-4-5-20251001" }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
      );
    vi.stubGlobal("fetch", mock);
    await anthropic.validateKey(input.key);
    expect(JSON.parse(mock.mock.calls[1][1].body).max_tokens).toBe(8);
  });
  it("streams fragmented CRLF and multibyte text with actual final usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse(
          [
            {
              type: "message_start",
              message: { usage: { input_tokens: 123 } },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Héllo 🌿" },
            },
            { type: "message_delta", usage: { output_tokens: 9 } },
            { type: "message_stop" },
          ],
          1,
        ),
      ),
    );
    const events = [];
    for await (const event of anthropic.stream(input)) events.push(event);
    expect(events).toContainEqual({ type: "delta", text: "Héllo 🌿" });
    expect(events.at(-1)).toEqual({
      type: "usage",
      usage: { inputTokens: 123, outputTokens: 9, complete: true },
    });
  });
  it("rejects prematurely terminated and malformed streams", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sse([{ type: "message_start" }])),
    );
    await expect(async () => {
      for await (const _ of anthropic.stream(input)) {
        /* consume */
      }
    }).rejects.toThrow("interrupted");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("data: not-json\n\n")),
    );
    await expect(async () => {
      for await (const _ of anthropic.stream(input)) {
        /* consume */
      }
    }).rejects.toThrow("unreadable");
  });
  it("passes abort signals upstream and cancels stream readers", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, init) => {
        init.signal.throwIfAborted();
      }),
    );
    await expect(async () => {
      for await (const _ of anthropic.stream({
        ...input,
        signal: controller.signal,
      })) {
        /* consume */
      }
    }).rejects.toThrow();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: hi\n\n"));
      },
      cancel: cancelled,
    });
    for await (const _ of frames(stream)) break;
    expect(cancelled).toHaveBeenCalled();
  });
  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [402, "billing"],
    [429, "rate_limited"],
    [529, "provider_unavailable"],
    [404, "model_unavailable"],
  ])("normalizes HTTP %s without returning upstream text", (status, code) => {
    expect(providerError(status as number).code).toBe(code);
  });
  it("recognizes billing errors and never exposes the raw error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              message: "Your credit balance is too low sk-ant-sensitive",
            },
          },
          { status: 400 },
        ),
      ),
    );
    await expect(anthropic.send(input)).rejects.toMatchObject({
      code: "billing",
    });
    try {
      await anthropic.send(input);
    } catch (e) {
      expect((e as Error).message).not.toContain("sk-ant");
    }
  });
  it("omits unsupported temperature for newer models", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(Response.json({ content: [], usage: {} }));
    vi.stubGlobal("fetch", mock);
    await anthropic.send({ ...input, model: "claude-unknown-future-model" });
    expect(JSON.parse(mock.mock.calls[0][1].body)).not.toHaveProperty(
      "temperature",
    );
  });
});
