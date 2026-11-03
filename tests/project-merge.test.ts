import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "../src/lib/server/db";
import { defaultAgent } from "../src/lib/server/store";
import {
  processProjectMerges,
  requestProjectMerge,
} from "../src/lib/server/project-merge";
import {
  commandRunner,
  inspectGitHubMerge,
} from "../src/lib/server/github-merge-check";

vi.mock("../src/lib/server/github-merge-check", () => ({
  commandRunner: vi.fn(),
  inspectGitHubMerge: vi.fn(),
}));
let userId: string, projectId: string, workerId: string, runId: string;
beforeAll(() => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const migration of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  sqlite.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  userId = (
    await db.user.create({ data: { email: `${randomUUID()}@merge.test` } })
  ).id;
  projectId = (
    await db.project.create({
      data: { userId, name: "Feature", folder: "C:\\repo" },
    })
  ).id;
  const lead = await db.agent.create({
    data: {
      ...defaultAgent,
      userId,
      projectId,
      kind: "orchestrator",
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  workerId = (
    await db.agent.create({
      data: {
        ...defaultAgent,
        userId,
        projectId,
        engine: "claude-code",
        projectPath: "C:\\repo",
        conversation: { create: {} },
      },
    })
  ).id;
  runId = (
    await db.run.create({
      data: {
        userId,
        conversationId: lead.conversation!.id,
        clientId: randomUUID(),
        assistantId: randomUUID(),
        model: "sonnet",
        status: "complete",
      },
    })
  ).id;
});
afterAll(() => db.$disconnect());

it("refuses a merge while work is active or no completed worker report exists", async () => {
  const call = {
    id: randomUUID(),
    name: "finish_project",
    arguments: { title: "Feature", summary: "Implement feature" },
  };
  await expect(
    requestProjectMerge(userId, projectId, runId, call),
  ).rejects.toMatchObject({ code: "report_required" });
  await db.terminalDispatch.create({
    data: {
      userId,
      agentId: workerId,
      proposalId: randomUUID(),
      text: "Working",
      status: "delivered",
    },
  });
  await expect(
    requestProjectMerge(userId, projectId, runId, call),
  ).rejects.toMatchObject({ code: "project_busy" });
  expect(await db.mergeJob.count({ where: { userId } })).toBe(0);
});

it("merges only after verification returns ready and confirms the same commit", async () => {
  const head = "a".repeat(40);
  const job = await db.mergeJob.create({
    data: {
      userId,
      projectId,
      runId,
      toolCallId: randomUUID(),
      title: "Feature",
      summary: "Implementation",
    },
  });
  vi.mocked(inspectGitHubMerge).mockResolvedValueOnce({
    state: "waiting_checks",
    expectedHead: head,
    prNumber: 7,
    prUrl: "https://github.com/example/repo/pull/7",
    repo: "example/repo",
    checksPassedAt: null,
    checksHash: null,
  });
  await processProjectMerges(userId);
  expect(
    (await db.mergeJob.findUniqueOrThrow({ where: { id: job.id } })).status,
  ).toBe("waiting_checks");
  expect(commandRunner).not.toHaveBeenCalled();
  await db.mergeJob.update({
    where: { id: job.id },
    data: { nextCheckAt: null },
  });
  vi.mocked(inspectGitHubMerge).mockResolvedValueOnce({
    state: "ready",
    expectedHead: head,
    prNumber: 7,
    prUrl: "https://github.com/example/repo/pull/7",
    repo: "example/repo",
    strategy: "--merge",
  });
  vi.mocked(commandRunner)
    .mockResolvedValueOnce({ code: 0, stdout: "" })
    .mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({ state: "MERGED", headRefOid: head }),
    });
  await processProjectMerges(userId);
  expect(
    (await db.mergeJob.findUniqueOrThrow({ where: { id: job.id } })).status,
  ).toBe("merged");
  expect(vi.mocked(commandRunner).mock.calls[0][2]).toContain(
    "--match-head-commit",
  );
  expect(vi.mocked(commandRunner).mock.calls[0][2]).not.toContain("--admin");
});
