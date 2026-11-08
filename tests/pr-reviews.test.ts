import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { db } from "../src/lib/server/db";
import { encryptKey } from "../src/lib/server/crypto";
import { commandRunner } from "../src/lib/server/github-merge-check";
import { meteredSend } from "../src/lib/server/budgets";
import { startChat } from "../src/lib/server/chat";
import {
  reviewQueue,
  scanProjectReviews,
  setProjectReviews,
} from "../src/lib/server/pr-reviews";

vi.mock("../src/lib/server/github-merge-check", async (original) => ({
  ...(await original<typeof import("../src/lib/server/github-merge-check")>()),
  commandRunner: vi.fn(),
}));
vi.mock("../src/lib/server/budgets", () => ({ meteredSend: vi.fn() }));
vi.mock("../src/lib/server/chat", () => ({ startChat: vi.fn() }));

it("queues a grounded production finding once, ignores test fixtures, and hands it off", async () => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const migration of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort()) {
    sqlite.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  }
  sqlite.close();
  const user = await db.user.create({
    data: { email: "reviewer@example.test" },
  });
  const project = await db.project.create({
    data: { userId: user.id, name: "Foundry", folder: "C:\\foundry" },
  });
  const coordinator = await db.agent.create({
    data: {
      userId: user.id,
      projectId: project.id,
      name: "Orchestrator",
      model: "claude-sonnet-4-6",
      systemPrompt: "",
      kind: "orchestrator",
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  await db.credential.create({
    data: {
      userId: user.id,
      provider: "anthropic",
      last4: "test",
      encrypted: encryptKey("fixture-key", user.id, "anthropic"),
    },
  });
  const head = "a".repeat(40);
  let merged = false;
  const diff = [
    "diff --git a/src/save.ts b/src/save.ts",
    "--- a/src/save.ts",
    "+++ b/src/save.ts",
    "@@ -17,1 +17,1 @@",
    "-return save.level ?? 1;",
    "+return save.level + 1;",
    "diff --git a/tests/save.test.ts b/tests/save.test.ts",
    "--- a/tests/save.test.ts",
    "+++ b/tests/save.test.ts",
    "@@ -1,1 +1,1 @@",
    "-const fake = 1;",
    "+const fake = 99;",
  ].join("\n");
  vi.mocked(commandRunner).mockImplementation(
    async (_folder, command, args) => ({
      code: 0,
      stdout:
        command === "git"
          ? "https://github.com/example/foundry.git"
          : args.includes("diff")
            ? diff
            : args.includes("list")
              ? JSON.stringify([
                  { number: 19, headRefOid: head, isDraft: false },
                ])
              : JSON.stringify({
                  number: 19,
                  headRefOid: head,
                  isDraft: false,
                  state: merged ? "MERGED" : "OPEN",
                }),
    }),
  );
  const production = {
    file: "src/save.ts",
    line: 17,
    title: "Missing level becomes NaN",
    evidence: "save.level + 1",
    impact: "An old save has no level and loads as NaN.",
    fix: "Default the missing value before incrementing.",
  };
  vi.mocked(meteredSend).mockResolvedValue({
    text: JSON.stringify({
      findings: [
        production,
        { ...production, line: 999 },
        {
          ...production,
          file: "tests/save.test.ts",
          line: 1,
          evidence: "fake = 99",
        },
      ],
    }),
    usage: { inputTokens: 200, outputTokens: 100, complete: true },
  });
  vi.mocked(startChat).mockImplementation(async (_userId, _agentId, input) => {
    await db.run.create({
      data: {
        userId: user.id,
        conversationId: coordinator.conversation!.id,
        clientId: input.clientId,
        assistantId: "review-fixture",
        model: coordinator.model,
        status: "complete",
      },
    });
    return Response.json({ ok: true });
  });
  await setProjectReviews(user.id, project.id, true);
  await scanProjectReviews(user.id, project.id, true);
  await scanProjectReviews(user.id, project.id, true);
  const queue = await reviewQueue(user.id, project.id);
  expect(queue.reviews).toHaveLength(1);
  expect(queue.reviews[0]).toMatchObject({
    number: 19,
    head,
    status: "complete",
    handedOff: true,
    findings: [production],
  });
  expect(meteredSend).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(meteredSend).mock.calls[0][2].messages[0].content,
  ).not.toContain("fake = 99");
  expect(startChat).toHaveBeenCalledTimes(1);
  expect(vi.mocked(startChat).mock.calls[0][2].text).toContain(
    "https://github.com/example/foundry/pull/19",
  );
  merged = true;
  await expect(
    scanProjectReviews(user.id, project.id, true, {
      number: 19,
      head: "b".repeat(40),
    }),
  ).rejects.toThrow("exact head");
  await scanProjectReviews(user.id, project.id, true, { number: 19, head });
  expect((await reviewQueue(user.id, project.id)).reviews).toEqual(
    queue.reviews,
  );
});
