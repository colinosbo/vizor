// Loaded ONLY by the isolated test server via --require. Never imported by the app.
const original = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const isOpenAI = String(url).startsWith("https://api.openai.com/v1/");
  if (!isOpenAI && !String(url).startsWith("https://api.anthropic.com/v1/"))
    return original(url, options);
  options.signal?.throwIfAborted();
  const key = new Headers(options.headers).get(
    isOpenAI ? "authorization" : "x-api-key",
  );
  if (key?.includes("invalid"))
    return Response.json(
      { error: { type: "authentication_error", message: "Invalid key" } },
      { status: 401 },
    );
  if (key?.includes("billing"))
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "Credit balance too low",
        },
      },
      { status: 400 },
    );
  if (String(url).includes("/models")) {
    if (isOpenAI)
      return Response.json({
        data: [
          { id: "gpt-4.1-mini" },
          { id: "gpt-4.1" },
          { id: "text-embedding-3-large" },
        ],
      });
    if (key?.includes("fallback"))
      return Response.json(
        { error: { type: "overloaded_error" } },
        { status: 529 },
      );
    return Response.json({
      data: [
        { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
      ],
      has_more: false,
    });
  }
  const body = JSON.parse(options.body);
  if (
    String(url).endsWith("/messages/count_tokens") ||
    String(url).endsWith("/responses/input_tokens")
  )
    return Response.json({ input_tokens: 100 });
  if (body.tools?.length && body.stream) {
    const messages = isOpenAI ? body.input : body.messages;
    const contextMessage = messages.find(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes('"untrusted_reference_data":true'),
    );
    let context = { agents: [] };
    try {
      context = JSON.parse(
        contextMessage.content.slice(contextMessage.content.indexOf("{")),
      );
    } catch {
      /* Fixture only. */
    }
    const lastText =
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            !message.content.includes('"untrusted_reference_data":true'),
        )?.content ?? "";
    const continued = messages.some(
      (message) =>
        message.type === "function_call_output" ||
        (Array.isArray(message.content) &&
          message.content.some((block) => block.type === "tool_result")),
    );
    const target =
      context.agents.find((agent) => agent.name === "Writer") ??
      context.agents[0];
    let call;
    if (!continued && target) {
      const id = `call-${require("node:crypto").randomUUID()}`;
      if (/create.*reviewer|spin up/i.test(lastText))
        call = {
          id,
          name: "create_agent",
          arguments: {
            config: {
              name: "Reviewer",
              provider: isOpenAI ? "openai" : "anthropic",
              model: isOpenAI ? "gpt-4.1-mini" : "claude-sonnet-4-6",
              systemPrompt:
                "Review the work for correctness and clear next steps.",
              temperature: 0.4,
              maxTokens: 512,
              color: "blue",
              icon: "search",
            },
          },
        };
      else if (/rename/i.test(lastText))
        call = {
          id,
          name: "rename_agent",
          arguments: { agent_id: target.id, name: "Lead writer" },
        };
      else if (/archive/i.test(lastText))
        call = {
          id,
          name: "archive_agent",
          arguments: { agent_id: target.id },
        };
      else if (/pause/i.test(lastText))
        call = { id, name: "pause_agent", arguments: { agent_id: target.id } };
      else if (/draft|send.*message|next.step/i.test(lastText))
        call = {
          id,
          name: "send_message",
          arguments: {
            agent_id: target.id,
            text: "Review the current plan and suggest the next practical step.",
          },
        };
      else
        call = {
          id,
          name: "summarize",
          arguments: { agent_ids: context.agents.map((agent) => agent.id) },
        };
    }
    const text = call
      ? "I’m preparing a draft for your review."
      : continued
        ? "The selected agents’ progress is summarized above. Any proposed action is waiting for your approval; nothing was sent automatically."
        : "Create an agent and select it in context to start coordinating.";
    const events = isOpenAI
      ? [
          { type: "response.output_text.delta", delta: text },
          ...(call
            ? [
                {
                  type: "response.output_item.done",
                  item: {
                    type: "function_call",
                    call_id: call.id,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ]
            : []),
          {
            type: "response.completed",
            response: { usage: { input_tokens: 100, output_tokens: 30 } },
          },
        ]
      : [
          { type: "message_start", message: { usage: { input_tokens: 100 } } },
          { type: "content_block_delta", delta: { type: "text_delta", text } },
          ...(call
            ? [
                {
                  type: "content_block_start",
                  index: 1,
                  content_block: {
                    type: "tool_use",
                    id: call.id,
                    name: call.name,
                    input: {},
                  },
                },
                {
                  type: "content_block_delta",
                  index: 1,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(call.arguments),
                  },
                },
                { type: "content_block_stop", index: 1 },
              ]
            : []),
          { type: "message_delta", usage: { output_tokens: 30 } },
          { type: "message_stop" },
        ];
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const event of events) {
            options.signal?.throwIfAborted();
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
            );
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }
  if (isOpenAI) {
    const last = body.input.at(-1)?.content ?? "";
    if (!body.stream)
      return Response.json({
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "OK" }] },
        ],
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    const text = last.includes("[long]")
      ? "OpenAI is streaming independently. ".repeat(35)
      : `An OpenAI response to: ${last}`;
    const encoder = new TextEncoder();
    let stopped = false;
    let timer;
    return new Response(
      new ReadableStream({
        start(controller) {
          let at = 0;
          timer = setInterval(
            () => {
              if (options.signal?.aborted) {
                clearInterval(timer);
                if (!stopped) {
                  stopped = true;
                  controller.error(new DOMException("Aborted", "AbortError"));
                }
                return;
              }
              if (at < text.length) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text.slice(at, at + 15) })}\n\n`,
                  ),
                );
                at += 15;
              } else {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 35, output_tokens: 15 } } })}\n\n`,
                  ),
                );
                clearInterval(timer);
                stopped = true;
                controller.close();
              }
            },
            last.includes("[long]") ? 100 : 25,
          );
        },
        cancel() {
          stopped = true;
          clearInterval(timer);
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }
  if (!body.stream)
    return Response.json({
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 10, output_tokens: 1 },
    });
  const last = body.messages.at(-1)?.content ?? "";
  if (last.includes("[error]"))
    return Response.json(
      { error: { type: "overloaded_error" } },
      { status: 529 },
    );
  const text = last.includes("[long]")
    ? "This is a partial response that will keep streaming until it is stopped. ".repeat(
        12,
      )
    : `Here’s a focused starting point.\n\n### Make the next step clear\n\n1. Define the outcome.\n2. Start with the smallest useful version.\n3. Review what you learn.\n\n\`\`\`typescript\nconst nextStep = \"Make something useful\";\n\`\`\`\n\nYou said: ${last}\n\n<img src=\"https://tracker.invalid/pixel\">\n\n![hidden](https://tracker.invalid/pixel)`;
  const encoder = new TextEncoder();
  let timer;
  let stopped = false;
  const stream = new ReadableStream({
    start(c) {
      const emit = (event) => {
        if (!stopped)
          c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      emit({ type: "message_start", message: { usage: { input_tokens: 42 } } });
      let at = 0;
      timer = setInterval(
        () => {
          if (options.signal?.aborted) {
            clearInterval(timer);
            if (!stopped) {
              stopped = true;
              c.error(new DOMException("Aborted", "AbortError"));
            }
            return;
          }
          if (at < text.length) {
            emit({
              type: "content_block_delta",
              delta: { type: "text_delta", text: text.slice(at, at + 18) },
            });
            at += 18;
          } else {
            emit({ type: "message_delta", usage: { output_tokens: 90 } });
            emit({ type: "message_stop" });
            clearInterval(timer);
            stopped = true;
            c.close();
          }
        },
        last.includes("[long]") ? 120 : 20,
      );
    },
    cancel() {
      stopped = true;
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
};
