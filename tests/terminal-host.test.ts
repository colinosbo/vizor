import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

async function hostRequest(action: string, authMode = "subscription") {
  let handler: (message: unknown) => Promise<void> = async () => {};
  const start = vi.fn(async () => ({ state: "running" }));
  const send = vi.fn();
  const fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes("terminal-credentials")
        ? { apiKey: "fixture-api" }
        : { id: "worker", engine: "claude-code", terminalAuthMode: authMode },
  }));
  class Sessions {
    start = start;
    list = () => [];
  }
  runInNewContext(readFileSync("desktop/terminal-host/host.cjs", "utf8"), {
    require: (name: string) => {
      if (name === "./sessions.cjs") return { Sessions };
      if (name === "./tools.cjs")
        return { findTool: () => "fixture-native.exe" };
      if (name === "node:fs") return { mkdirSync: () => {} };
      if (name === "node:path")
        return { join: (...parts: string[]) => parts.join("/") };
      if (name === "./isolated-pty.cjs") return {};
      throw Error("Unexpected helper dependency");
    },
    fetch,
    setInterval: () => ({ unref() {} }),
    process: {
      env: {
        VIZOR_TOOLS_HOME: "fixture",
        VIZOR_TERMINAL_ORIGIN: "http://127.0.0.1:3000",
        VIZOR_TERMINAL_TOKEN: "fixture-private-ipc",
      },
      connected: true,
      send,
      on: (event: string, cb: any) => {
        if (event === "message") handler = cb;
      },
    },
  });
  await handler({
    id: "fixture",
    action,
    args: { agentId: "worker", engine: "claude-code" },
  });
  return { start, send, fetch };
}
it("starts subscription workers without ever fetching a saved API key", async () => {
  const host = await hostRequest("start");
  expect(host.fetch).toHaveBeenCalledTimes(1);
  expect(host.start).toHaveBeenCalledWith(
    expect.objectContaining({ terminalAuthMode: "subscription" }),
    false,
    false,
    null,
  );
});
it("opens native subscription sign-in with no API credential request", async () => {
  const host = await hostRequest("setup");
  expect(host.fetch).not.toHaveBeenCalled();
  expect(host.start).toHaveBeenCalledWith(
    expect.objectContaining({ id: "setup-claude-code" }),
    false,
    true,
    null,
  );
});
it("only supplies API credentials when a worker explicitly selects API billing", async () => {
  const host = await hostRequest("start", "api");
  expect(host.fetch).toHaveBeenCalledTimes(2);
  expect(host.start).toHaveBeenCalledWith(
    expect.objectContaining({ terminalAuthMode: "api" }),
    false,
    false,
    "fixture-api",
  );
});
