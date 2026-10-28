import { afterEach, expect, it, vi } from "vitest";
import { anthropic } from "../src/lib/providers/anthropic";
import { openai } from "../src/lib/providers/openai";
import { orchestratorTools } from "../src/lib/server/orchestrator-context";
import type {
  Provider,
  SendInput,
  StreamEvent,
} from "../src/lib/providers/types";
const input: SendInput = {
  key: "fixture-key-never-real",
  model: "claude-sonnet-4-6",
  system: "Only draft",
  messages: [{ role: "user", content: "Propose a message" }],
  tools: orchestratorTools,
  maxTokens: 512,
  temperature: 0.4,
};
function fragmented(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});
it("assembles fragmented Anthropic tool JSON only at content-block completion", async () => {
  const mock = vi.fn().mockResolvedValue(
    fragmented([
      { type: "message_start", message: { usage: { input_tokens: 100 } } },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call-a",
          name: "send_message",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"agent_id":"a",' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '"text":"Héllo 🌿"}',
        },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ]),
  );
  vi.stubGlobal("fetch", mock);
  const events: StreamEvent[] = [];
  for await (const event of anthropic.stream(input)) events.push(event);
  expect(events.filter((e) => e.type === "tool")).toEqual([
    {
      type: "tool",
      call: {
        id: "call-a",
        name: "send_message",
        arguments: { agent_id: "a", text: "Héllo 🌿" },
      },
    },
  ]);
  expect(JSON.parse(mock.mock.calls[0][1].body).tools[0]).toHaveProperty(
    "input_schema",
  );
});
it("accepts OpenAI completed native calls and deduplicates completion events", async () => {
  const call = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "call-b",
      name: "pause_agent",
      arguments: '{"agent_id":"b"}',
    },
  };
  const mock = vi.fn().mockResolvedValue(
    fragmented([
      { type: "response.function_call_arguments.delta", delta: '{"agent_' },
      call,
      call,
      {
        type: "response.completed",
        response: { usage: { input_tokens: 100, output_tokens: 30 } },
      },
    ]),
  );
  vi.stubGlobal("fetch", mock);
  const events: StreamEvent[] = [];
  for await (const event of openai.stream({ ...input, model: "gpt-4.1-mini" }))
    events.push(event);
  expect(events.filter((e) => e.type === "tool")).toEqual([
    {
      type: "tool",
      call: { id: "call-b", name: "pause_agent", arguments: { agent_id: "b" } },
    },
  ]);
  const payload = JSON.parse(mock.mock.calls[0][1].body);
  expect(payload.store).toBe(false);
  expect(payload.parallel_tool_calls).toBe(false);
  expect(payload.tools[0].strict).toBe(true);
});
it.each([anthropic, openai])(
  "$id rejects malformed native arguments without exposing their contents",
  async (adapter: Provider) => {
    const events =
      adapter.id === "anthropic"
        ? [
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "bad",
                name: "send_message",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: {
                type: "input_json_delta",
                partial_json: '{"secret-sensitive',
              },
            },
            { type: "content_block_stop", index: 1 },
            { type: "message_stop" },
          ]
        : [
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "bad",
                name: "send_message",
                arguments: '{"secret-sensitive',
              },
            },
          ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fragmented(events)));
    await expect(async () => {
      for await (const _ of adapter.stream({
        ...input,
        model: adapter.defaultModel,
      })) {
        /* drain */
      }
    }).rejects.toMatchObject({ code: "tool_invalid" });
  },
);
it.each([anthropic, openai])(
  "$id serializes native tool results in token preflight without issuing inference",
  async (adapter: Provider) => {
    const mock = vi
      .fn()
      .mockResolvedValue(Response.json({ input_tokens: 123 }));
    vi.stubGlobal("fetch", mock);
    expect(
      await adapter.countTokens!({
        ...input,
        model: adapter.defaultModel,
        messages: [
          { role: "user", content: "Summarize" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-s",
                name: "summarize",
                arguments: { agent_ids: ["a"] },
              },
            ],
          },
          { role: "tool", callId: "call-s", content: '{"readOnly":true}' },
        ],
      }),
    ).toBe(123);
    const payload = JSON.parse(mock.mock.calls[0][1].body);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toMatch(
      adapter.id === "anthropic"
        ? /messages\/count_tokens$/
        : /responses\/input_tokens$/,
    );
    expect(payload).not.toHaveProperty("stream");
    expect(JSON.stringify(payload)).toContain(
      adapter.id === "anthropic" ? "tool_result" : "function_call_output",
    );
    expect(JSON.stringify(payload)).not.toContain(input.key);
  },
);
