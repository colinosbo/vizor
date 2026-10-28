import { afterEach, describe, expect, it, vi } from "vitest";
import { openai, openaiError } from "../src/lib/providers/openai";
import type { StreamEvent } from "../src/lib/providers/types";
const input = {
  key: "sk-openai-fixture-not-real",
  model: "gpt-4.1-mini",
  system: "Be useful",
  messages: [{ role: "user" as const, content: "hello" }],
  temperature: 0.7,
  maxTokens: 128,
};
afterEach(() => vi.unstubAllGlobals());
describe("OpenAI adapter (mocked HTTP only)", () => {
  it("fetches live compatible text models and excludes embeddings/audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          data: [
            { id: "gpt-4.1-mini" },
            { id: "gpt-5" },
            { id: "gpt-4o-realtime-preview" },
            { id: "text-embedding-3-large" },
          ],
        }),
      ),
    );
    expect((await openai.listModels(input.key)).map((m) => m.id)).toEqual([
      "gpt-4.1-mini",
      "gpt-5",
    ]);
  });
  it("uses Responses with remote storage disabled and omits unsupported temperature", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Hello" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect((await openai.send({ ...input, model: "gpt-5" })).text).toBe(
      "Hello",
    );
    const request = JSON.parse(fetch.mock.calls[0][1].body);
    expect(request.store).toBe(false);
    expect(request).not.toHaveProperty("temperature");
    expect(fetch.mock.calls[0][0]).not.toContain(input.key);
    expect(request.max_output_tokens).toBe(128);
  });
  it("connection validation makes one capped inference after model discovery", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "gpt-4.1-mini" }] }))
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          output: [],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
      );
    vi.stubGlobal("fetch", mock);
    await openai.validateKey(input.key);
    expect(JSON.parse(mock.mock.calls[1][1].body).max_output_tokens).toBe(16);
  });
  it("streams split UTF-8 events and reports final usage", async () => {
    const data = [
      { type: "response.output_text.delta", delta: "Hello 🌿" },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 25, output_tokens: 7 } },
      },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`)
      .join("");
    const encoded = new TextEncoder().encode(data);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              for (const value of encoded) c.enqueue(new Uint8Array([value]));
              c.close();
            },
          }),
        ),
      ),
    );
    const events: StreamEvent[] = [];
    for await (const event of openai.stream(input)) events.push(event);
    expect(events[0]).toEqual({ type: "delta", text: "Hello 🌿" });
    expect(events.at(-1)).toEqual({
      type: "usage",
      usage: { inputTokens: 25, outputTokens: 7, complete: true },
    });
  });
  it("preserves incomplete usage and reports an output cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `data: ${JSON.stringify({ type: "response.incomplete", response: { usage: { input_tokens: 10, output_tokens: 128 } } })}\n\n`,
          ),
        ),
    );
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const event of openai.stream(input)) events.push(event);
    }).rejects.toMatchObject({ code: "output_limit" });
    expect(events[0]).toEqual({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 128, complete: false },
    });
  });
  it("rejects truncated output and propagates abort signals", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          ),
        ),
    );
    await expect(async () => {
      for await (const _ of openai.stream(input)) {
        /* consume */
      }
    }).rejects.toMatchObject({ code: "stream_interrupted" });
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, init) => init.signal.throwIfAborted()),
    );
    await expect(
      openai.send({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
  });
  it("separates depleted credit from ordinary rate limits without leaking upstream messages", () => {
    expect(openaiError(429, "insufficient_quota").code).toBe("billing");
    expect(openaiError(429).code).toBe("rate_limited");
    expect(openaiError(401).code).toBe("invalid_key");
    expect(openaiError(503).code).toBe("provider_unavailable");
  });
});
