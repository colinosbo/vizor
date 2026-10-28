import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  expect,
  it,
  vi,
  describe,
} from "vitest";
import { db } from "../src/lib/server/db";
import {
  setBudget,
  reserveSpend,
  settleSpend,
  budgetViews,
  meteredSend,
  meteredStream,
  recoverSpending,
  periodNow,
} from "../src/lib/server/budgets";
import { anthropic } from "../src/lib/providers/anthropic";
import { AppError } from "../src/lib/server/errors";
import type { SendInput } from "../src/lib/providers/types";
const input: SendInput = {
  key: "fixture-only",
  model: "claude-sonnet-4-6",
  system: "Be useful",
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.4,
  maxTokens: 512,
};
let userId = "";
beforeAll(() => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const migration of readdirSync("prisma/migrations")
    .filter((n) => /^\d/.test(n))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  sqlite.close();
});
beforeEach(async () => {
  userId = (
    await db.user.create({ data: { email: `${randomUUID()}@budget.test` } })
  ).id;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected real network");
    }),
  );
  vi.spyOn(anthropic, "countTokens").mockResolvedValue(100);
  vi.spyOn(anthropic, "send").mockResolvedValue({
    text: "OK",
    usage: { inputTokens: 100, outputTokens: 30, complete: true },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.$disconnect();
});
async function view() {
  return (await budgetViews(userId)).find((p) => p.provider === "anthropic")!;
}
describe("provider monthly spending reservations", () => {
  it("serializes concurrent maximum-cost reservations instead of overspending the same balance", async () => {
    // 366 buffered input tokens at $3/M and 512 output tokens at $15/M = $0.008778 each.
    await setBudget(userId, "anthropic", 0.01);
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        reserveSpend(userId, "anthropic", input, { source: "chat" }),
      ),
    );
    const accepted = attempts.filter((r) => r.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    expect((await view()).reserved).toBe(0.008778);
    expect((await view()).warning).toBe(true);
    expect(anthropic.send).not.toHaveBeenCalled();
    await settleSpend((accepted[0] as PromiseFulfilledResult<string>).value, {
      inputTokens: 100,
      outputTokens: 30,
      complete: true,
    });
    expect(await view()).toMatchObject({
      reserved: 0,
      spent: 0.00075,
      warning: false,
    });
  });
  it("blocks zero limits before token counting or paid generation", async () => {
    await setBudget(userId, "anthropic", 0);
    await expect(
      meteredSend(userId, "anthropic", input, { source: "connection" }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(anthropic.countTokens).not.toHaveBeenCalled();
    expect(anthropic.send).not.toHaveBeenCalled();
    expect(await db.spendEntry.count({ where: { userId } })).toBe(0);
    expect((await view()).blocked).toBe(true);
    expect(
      await db.auditEntry.count({
        where: { userId, action: "budget.blocked" },
      }),
    ).toBe(1);
  });
  it("requires a priced model and a successful token count when protection is enabled", async () => {
    await setBudget(userId, "anthropic", 10);
    await expect(
      meteredSend(
        userId,
        "anthropic",
        { ...input, model: "claude-future-unpriced" },
        { source: "chat" },
      ),
    ).rejects.toMatchObject({ code: "budget_unpriced" });
    vi.mocked(anthropic.countTokens!).mockRejectedValueOnce(
      new AppError("token_count", "Unavailable", 503),
    );
    await expect(
      meteredSend(userId, "anthropic", input, { source: "chat" }),
    ).rejects.toMatchObject({ code: "token_count" });
    vi.mocked(anthropic.countTokens!).mockResolvedValueOnce(NaN);
    await expect(
      meteredSend(userId, "anthropic", input, { source: "chat" }),
    ).rejects.toMatchObject({ code: "token_count" });
    expect(anthropic.send).not.toHaveBeenCalled();
    expect((await view()).reserved).toBe(0);
  });
  it("meters connection tests, orchestrator calls and direct chats against one provider balance", async () => {
    await setBudget(userId, "anthropic", 1);
    for (const source of ["connection", "orchestrator", "chat"] as const)
      await meteredSend(userId, "anthropic", input, { source });
    expect((await view()).spent).toBe(0.00225);
    expect(
      await db.spendEntry.count({
        where: { userId, status: "settled", estimated: false },
      }),
    ).toBe(3);
    expect(anthropic.countTokens).toHaveBeenCalledTimes(3);
  });
  it("keeps accounting separate for each owner and each provider", async () => {
    const other = (
      await db.user.create({ data: { email: `${randomUUID()}@other.test` } })
    ).id;
    await setBudget(userId, "anthropic", 0);
    await setBudget(other, "anthropic", 1);
    await meteredSend(other, "anthropic", input, { source: "chat" });
    expect((await view()).spent).toBe(0);
    expect(
      (await budgetViews(other)).find((p) => p.provider === "anthropic")?.spent,
    ).toBe(0.00075);
    expect(
      (await budgetViews(other)).find((p) => p.provider === "openai")?.spent,
    ).toBe(0);
  });
  it("does not allow changing the policy while an upstream request is reserved", async () => {
    await setBudget(userId, "anthropic", 1);
    const id = await reserveSpend(userId, "anthropic", input, {
      source: "chat",
    });
    await expect(setBudget(userId, "anthropic", null)).rejects.toMatchObject({
      code: "budget_busy",
    });
    await settleSpend(id, undefined, undefined, true);
    await setBudget(userId, "anthropic", null);
    expect((await view()).limit).toBeNull();
  });
  it("preserves a conservative maximum estimate after cancellation and never double settles", async () => {
    await setBudget(userId, "anthropic", 1);
    const id = await reserveSpend(userId, "anthropic", input, {
      source: "chat",
    });
    await Promise.all([settleSpend(id), settleSpend(id)]);
    expect(await view()).toMatchObject({ spent: 0.008778, reserved: 0 });
    expect(await db.spendEntry.findUnique({ where: { id } })).toMatchObject({
      estimated: true,
      status: "settled",
      chargedMicros: 8778n,
    });
  });
  it("releases the hold for known rejected credentials without resetting recorded spending", async () => {
    await setBudget(userId, "anthropic", 1);
    vi.mocked(anthropic.send).mockRejectedValueOnce(
      new AppError("invalid_key", "Invalid key", 401),
    );
    await expect(
      meteredSend(userId, "anthropic", input, { source: "connection" }),
    ).rejects.toMatchObject({ code: "invalid_key" });
    expect(await view()).toMatchObject({ spent: 0, reserved: 0 });
    await meteredSend(userId, "anthropic", input, { source: "chat" });
    await setBudget(userId, "anthropic", null);
    await setBudget(userId, "anthropic", 1);
    expect((await view()).spent).toBe(0.00075);
  });
  it("recovers abandoned holds conservatively across restart", async () => {
    await setBudget(userId, "anthropic", 1);
    const id = await reserveSpend(userId, "anthropic", input, {
      source: "orchestrator",
    });
    await recoverSpending();
    expect(await view()).toMatchObject({ reserved: 0, spent: 0.008778 });
    expect(
      (await db.spendEntry.findUniqueOrThrow({ where: { id } })).estimated,
    ).toBe(true);
    await recoverSpending();
    expect((await view()).spent).toBe(0.008778);
  });
  it("makes unpriced historical usage explicit and requires a nondecreasing reconciliation", async () => {
    await meteredSend(
      userId,
      "anthropic",
      { ...input, model: "claude-unknown-model" },
      { source: "chat" },
    );
    expect((await view()).unknownCalls).toBe(1);
    await setBudget(userId, "anthropic", 1);
    await expect(
      meteredSend(userId, "anthropic", input, { source: "chat" }),
    ).rejects.toMatchObject({ code: "budget_unknown" });
    await setBudget(userId, "anthropic", 1, 0.8);
    expect(await view()).toMatchObject({
      spent: 0.8,
      unknownCalls: 0,
      warning: true,
      blocked: false,
    });
    await expect(setBudget(userId, "anthropic", 1, 0.5)).rejects.toMatchObject({
      code: "opening_balance",
    });
    expect(
      await db.auditEntry.count({
        where: { userId, action: "budget.reconciled" },
      }),
    ).toBe(1);
    expect(
      (
        await db.spendEntry.findFirstOrThrow({
          where: { userId, model: "claude-unknown-model" },
        })
      ).status,
    ).toBe("reconciled");
  });
  it("uses new UTC monthly balances without deleting previous month history", async () => {
    expect(periodNow(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
    await setBudget(userId, "anthropic", 1);
    await db.budgetMonth.create({
      data: {
        userId,
        provider: "anthropic",
        period: "2020-01",
        spentMicros: 1000000n,
      },
    });
    await meteredSend(userId, "anthropic", input, { source: "chat" });
    expect((await view()).spent).toBe(0.00075);
    expect(await db.budgetMonth.count({ where: { userId } })).toBe(2);
  });
  it("settles streaming final usage and conservatively charges interrupted streams", async () => {
    await setBudget(userId, "anthropic", 1);
    vi.spyOn(anthropic, "stream").mockImplementation(async function* () {
      yield { type: "delta", text: "Partial" };
      yield {
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 30, complete: true },
      };
    });
    for await (const _ of meteredStream(userId, "anthropic", input, {
      source: "chat",
    })) {
      /* drain */
    }
    expect((await view()).spent).toBe(0.00075);
    vi.mocked(anthropic.stream).mockImplementation(async function* () {
      yield { type: "delta", text: "Partial" };
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(async () => {
      for await (const _ of meteredStream(userId, "anthropic", input, {
        source: "chat",
      })) {
        /* drain */
      }
    }).rejects.toThrow("Aborted");
    expect(await view()).toMatchObject({ spent: 0.009528, reserved: 0 });
  });
  it("rechecks policy after token preflight to close a concurrent limit change", async () => {
    await setBudget(userId, "anthropic", 1);
    vi.mocked(anthropic.countTokens!).mockImplementationOnce(async () => {
      await setBudget(userId, "anthropic", 0);
      return 100;
    });
    await expect(
      meteredSend(userId, "anthropic", input, { source: "chat" }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(anthropic.send).not.toHaveBeenCalled();
    expect((await view()).reserved).toBe(0);
  });
});
