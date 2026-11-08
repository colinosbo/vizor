import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "../src/lib/server/db";
import { defaultAgent } from "../src/lib/server/store";
import {
  actOnSharedDecision,
  connectSharedProject,
  deliverReviewToSharedProject,
  setSharedEnabled,
  sharedTool,
  sharedView,
  watchSharedProjects,
} from "../src/lib/server/shared-projects";
import {
  claimTerminalDispatch,
  completeTerminalDispatch,
} from "../src/lib/server/terminal-dispatches";
import {
  collectTerminalReports,
  reportPath,
} from "../src/lib/server/terminal-reports";
import { startChat } from "../src/lib/server/chat";
import { runClaude } from "../src/lib/server/subscription";
import { runHeadlessWorker } from "../src/lib/server/headless-worker";

vi.mock("../src/lib/server/chat", () => ({ startChat: vi.fn() }));
vi.mock("../src/lib/server/subscription", () => ({ runClaude: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), "vizor-shared-test-"));
const ownerKey = randomBytes(32).toString("hex");
const workerKey = randomBytes(32).toString("hex");
const dashboardPassword = randomBytes(24).toString("hex");
const dashboardOrigin = "http://127.0.0.1:4387";
const dashboardAuth =
  "Basic " + Buffer.from(`owner:${dashboardPassword}`).toString("base64");
let relay: ChildProcess | undefined;
let url: string;

async function startRelay(port = 0) {
  relay = spawn(process.execPath, ["scripts/shared-relay.mjs"], {
    windowsHide: true,
    env: {
      ...process.env,
      VIZOR_SHARED_OWNER_KEY: ownerKey,
      VIZOR_SHARED_WORKER_KEY: workerKey,
      VIZOR_SHARED_DB: join(root, "relay.db"),
      VIZOR_SHARED_PORT: String(port),
      VIZOR_DASHBOARD_PASSWORD: dashboardPassword,
      VIZOR_DASHBOARD_ORIGIN: dashboardOrigin,
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Relay startup timed out.")),
      5000,
    );
    relay!.once("error", reject);
    relay!.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Relay exited before listening."));
    });
    relay!.stdout!.on("data", (chunk) => {
      const match = /listening on port (\d+)/.exec(String(chunk));
      if (!match) return;
      clearTimeout(timer);
      url = `http://127.0.0.1:${match[1]}`;
      resolve();
    });
  });
}

async function stopRelay() {
  if (!relay || relay.exitCode !== null || relay.signalCode) return;
  const stopped = once(relay, "exit");
  relay.kill();
  await stopped;
}

beforeAll(async () => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const name of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"),
    );
  sqlite.close();
  await startRelay();
});

afterAll(async () => {
  await stopRelay();
  await db.$disconnect();
  rmSync(root, { recursive: true, force: true });
});

