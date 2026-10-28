import { readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/server/db";
import {
  authenticate,
  checkRequest,
  cookie,
  logout,
  owner,
} from "../src/lib/server/security";
import { encryptKey } from "../src/lib/server/crypto";
import {
  ownedAgent,
  ownedRun,
  workspace,
  defaultAgent,
} from "../src/lib/server/store";
import { startChat, stopRun } from "../src/lib/server/chat";
import { anthropic } from "../src/lib/providers/anthropic";
import { GET, POST, DELETE, PATCH } from "../src/app/api/[...path]/route";
import { estimateCost } from "../src/lib/server/pricing";
const fixtureKey = "sk-ant-mocked-fixture-only";
let alice = "",
  bob = "",
  agentId = "",
  conversationId = "",
  aliceCookie = "",
  bobCookie = "";
const req = (
  path: string,
  method = "GET",
  body?: unknown,
  session = aliceCookie,
) =>
  new Request(`http://127.0.0.1:3000/api/${path}`, {
    method,
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      cookie: session,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (path: string) => ({
  params: Promise.resolve({ path: path.split("/") }),
});
beforeAll(async () => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const migration of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  sqlite.close();
  const aToken = await authenticate(
      "alice@test.local",
      "a-long-test-password",
      true,
    ),
    bToken = await authenticate(
      "bob@test.local",
      "another-long-password",
      true,
    );
  aliceCookie = cookie(aToken).split(";")[0];
  bobCookie = cookie(bToken).split(";")[0];
  alice = (await owner(req("workspace"))).id;
  bob = (await owner(req("workspace", "GET", undefined, bobCookie))).id;
  const agent = await db.agent.create({
    data: { ...defaultAgent, userId: alice, conversation: { create: {} } },
    include: { conversation: true },
  });
  agentId = agent.id;
  conversationId = agent.conversation!.id;
  await db.credential.create({
    data: {
      userId: alice,
      provider: "anthropic",
      encrypted: encryptKey(fixtureKey, alice, "anthropic"),
      last4: "only",
    },
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.$disconnect();
});
describe("real SQLite isolation and sessions", () => {
  it("hashes passwords and session tokens", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: alice } });
    expect(user.passwordHash).toContain("$argon2id$");
    expect(user.passwordHash).not.toContain("a-long-test-password");
    const sessions = await db.session.findMany({ where: { userId: alice } });
    expect(aliceCookie).not.toContain(sessions[0].id);
  });
  it("rejects missing, expired, and revoked sessions", async () => {
    await expect(
      owner(req("workspace", "GET", undefined, "")),
    ).rejects.toMatchObject({ status: 401 });
    const token = await authenticate(
      "alice@test.local",
      "a-long-test-password",
      false,
    );
    const session = cookie(token).split(";")[0];
    await logout(req("workspace", "POST", undefined, session));
    await expect(
      owner(req("workspace", "GET", undefined, session)),
    ).rejects.toMatchObject({ status: 401 });
    await db.session.updateMany({
      where: { userId: bob },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      owner(req("workspace", "GET", undefined, bobCookie)),
    ).rejects.toMatchObject({ status: 401 });
    const bToken = await authenticate(
      "bob@test.local",
      "another-long-password",
      false,
    );
    bobCookie = cookie(bToken).split(";")[0];
  });
  it("blocks cross-origin mutations and unexpected hosts", () => {
    expect(() =>
      checkRequest(
        new Request("http://127.0.0.1:3000/api/events", {
          headers: {
            host: "127.0.0.1:3000",
            origin: "https://other.test",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      checkRequest(
        new Request("http://evil.test", { headers: { host: "evil.test" } }),
      ),
    ).toThrow();
    expect(() =>
      checkRequest(
        new Request("http://127.0.0.1:3000/api/agents", {
          method: "POST",
          headers: { host: "127.0.0.1:3000", origin: "http://evil.test" },
        }),
      ),
    ).toThrow();
  });
  it("does not reveal another owner's agents, messages or credentials", async () => {
    const view = await workspace({ id: bob, email: "bob@test.local" });
    expect(view.agents).toEqual([]);
    expect(view.provider.connected).toBe(false);
    await expect(ownedAgent(bob, agentId)).rejects.toMatchObject({
      status: 404,
    });
    const own = JSON.stringify(
      await workspace({ id: alice, email: "alice@test.local" }),
    );
    expect(own).not.toContain(fixtureKey);
    expect(own).not.toContain("encrypted");
    expect(own).not.toContain("passwordHash");
    expect(
      (
        await PATCH(
          req(`agents/${agentId}`, "PATCH", defaultAgent, bobCookie),
          ctx(`agents/${agentId}`),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await POST(
          req(
            `agents/${agentId}/messages`,
            "POST",
            { clientId: crypto.randomUUID(), text: "intrude" },
            bobCookie,
          ),
          ctx(`agents/${agentId}/messages`),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await GET(
          req("providers/anthropic/models", "GET", undefined, bobCookie),
          ctx("providers/anthropic/models"),
        )
      ).status,
    ).toBe(400);
  });
  it("leaves Alice's credential in place when Bob removes their own key", async () => {
    const response = await DELETE(
      req("providers/anthropic", "DELETE", undefined, bobCookie),
      ctx("providers/anthropic"),
    );
    expect(response.status).toBe(200);
    expect(await db.credential.count({ where: { userId: alice } })).toBe(1);
  });
});
describe("stream lifecycle and durable history (mocked provider)", () => {
  it("persists output and usage; duplicate client IDs never call the provider twice", async () => {
    const mock = vi
      .spyOn(anthropic, "stream")
      .mockImplementation(async function* () {
        yield { type: "delta", text: "Hello **world**" };
        yield {
          type: "usage",
          usage: { inputTokens: 12, outputTokens: 4, complete: true },
        };
      });
    const clientId = crypto.randomUUID();
    const response = await startChat(alice, agentId, {
      clientId,
      text: "hello",
      mode: "send",
    });
    expect(await response.text()).toContain("Hello **world**");
    const again = await startChat(alice, agentId, {
      clientId,
      text: "hello",
      mode: "send",
    });
    expect((await again.json()).existing).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    const agent = await ownedAgent(alice, agentId);
    const run = agent.conversation!.runs.at(-1)!;
    expect(run.usageComplete).toBe(true);
    expect(run.cost).toBeGreaterThan(0);
    expect(agent.conversation!.activeRunId).toBeNull();
    await expect(ownedRun(bob, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(stopRun(bob, run.id)).rejects.toMatchObject({ status: 404 });
    mock.mockRestore();
  });
  it("rejects concurrent generations in one conversation", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mock = vi
      .spyOn(anthropic, "stream")
      .mockImplementation(async function* () {
        yield { type: "delta", text: "first" };
        await gate;
      });
    const first = await startChat(alice, agentId, {
      clientId: crypto.randomUUID(),
      text: "one",
      mode: "send",
    });
    await expect(
      startChat(alice, agentId, {
        clientId: crypto.randomUUID(),
        text: "two",
        mode: "send",
      }),
    ).rejects.toMatchObject({ status: 409 });
    finish();
    await first.text();
    mock.mockRestore();
  });
  it("aborts an upstream stream, saves partial output and marks usage incomplete", async () => {
    const mock = vi
      .spyOn(anthropic, "stream")
      .mockImplementation(async function* (input) {
        yield { type: "delta", text: "Partial answer" };
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        input.signal!.throwIfAborted();
      });
    const response = await startChat(alice, agentId, {
      clientId: crypto.randomUUID(),
      text: "cancel me",
      mode: "send",
    });
    const reader = response.body!.getReader();
    let content = "";
    while (!content.includes("Partial answer")) {
      const part = await reader.read();
      content += new TextDecoder().decode(part.value);
    }
    const active = await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    await stopRun(alice, active.activeRunId!);
    while (!(await reader.read()).done) {
      /* drain to ensure final persistence */
    }
    const agent = await ownedAgent(alice, agentId);
    expect(agent.conversation!.messages.at(-1)!.text).toBe("Partial answer");
    expect(agent.conversation!.runs.at(-1)!.status).toBe("stopped");
    expect(agent.conversation!.runs.at(-1)!.usageComplete).toBe(false);
    mock.mockRestore();
  });
  it("requires confirmation before destructive edits, and replaces the later branch", async () => {
    const original = await ownedAgent(alice, agentId);
    const message = original.conversation!.messages[0];
    await expect(
      startChat(alice, agentId, {
        clientId: crypto.randomUUID(),
        text: "replacement",
        mode: "edit",
        messageId: message.id,
      }),
    ).rejects.toMatchObject({ code: "edit_confirmation" });
    const mock = vi
      .spyOn(anthropic, "stream")
      .mockImplementation(async function* () {
        yield { type: "delta", text: "New branch" };
      });
    await (
      await startChat(alice, agentId, {
        clientId: crypto.randomUUID(),
        text: "replacement",
        mode: "edit",
        messageId: message.id,
        confirm: true,
      })
    ).text();
    const next = await ownedAgent(alice, agentId);
    expect(next.conversation!.messages.map((m) => m.text)).toEqual([
      "replacement",
      "New branch",
    ]);
    mock.mockRestore();
  });
  it("preserves an existing key after failed validation", async () => {
    const mock = vi
      .spyOn(anthropic, "validateKey")
      .mockRejectedValue(new Error("private-provider-payload"));
    const response = await POST(
      req("providers/anthropic", "POST", { key: "sk-ant-new-invalid-fixture" }),
      ctx("providers/anthropic"),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-provider");
    expect(
      (await db.credential.findFirstOrThrow({ where: { userId: alice } }))
        .last4,
    ).toBe("only");
    mock.mockRestore();
  });
  it("shows unknown model or incomplete usage costs as unavailable", () => {
    expect(estimateCost("unknown", 20, 10)).toBeNull();
    expect(estimateCost("claude-sonnet-4-6", 20, null)).toBeNull();
  });
  it("cancels on response disconnect and durably keeps partial text", async () => {
    const mock = vi
      .spyOn(anthropic, "stream")
      .mockImplementation(async function* (input) {
        yield { type: "delta", text: "Saved before disconnect" };
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        input.signal!.throwIfAborted();
      });
    const response = await startChat(alice, agentId, {
      clientId: crypto.randomUUID(),
      text: "disconnect",
      mode: "send",
    });
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes("Saved before disconnect"))
      received += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    await vi.waitFor(async () => {
      expect(
        (await ownedAgent(alice, agentId)).conversation!.activeRunId,
      ).toBeNull();
    });
    const latest = (await ownedAgent(alice, agentId)).conversation!;
    expect(latest.messages.at(-1)!.text).toBe("Saved before disconnect");
    expect(latest.runs.at(-1)!.status).toBe("stopped");
    mock.mockRestore();
  });
  it("really deletes the stored key and aborts its active generation", async () => {
    const mock = vi
      .spyOn(anthropic, "stream")
      .mockImplementation(async function* (input) {
        yield { type: "delta", text: "Before key removal" };
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        input.signal!.throwIfAborted();
      });
    const response = await startChat(alice, agentId, {
      clientId: crypto.randomUUID(),
      text: "delete key",
      mode: "send",
    });
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes("Before key removal"))
      received += new TextDecoder().decode((await reader.read()).value);
    expect(
      (
        await DELETE(
          req("providers/anthropic", "DELETE"),
          ctx("providers/anthropic"),
        )
      ).status,
    ).toBe(200);
    while (!(await reader.read()).done) {
      /* wait for the abort finalizer */
    }
    expect(await db.credential.count({ where: { userId: alice } })).toBe(0);
    expect(
      (await ownedAgent(alice, agentId)).conversation!.runs.at(-1)!.status,
    ).toBe("stopped");
    await expect(
      startChat(alice, agentId, {
        clientId: crypto.randomUUID(),
        text: "blocked",
        mode: "send",
      }),
    ).rejects.toMatchObject({ code: "provider_required" });
    mock.mockRestore();
  });
});
