import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/server/db";
import { encryptKey } from "../src/lib/server/crypto";
import {
  createAgent,
  editAgent,
  agentAction,
  saveLayout,
} from "../src/lib/server/agents";
import { defaultAgent, ownedAgent, workspace } from "../src/lib/server/store";
import { defaultLayout } from "../src/lib/layout";
import { authenticate, cookie } from "../src/lib/server/security";
import { DELETE, POST } from "../src/app/api/[...path]/route";
import { publish, subscribe, eventStream } from "../src/lib/server/events";
import { startChat, stopRun } from "../src/lib/server/chat";
import { anthropic } from "../src/lib/providers/anthropic";
import { openai } from "../src/lib/providers/openai";
import { agentSchema, layoutSchema } from "../src/lib/server/validation";
let alice = "",
  bob = "",
  first = "",
  second = "",
  session = "";
const request = (path: string, method: string, data?: unknown) =>
  new Request(`http://127.0.0.1:3000/api/${path}`, {
    method,
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      cookie: session,
      "content-type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
  });
const context = (path: string) => ({
  params: Promise.resolve({ path: path.split("/") }),
});
beforeAll(async () => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const migration of readdirSync("prisma/migrations")
    .filter((n) => /^\d/.test(n))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  sqlite.close();
  const token = await authenticate(
    "stage2-alice@test.local",
    "a-long-fixture-password",
    true,
  );
  session = cookie(token).split(";")[0];
  alice = (
    await db.user.findUniqueOrThrow({
      where: { email: "stage2-alice@test.local" },
    })
  ).id;
  bob = (await db.user.create({ data: { email: "stage2-bob@test.local" } })).id;
  for (const provider of ["anthropic", "openai"])
    await db.credential.create({
      data: {
        userId: alice,
        provider,
        encrypted: encryptKey(`fixture-${provider}`, alice, provider),
        last4: "ture",
      },
    });
  first = (await createAgent(alice, defaultAgent)).id;
  second = (
    await createAgent(alice, {
      ...defaultAgent,
      provider: "openai",
      model: "gpt-4.1-mini",
      name: "GPT reviewer",
    })
  ).id;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.$disconnect();
});
describe("stage-two boundaries and saved state", () => {
  it("requires a connected provider and rejects mismatched model families", async () => {
    await expect(createAgent(bob, defaultAgent)).rejects.toMatchObject({
      code: "provider_required",
    });
    expect(
      agentSchema.safeParse({ ...defaultAgent, provider: "openai" }).success,
    ).toBe(false);
  });
  it("persists panel order, positions, size, pins and collapse per user", async () => {
    const layout = {
      ...defaultLayout,
      mode: "2" as const,
      activeId: second,
      order: [second, first],
      pinned: [second],
      collapsed: [first],
      layouts: {
        "2": [
          { i: second, x: 0, y: 0, w: 7, h: 9 },
          { i: first, x: 7, y: 0, w: 5, h: 6 },
        ],
      },
    };
    await saveLayout(alice, layout);
    expect((await workspace({ id: alice, email: "a" })).layout).toEqual(layout);
    expect((await workspace({ id: bob, email: "b" })).layout).toEqual(
      defaultLayout,
    );
    await expect(saveLayout(bob, layout)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      layoutSchema.safeParse({
        ...layout,
        layouts: { "2": [{ i: first, x: 9, y: 0, w: 7, h: 8 }] },
      }).success,
    ).toBe(false);
  });
  it("duplicates configuration with a fresh empty history; archive is reversible", async () => {
    const copy = await agentAction(alice, first, "duplicate");
    const duplicate = await ownedAgent(alice, copy.id);
    expect(duplicate.conversation!.messages).toHaveLength(0);
    expect(duplicate.systemPrompt).toBe(defaultAgent.systemPrompt);
    await agentAction(alice, copy.id, "archive");
    expect((await ownedAgent(alice, copy.id)).archived).toBe(true);
    await expect(
      startChat(alice, copy.id, {
        clientId: crypto.randomUUID(),
        mode: "send",
        text: "blocked",
      }),
    ).rejects.toMatchObject({ code: "agent_inactive" });
    await agentAction(alice, copy.id, "restore");
    await agentAction(alice, copy.id, "pause");
    await expect(
      startChat(alice, copy.id, {
        clientId: crypto.randomUUID(),
        mode: "send",
        text: "blocked",
      }),
    ).rejects.toMatchObject({ code: "agent_inactive" });
    await agentAction(alice, copy.id, "resume");
    expect((await ownedAgent(alice, copy.id)).paused).toBe(false);
    await expect(agentAction(bob, first, "archive")).rejects.toMatchObject({
      status: 404,
    });
    await expect(editAgent(bob, first, defaultAgent)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("stores reusable templates privately without copying messages or credentials", async () => {
    const response = await POST(
      request("templates", "POST", { name: "Review role", agentId: second }),
      context("templates"),
    );
    expect(response.status).toBe(201);
    const id = (await response.json()).id;
    const mine = await workspace({ id: alice, email: "a" });
    const theirs = await workspace({ id: bob, email: "b" });
    expect(mine.templates[0].config.provider).toBe("openai");
    expect(JSON.stringify(mine.templates)).not.toContain("encrypted");
    expect(theirs.templates).toEqual([]);
    expect(
      await db.agentTemplate.deleteMany({ where: { id, userId: bob } }),
    ).toMatchObject({ count: 0 });
    expect(
      (
        await DELETE(
          request(`templates/${id}`, "DELETE"),
          context(`templates/${id}`),
        )
      ).status,
    ).toBe(200);
  });
  it("never publishes another user's live data and stops delivery after revocation", async () => {
    const a = vi.fn(),
      b = vi.fn();
    const removeA = subscribe(alice, a),
      removeB = subscribe(bob, b);
    publish(alice);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    removeA();
    removeB();
    let valid = true;
    const controller = new AbortController();
    const response = eventStream(alice, async () => valid, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    valid = false;
    publish(alice);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "unauthorized",
    );
    expect((await reader.read()).done).toBe(true);
    controller.abort();
  });
  it("runs both providers concurrently; removing one key does not stop the other", async () => {
    const generate = async function* (input: { signal?: AbortSignal }) {
      yield { type: "delta" as const, text: "independent partial" };
      input.signal!.throwIfAborted();
      await new Promise<void>((resolve) =>
        input.signal!.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      input.signal!.throwIfAborted();
    };
    const claudeMock = vi
        .spyOn(anthropic, "stream")
        .mockImplementation(generate),
      openaiMock = vi.spyOn(openai, "stream").mockImplementation(generate);
    const a = await startChat(alice, first, {
        clientId: crypto.randomUUID(),
        mode: "send",
        text: "start Claude",
      }),
      b = await startChat(alice, second, {
        clientId: crypto.randomUUID(),
        mode: "send",
        text: "start OpenAI",
      });
    const ar = a.body!.getReader(),
      br = b.body!.getReader();
    async function partial(reader: ReadableStreamDefaultReader<Uint8Array>) {
      let text = "";
      while (!text.includes("independent partial"))
        text += new TextDecoder().decode((await reader.read()).value);
    }
    await partial(ar);
    await partial(br);
    expect(
      (await ownedAgent(alice, second)).conversation!.activeRunId,
    ).not.toBeNull();
    expect(
      (
        await DELETE(
          request("providers/anthropic", "DELETE"),
          context("providers/anthropic"),
        )
      ).status,
    ).toBe(200);
    while (!(await ar.read()).done) {
      /* drain */
    }
    expect(
      (await ownedAgent(alice, first)).conversation!.runs.at(-1)!.status,
    ).toBe("stopped");
    const other = (await ownedAgent(alice, second)).conversation!;
    expect(other.activeRunId).not.toBeNull();
    expect(other.runs.at(-1)!.provider).toBe("openai");
    await stopRun(alice, other.activeRunId!);
    while (!(await br.read()).done) {
      /* drain */
    }
    claudeMock.mockRestore();
    openaiMock.mockRestore();
  });
});