it("runs a shared task, clarifies it, and returns one report per turn", async () => {
  const sourceFile = "save.ts";
  writeFileSync(join(root, sourceFile), "export const fallback = 0;\r\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "--", sourceFile]);
  vi.stubEnv("SELF_HOST", "true");
  vi.stubEnv("VIZOR_TERMINALS", "1");
  const watching = new Set<string>();
  const watch = async (userId: string) => {
    watching.add(userId);
    watchSharedProjects(
      userId,
      await db.sharedConnection.findMany({ where: { project: { userId } } }),
    );
  };
  try {
    const [owner, worker, secondWorker] = await Promise.all(
      ["owner", "worker", "another-worker"].map((name) =>
        db.user.create({
          data: {
            email: `${name}@shared.test`,
            autoApprove: false,
            queueEnabled: false,
          },
        }),
      ),
    );
    const [leadProject, workerProject, otherProject] = await Promise.all(
      [owner, worker, secondWorker].map((user) =>
        db.project.create({
          data: { name: "Shared test", folder: root, userId: user.id },
        }),
      ),
    );
    const [localWorker, otherWorker] = await Promise.all(
      [workerProject, otherProject].map((project) =>
        db.agent.create({
          data: {
            ...defaultAgent,
            name: "Remote coder",
            engine: "claude-code",
            userId: project.userId,
            projectId: project.id,
            projectPath: root,
            conversation: { create: {} },
          },
        }),
      ),
    );
    await db.agent.create({
      data: {
        ...defaultAgent,
        kind: "orchestrator",
        userId: owner.id,
        projectId: leadProject.id,
        conversation: { create: {} },
      },
    });
    await expect(
      connectSharedProject(worker.id, leadProject.id, { url, key: workerKey }),
    ).rejects.toThrow("project was not found");
    await connectSharedProject(owner.id, leadProject.id, {
      url,
      key: ownerKey,
    });
    await connectSharedProject(worker.id, workerProject.id, {
      url,
      key: workerKey,
      workerId: localWorker.id,
    });
    await connectSharedProject(secondWorker.id, otherProject.id, {
      url,
      key: workerKey,
      workerId: otherWorker.id,
    });
    await expect(
      actOnSharedDecision(worker.id, workerProject.id, {
        id: randomUUID(),
        action: { kind: "approve", text: "Unauthorized", paths: [] },
      }),
    ).rejects.toThrow("owner");
    await watch(worker.id);
    expect(await db.terminalDispatch.count()).toBe(0);
    const approval = await fetch(url + "/dashboard/project", {
      method: "POST",
      headers: {
        Authorization: dashboardAuth,
        Origin: dashboardOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: randomUUID(),
        action: {
          kind: "approve",
          text: "Fix production save defaults and report evidence.",
          paths: [sourceFile],
          waitForReview: true,
        },
      }),
    });
    expect(approval.status).toBe(200);

    let turns = 0;
    vi.mocked(startChat).mockImplementation(async (userId, _agentId, input) => {
      turns++;
      const state = (await sharedView(owner.id, leadProject.id))!.state!;
      const run = { id: randomUUID(), clientId: input.clientId };
      if (turns === 1) {
        await expect(
          sharedTool(userId, leadProject.id, run, {
            id: "write",
            name: "shared_assign",
            arguments: { text: "Modify a save", paths: ["src/save.ts"] },
          }),
        ).rejects.toThrow("approved plan");
        await sharedTool(userId, leadProject.id, run, {
          id: "assign",
          name: "shared_assign",
          arguments: { text: "Fix the save default.", paths: [sourceFile] },
        });
      } else if (turns === 2) {
        await sharedTool(userId, leadProject.id, run, {
          id: "reply",
          name: "shared_reply",
          arguments: {
            turnId: state.turn!.id,
            text: "Yes, include old saves.",
          },
        });
      } else if (turns === 3) {
        await sharedTool(userId, leadProject.id, run, {
          id: "decision",
          name: "shared_decision",
          arguments: {
            text: "Accept the observed Tier I default as the project outcome?",
          },
        });
      } else {
        await sharedTool(userId, leadProject.id, run, {
          id: "complete",
          name: "shared_complete",
          arguments: { text: "Old saves load with the expected default." },
        });
      }
      return Response.json({ ok: true });
    });

    await watch(owner.id);
    const ownerConnection = await db.sharedConnection.findUniqueOrThrow({
      where: { projectId: leadProject.id },
    });
    expect(
      await deliverReviewToSharedProject(
        owner.id,
        ownerConnection,
        randomUUID(),
        "A production PR found a wrong save default.",
        [sourceFile],
      ),
    ).toBe(true);
    await expect
      .poll(
        async () =>
          (await sharedView(owner.id, leadProject.id))?.state?.task?.id,
      )
      .toBeTruthy();
    const taskId = (await sharedView(owner.id, leadProject.id))!.state!.task!
      .id;
    const port = Number(new URL(url).port);
    await stopRelay();
    await startRelay(port);
    expect((await sharedView(owner.id, leadProject.id))!.state!.task!.id).toBe(
      taskId,
    );
    await expect.poll(() => db.terminalDispatch.count()).toBe(1);
    await watch(secondWorker.id);
    const first = await db.terminalDispatch.findFirstOrThrow({
      where: { userId: worker.id },
    });
    await setSharedEnabled(worker.id, workerProject.id, false);
    await expect(
      claimTerminalDispatch(worker.id, first.proposalId),
    ).rejects.toThrow("paused");
    await setSharedEnabled(worker.id, workerProject.id, true);

    async function report(
      dispatchId: string,
      proposalId: string,
      questions: object[],
    ) {
      await claimTerminalDispatch(worker.id, proposalId);
      vi.mocked(runClaude).mockImplementation(async (args, input) => {
        if (args[0] === "auth")
          return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
        expect(JSON.parse(input).source).toContain("fallback = 0;");
        if (!questions.length)
          expect(JSON.parse(input).assignment).toContain(
            "Yes, include old saves.",
          );
        return JSON.stringify({
          structured_output: {
            summary: questions.length
              ? "One question remains."
              : "Old saves load at Tier I.",
            outcome: questions.length ? "blocked" : "completed",
            checks: [],
            artifacts: [],
            questions,
            edit: questions.length
              ? null
              : {
                  file: sourceFile,
                  find: "fallback = 0",
                  replace: "fallback = 1",
                },
          },
        });
      });
      const dispatch = await db.terminalDispatch.findUniqueOrThrow({
        where: { id: dispatchId },
      });
      const result = await runHeadlessWorker(
        root,
        "sonnet",
        dispatch.text,
        JSON.parse(dispatch.writePaths),
      );
      writeFileSync(
        await reportPath(root, dispatchId),
        JSON.stringify({ dispatchId, ...result }),
      );
      await completeTerminalDispatch(worker.id, proposalId);
      await collectTerminalReports(worker.id);
    }

    await report(first.id, first.proposalId, [
      { id: "q1", question: "Check old saves too?", options: [] },
    ]);
    await expect
      .poll(() => db.terminalDispatch.count({ where: { userId: worker.id } }))
      .toBe(2);
    const followup = await db.terminalDispatch.findFirstOrThrow({
      where: { userId: worker.id, id: { not: first.id } },
    });
    expect(followup.text).toContain("Yes, include old saves.");
    expect(followup.sharedTaskId).toBe(taskId);
    watchSharedProjects(owner.id, []);
    await report(followup.id, followup.proposalId, []);
    expect(readFileSync(join(root, sourceFile), "utf8")).toBe(
      "export const fallback = 1;\r\n",
    );
    expect(turns).toBe(2);
    await watch(owner.id);
    await expect
      .poll(
        async () =>
          (await sharedView(owner.id, leadProject.id))?.state?.decision?.id,
      )
      .toBeTruthy();
    const decision = (await sharedView(owner.id, leadProject.id))!.state!
      .decision!;
    expect(decision.text).toContain("Tier I default");
    expect(turns).toBe(3);
    await actOnSharedDecision(owner.id, leadProject.id, {
      id: randomUUID(),
      action: {
        kind: "answer",
        decisionId: decision.id,
        text: "Accept the verified default.",
      },
    });
    await expect
      .poll(
        async () =>
          (await sharedView(owner.id, leadProject.id))?.state?.completed,
      )
      .toBe(true);
    const final = (await sharedView(owner.id, leadProject.id))!.state!;
    expect(final.completed).toBe(true);
    expect(
      final.events.filter(
        (event) => event.taskId === taskId && event.kind === "report",
      ),
    ).toHaveLength(2);
    expect(await db.proposal.count({ where: { status: "pending" } })).toBe(0);
    expect(turns).toBe(4);
    watchSharedProjects(owner.id, []);
    const reviewId = randomUUID();
    const files = ["src/save.ts"];
    const reviewBrief = "PR #129 needs the missing save default restored.";
    expect(
      await deliverReviewToSharedProject(
        owner.id,
        ownerConnection,
        reviewId,
        reviewBrief,
        files,
      ),
    ).toBe(true);
    expect(
      await deliverReviewToSharedProject(
        owner.id,
        ownerConnection,
        reviewId,
        reviewBrief,
        files,
      ),
    ).toBe(true);
    expect(
      (await sharedView(owner.id, leadProject.id))?.state?.draft,
    ).toMatchObject({
      text: reviewBrief,
      paths: files,
    });
    expect(turns).toBe(4);
    const endpoint = url + "/dashboard/project";
    const draft = (await sharedView(owner.id, leadProject.id))!.state!.draft!;
    const approve = (origin: string, draftId: string) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: dashboardAuth,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: randomUUID(),
          action: { kind: "approve", draftId, text: reviewBrief, paths: files },
        }),
      });
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { Authorization: dashboardAuth } })).status,
    ).toBe(200);
    expect(
      (
        await fetch(endpoint, {
          headers: { Authorization: `Bearer ${workerKey}` },
        })
      ).status,
    ).toBe(401);
    expect((await approve("https://elsewhere.example", draft.id)).status).toBe(
      403,
    );
    expect((await approve(dashboardOrigin, randomUUID())).status).toBe(409);
    expect((await approve(dashboardOrigin, draft.id)).status).toBe(200);
    const finding = {
      repository: "crayosog-star/BlackforgeMC",
      number: 129,
      head: "a".repeat(40),
      title: "Missing default",
      impact: "Old saves load the wrong default.",
      fix: "Restore the default.",
      file: "src/save.ts",
      line: 42,
    };
    const publish = (key: string) =>
      fetch(url + "/v1/findings", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([finding]),
      });
    expect((await publish(workerKey)).ok).toBe(false);
    expect((await publish(ownerKey)).ok).toBe(true);
    const repoItem = {
      number: 129,
      title: "Review fixture",
      updatedAt: new Date().toISOString(),
      labels: ["bug"],
    };
    const repository = {
      repository: "crayosog-star/BlackforgeMC",
      issues: [],
      pulls: [repoItem],
      merged: [],
    };
    const publishRepository = (key: string, snapshot: object) =>
      fetch(url + "/v1/repository", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(snapshot),
      });
    expect((await publishRepository(workerKey, repository)).ok).toBe(false);
    expect(
      (
        await publishRepository(ownerKey, {
          ...repository,
          repository: "another/repository",
        })
      ).status,
    ).toBe(400);
    expect((await publishRepository(ownerKey, repository)).ok).toBe(true);
    const dashboardState = () =>
      fetch(url + "/dashboard/project", {
        headers: { Authorization: dashboardAuth },
      }).then((response) => response.json());
    await expect.poll(dashboardState).toMatchObject({
      repository,
      findings: [finding],
      connectedRoles: ["worker"],
    });
    await stopRelay();
    await startRelay(port);
    expect(await dashboardState()).toMatchObject({
      repository,
      findings: [finding],
    });
    expect(
      await deliverReviewToSharedProject(
        owner.id,
        ownerConnection,
        randomUUID(),
        "A second production finding.",
        files,
      ),
    ).toBe(true);
    await watch(owner.id);
    await expect
      .poll(
        async () =>
          (await sharedView(owner.id, leadProject.id))?.state?.completed,
      )
      .toBe(true);
    expect(vi.mocked(startChat).mock.calls.at(-1)?.[2].text).toContain(
      "A second production finding.",
    );
    expect(
      await deliverReviewToSharedProject(
        owner.id,
        ownerConnection,
        randomUUID(),
        "An in-scope follow-up.",
        files,
      ),
    ).toBe(true);
    await expect
      .poll(() => vi.mocked(startChat).mock.calls.at(-1)?.[2].text)
      .toContain("An in-scope follow-up.");
  } finally {
    for (const userId of watching) watchSharedProjects(userId, []);
    vi.unstubAllEnvs();
  }
});

