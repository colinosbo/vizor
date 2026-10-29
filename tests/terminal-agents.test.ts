import { beforeAll, afterAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { db } from "../src/lib/server/db";
import { createAgent, editAgent } from "../src/lib/server/agents";
import { defaultAgent } from "../src/lib/server/store";
import {
  terminalAgent,
  recordTerminal,
} from "../src/lib/server/terminal-agents";
import { startChat } from "../src/lib/server/chat";
import { randomUUID } from "node:crypto";
beforeAll(async () => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const name of readdirSync("prisma/migrations")
    .filter((n) => /^\d/.test(n))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"),
    );
  sqlite.close();
  await db.user.createMany({
    data: [
      { id: "terminal-owner", email: "terminal@local" },
      { id: "terminal-other", email: "other@local" },
    ],
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
const config = {
  ...defaultAgent,
  engine: "claude-code" as const,
  projectPath: "C:\\project",
};
it("requires the desktop local-owner capability, then creates without an API key", async () => {
  await expect(createAgent("terminal-owner", config)).rejects.toThrow(
    "Windows desktop",
  );
  vi.stubEnv("SELF_HOST", "true");
  vi.stubEnv("VIZOR_TERMINALS", "1");
  const agent = await createAgent("terminal-owner", config);
  const session = await terminalAgent("terminal-owner", agent.id);
  expect(session.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(session.terminalStarted).toBe(false);
  await expect(terminalAgent("terminal-other", agent.id)).rejects.toThrow(
    "not found",
  );
  await expect(
    recordTerminal("terminal-other", agent.id, {
      nativeSessionId: randomUUID(),
      event: "started",
    }),
  ).rejects.toThrow();
  await expect(
    startChat("terminal-owner", agent.id, {
      mode: "send",
      clientId: randomUUID(),
      text: "do not send",
    }),
  ).rejects.toThrow("terminal");
  await recordTerminal("terminal-owner", agent.id, {
    nativeSessionId: session.nativeSessionId!,
    event: "started",
  });
  expect(
    (await terminalAgent("terminal-owner", agent.id)).terminalStarted,
  ).toBe(true);
  expect((await terminalAgent("terminal-owner", agent.id)).terminalState).toBe(
    "running",
  );
  await expect(
    recordTerminal("terminal-owner", agent.id, {
      nativeSessionId: randomUUID(),
      event: "started",
    }),
  ).rejects.toThrow("own native session");
  await recordTerminal("terminal-owner", agent.id, {
    nativeSessionId: session.nativeSessionId!,
    event: "stopped",
  });
  expect((await terminalAgent("terminal-owner", agent.id)).terminalState).toBe(
    "stopped",
  );
  await expect(
    editAgent("terminal-owner", agent.id, {
      ...config,
      projectPath: "C:\\other",
    }),
  ).rejects.toThrow("new agent");
});
