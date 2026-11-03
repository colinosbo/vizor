import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("exposes task delivery through the protected desktop terminal bridge", async () => {
  let exposed: any;
  const ipcRenderer = {
    invoke: vi.fn(async () => ({ ok: true })),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: vi.fn((_name, value) => {
        exposed = value;
      }),
    },
    ipcRenderer,
  };
  runInNewContext(readFileSync("desktop/preload.cjs", "utf8"), {
    require: (name: string) => {
      if (name !== "electron") throw Error("Unexpected preload dependency");
      return electron;
    },
    process: { isMainFrame: true },
  });

  await exposed.terminals.sendTask("owned-agent", "live-token", "task text");

  expect(ipcRenderer.invoke).toHaveBeenCalledWith(
    "vizor:terminal",
    "sendTask",
    {
      agentId: "owned-agent",
      token: "live-token",
      text: "task text",
    },
  );
});