it("dispatches two named workers through the manager tools with no browser session", async () => {
  vi.stubEnv("SELF_HOST", "true");
  vi.stubEnv("VIZOR_TERMINALS", "1");
  const register = async (name: string, preset: string) => {
    const result = await fetch(url + "/dashboard/agents", {
      method: "POST",
      headers: {
        Authorization: dashboardAuth,
        Origin: dashboardOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, participant: name.split(" ")[0], preset }),
    });
    expect(result.status).toBe(201);
    return result.json();
  };
  const manager = await register("Gavin Manager", "orchestrator");
  const first = await register("Stephen One", "developer");
  const second = await register("Stephen Two", "developer");
  expect(
    (
      await fetch(url + "/dashboard/manager", {
        method: "POST",
        headers: {
          Authorization: dashboardAuth,
          Origin: dashboardOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agentId: manager.agent.id }),
      })
    ).status,
  ).toBe(200);
  const profiles = [manager, first, second];
  const createdProject = await fetch(url + "/dashboard/projects", {
    method: "POST",
    headers: {
      Authorization: dashboardAuth,
      Origin: dashboardOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Named project",
      goal: "Inspect two independent contexts.",
      document: {
        name: "Project specification.md",
        content:
          "Inspect Stephen and Gavin contexts independently. Record the inspected context and missing evidence for each. Do not alter testing-only fixtures.",
      },
      repository: "crayosog-star/BlackforgeMC",
      paths: [],
      managerId: manager.agent.id,
      agentIds: profiles.map((profile) => profile.agent.id),
    }),
  });
  expect(createdProject.status).toBe(201);
  const remoteProjectId = (await createdProject.json()).project.id;
  const users = await Promise.all(
    profiles.map((_, index) =>
      db.user.create({
        data: {
          email: `named-${index}@shared.test`,
          autoApprove: false,
          queueEnabled: false,
        },
      }),
    ),
  );
  const projects = await Promise.all(
    users.map((user) =>
      db.project.create({
        data: { name: "Named agents", folder: root, userId: user.id },
      }),
    ),
  );
  const agents = await Promise.all(
    users.map((user, index) =>
      db.agent.create({
        data: {
          ...defaultAgent,
          userId: user.id,
          projectId: projects[index].id,
          name: profiles[index].agent.name,
          kind: index === 0 ? "orchestrator" : "agent",
          engine: index === 0 ? "api" : "claude-code",
          projectPath: root,
          conversation: { create: {} },
        },
      }),
    ),
  );
  const watching = async (index: number, enabled = true) =>
    watchSharedProjects(
      users[index].id,
      enabled
        ? await db.sharedConnection.findMany({
            where: { projectId: projects[index].id },
          })
        : [],
    );
  try {
    for (let index = 0; index < 3; index++) {
      await connectSharedProject(users[index].id, projects[index].id, {
        url,
        key: profiles[index].key,
        remoteProjectId,
        ...(index ? { workerId: agents[index].id } : {}),
      });
      if (index) await watching(index);
    }
    let turns = 0;
    vi.mocked(startChat).mockImplementation(async (userId, _agentId, input) => {
      turns++;
      const run = { id: randomUUID(), clientId: input.clientId };
      if (turns === 1) {
        expect(input.text).toContain("Project specification.md");
        expect(input.text).toContain(
          "Inspect Stephen and Gavin contexts independently",
        );
        expect(input.text).toContain(
          "Assign ready tasks to idle registered agents",
        );
        for (const profile of [first, second])
          await sharedTool(userId, projects[0].id, run, {
            id: profile.agent.id,
            name: "shared_create_task",
            arguments: {
              title: `Inspect ${profile.agent.name}`,
              description: `Inspect assigned context for ${profile.agent.name}.`,
              acceptance:
                "Report the inspected context and any missing evidence.",
              paths: [],
              dependencies: [],
              references: [],
            },
          });
      } else if (turns === 2) {
        const state = (await sharedView(userId, projects[0].id))!.state!;
        const tasks = state.queue.filter((task) => !task.implicit);
        expect(tasks).toHaveLength(2);
        for (const [index, task] of tasks.entries())
          await sharedTool(userId, projects[0].id, run, {
            id: task.id,
            name: "shared_assign_task",
            arguments: {
              taskId: task.id,
              agentId: profiles[index + 1].agent.id,
            },
          });
      } else if (turns === 3) {
        const state = (await sharedView(userId, projects[0].id))!.state!;
        for (const task of state.queue.filter((task) => !task.implicit))
          await sharedTool(userId, projects[0].id, run, {
            id: task.id,
            name: "shared_accept_task",
            arguments: {
              taskId: task.id,
              text: "The report meets the saved acceptance criteria.",
            },
          });
      } else {
        await sharedTool(userId, projects[0].id, run, {
          id: "done",
          name: "shared_complete",
          arguments: { text: "Both workers reported their results." },
        });
      }
      return Response.json({ ok: true });
    });
    await watching(0);
    await expect
      .poll(
        async () =>
          (await sharedView(users[0].id, projects[0].id))?.state?.tasks.length,
        { timeout: 5000 },
      )
      .toBe(2);
    await expect
      .poll(() =>
        db.terminalDispatch.count({
          where: { userId: { in: users.slice(1).map((user) => user.id) } },
        }),
      )
      .toBe(2);
    await watching(0, false);
    for (const index of [1, 2]) {
      const task = await db.terminalDispatch.findFirstOrThrow({
        where: { userId: users[index].id },
      });
      expect(task.text).toContain(profiles[index].agent.name);
      await claimTerminalDispatch(users[index].id, task.proposalId);
      writeFileSync(
        await reportPath(root, task.id, true),
        JSON.stringify({
          dispatchId: task.id,
          outcome: "completed",
          summary: "Inspected assigned context.",
          checks: [],
          artifacts: [],
          questions: [],
        }),
      );
      await completeTerminalDispatch(users[index].id, task.proposalId);
      await collectTerminalReports(users[index].id);
    }
    await watching(0);
    await expect
      .poll(
        async () =>
          (await sharedView(users[0].id, projects[0].id))?.state?.completed,
      )
      .toBe(true);
    expect(turns).toBe(4);
  } finally {
    for (const user of users) watchSharedProjects(user.id, []);
    vi.unstubAllEnvs();
  }
});
