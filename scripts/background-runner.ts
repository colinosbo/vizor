import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { migrate } from "./portable-migrate.mjs";
import { presetInstructions } from "./agent-presets.mjs";
import { z } from "zod";
import { projectIdSchema } from "./project-store.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const identity = process.env.VIZOR_RUNNER_AGENT_ID;
const remoteProjectId = process.env.VIZOR_RUNNER_PROJECT_ID ?? "default";
const githubEnabled = process.env.VIZOR_RUNNER_GITHUB !== "false";
if (!projectIdSchema.safeParse(remoteProjectId).success)
  throw Error("Use the project ID from the dashboard.");
if (identity && !z.uuid().safeParse(identity).success)
  throw Error("Use the registered agent ID from the dashboard.");
let role = process.env.VIZOR_RUNNER_ROLE;
if (identity && !role) role = "worker";
if (role !== "owner" && role !== "worker")
  throw Error("Set VIZOR_RUNNER_ROLE to owner or worker.");
const base = process.env.LOCALAPPDATA ?? process.env.HOME;
if (!base && !process.env.VIZOR_RUNNER_DIR)
  throw Error("Set a private VIZOR_RUNNER_DIR.");
const home = resolve(
  process.env.VIZOR_RUNNER_DIR ??
    join(
      base!,
      `VizorRunner-${identity ?? role}${remoteProjectId === "default" ? "" : "-" + remoteProjectId}`,
    ),
);
mkdirSync(home, { recursive: true, mode: 0o700 });
const identityPath = join(home, "runner-identity");
const expectedIdentity =
  (identity ?? `legacy:${role}`) +
  (remoteProjectId === "default" ? "" : ":" + remoteProjectId);
try {
  writeFileSync(identityPath, expectedIdentity, { flag: "wx", mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  if (readFileSync(identityPath, "utf8") !== expectedIdentity)
    throw Error(
      "This local runner directory belongs to another agent. Use a separate VIZOR_RUNNER_DIR.",
    );
}
const native = resolve(root, "desktop", "terminal-host");
const claudeHome = resolve(process.env.VIZOR_RUNNER_CLAUDE_HOME ?? home);
const require = createRequire(import.meta.url);
if (process.argv.includes("--login")) {
  const { runtime } = require(join(native, "claude-runtime.cjs"));
  const claude = runtime(claudeHome);
  if (!claude.binary) throw Error("Install Claude Code before signing in.");
  mkdirSync(claude.cwd, { recursive: true, mode: 0o700 });
  process.exitCode =
    spawnSync(claude.binary, ["auth", "login", "--claudeai"], {
      cwd: claude.cwd,
      env: claude.env,
      stdio: "inherit",
    }).status ?? 1;
} else {
  const database = join(home, "runner.db");
  const lock = join(home, "runner.lock");
  function takeLock(path = lock) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw Error(
          "Invalid runner lock. Check whether another runner is active.",
        );
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        rmSync(path);
        writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
        return;
      }
      throw Error(
        "Another runner is already using this state directory or checkout. Use a dedicated checkout for each instance.",
      );
    }
  }
  takeLock();
  let checkoutLock: string | undefined;
  try {
    const master = join(home, "master.key");
    try {
      writeFileSync(master, randomBytes(32).toString("base64"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    process.env.DATABASE_URL = "file:" + database;
    process.env.MASTER_KEY = readFileSync(master, "utf8").trim();
    process.env.SELF_HOST = "true";
    process.env.VIZOR_TERMINALS = "1";
    process.env.VIZOR_NATIVE_HOST = native;
    process.env.VIZOR_NATIVE_HOME = claudeHome;
    await migrate({
      database,
      migrations: join(root, "prisma", "migrations"),
      Database,
    });
    const config = {
      url: process.env.VIZOR_RUNNER_RELAY ?? "",
      key: process.env.VIZOR_RUNNER_PAIRING_KEY ?? "",
      folder: process.env.VIZOR_RUNNER_REPO ?? "",
      model: process.env.VIZOR_RUNNER_MODEL ?? "sonnet",
    };
    if (
      !config.folder ||
      !/^[a-f0-9]{64}$/.test(config.key) ||
      !["sonnet", "opus", "haiku"].includes(config.model)
    )
      throw Error(
        "Set VIZOR_RUNNER_REPO, VIZOR_RUNNER_PAIRING_KEY, and a supported model.",
      );
    const relayOrigin = new URL(config.url);
    if (
      relayOrigin.origin !== config.url ||
      (relayOrigin.protocol !== "https:" &&
        !(
          relayOrigin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(relayOrigin.hostname)
        ))
    )
      throw Error(
        "Use the relay's exact HTTPS origin, or a loopback HTTP origin for testing.",
      );
    const fetchRelay = (path: string, init: RequestInit = {}) =>
      fetch(config.url + path, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          ...init.headers,
          Authorization: "Bearer " + config.key,
          "X-Vizor-Project": remoteProjectId,
        },
      });
    const handshake = await fetchRelay("/v1/project");
    if (!handshake.ok)
      throw Error("The runner pairing key is invalid or revoked.");
    const pairing = z
      .object({
        role: z.enum(["owner", "worker"]),
        turn: z.object({ kind: z.string() }).nullable().optional(),
        project: z
          .object({ id: z.string(), name: z.string(), repository: z.string() })
          .optional(),
        agent: z
          .object({
            id: z.uuid(),
            name: z.string(),
            preset: z.enum(["orchestrator", "developer", "reviewer"]),
            instructions: z.string(),
          })
          .nullable()
          .optional(),
      })
      .parse(await handshake.json());
    if (
      remoteProjectId !== "default" &&
      pairing.project?.id !== remoteProjectId
    )
      throw Error("The relay did not confirm the selected project.");
    if (identity && pairing.agent?.id !== identity)
      throw Error("The pairing key belongs to a different agent.");
    if (pairing.agent && !identity)
      throw Error(
        "Set VIZOR_RUNNER_AGENT_ID so this agent has its own local state.",
      );
    if (!identity && pairing.role !== role)
      throw Error("The pairing key does not match the runner role.");
    role = pairing.role;
    const profile = pairing.agent;
    const folder = await realpath(config.folder);
    const { commandRunner, repoName } =
      await import("../src/lib/server/github-merge-check");
    const [remote, gitRoot] = await Promise.all([
      commandRunner(folder, "git", ["remote", "get-url", "origin"]),
      commandRunner(folder, "git", ["rev-parse", "--show-toplevel"]),
    ]);
    const repository = remote.code === 0 ? repoName(remote.stdout) : null;
    if (
      !repository ||
      repository.toLowerCase() !==
        (
          pairing.project?.repository ?? "crayosog-star/BlackforgeMC"
        ).toLowerCase() ||
      gitRoot.code !== 0 ||
      (await realpath(gitRoot.stdout.trim())) !== folder
    )
      throw Error(
        "Use a dedicated checkout of the selected project's repository at its root.",
      );
    const gitDirectory = await commandRunner(folder, "git", [
      "rev-parse",
      "--absolute-git-dir",
    ]);
    if (gitDirectory.code !== 0)
      throw Error("Could not locate this checkout's Git directory.");
    const candidateLock = join(
      await realpath(gitDirectory.stdout.trim()),
      "vizor-runner.lock",
    );
    takeLock(candidateLock);
    checkoutLock = candidateLock;
    const { db } = await import("../src/lib/server/db");
    const { runClaude } = await import("../src/lib/server/subscription");
    const { assertRunnerSubscription, runHeadlessWorker } =
      await import("../src/lib/server/headless-worker");
    const { publishWorkerPr } =
      await import("../src/lib/server/worker-delivery");
    const { checkNames } = await import("./worker-handoff.mjs");
    const {
      connectSharedProject,
      watchSharedProjects,
      sendSharedDeliveryFailures,
      sharedId,
    } = await import("../src/lib/server/shared-projects");
    const { scanProjectReviews, reviewQueue } =
      await import("../src/lib/server/pr-reviews");
    const { repositoryOverview } =
      await import("../src/lib/server/repository-overview");
    const replayInput = process.env.VIZOR_RUNNER_REPLAY_PR;
    const replayMatch = /^([1-9]\d{0,8}):([a-f0-9]{40})$/.exec(
      replayInput ?? "",
    );
    if (replayInput && (role !== "owner" || !replayMatch))
      throw Error(
        "Owner replay requires VIZOR_RUNNER_REPLAY_PR in the format PR-number:full-head-SHA.",
      );
    const replay = replayMatch
      ? { number: Number(replayMatch[1]), head: replayMatch[2] }
      : undefined;
    if (role === "owner" && githubEnabled) {
      const gh = await commandRunner(folder, "gh", [
        "auth",
        "status",
        "--hostname",
        "github.com",
      ]);
      if (gh.code !== 0)
        throw Error(
          "Sign in to GitHub CLI as the owner before starting the review runner.",
        );
    }
    const {
      claimTerminalDispatch,
      completeTerminalDispatch,
      releaseTerminalDispatch,
    } = await import("../src/lib/server/terminal-dispatches");
    const { collectTerminalReports, reportPath, reportSchema } =
      await import("../src/lib/server/terminal-reports");
    if (!(role === "worker" && pairing.turn?.kind === "publish_approve"))
      await assertRunnerSubscription();
    if (role === "owner") {
      // Check the manager connection before taking project planning work.
      const probe = JSON.parse(
        await runClaude(
          [
            "--print",
            "--output-format",
            "json",
            "--model",
            config.model,
            "--max-turns",
            "1",
            "--tools",
            "",
            "--safe-mode",
            "--settings",
            '{"forceLoginMethod":"claudeai"}',
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--disable-slash-commands",
            "--no-session-persistence",
          ],
          "Reply with the single word ready.",
        ),
      );
      if (probe.is_error)
        throw Error(
          "Claude subscription inference failed. Run the runner's sign-in again.",
        );
    }
    const user = await db.user.upsert({
      where: { email: "blackforge-runner@vizor.local" },
      create: {
        email: "blackforge-runner@vizor.local",
        autoApprove: false,
        queueEnabled: false,
      },
      update: {},
    });
    let project = await db.project.findFirst({ where: { userId: user.id } });
    if (project && project.folder !== folder)
      throw Error(
        "This runner directory is already bound to a different checkout.",
      );
    project ??= await db.project.create({
      data: {
        userId: user.id,
        name: pairing.project?.name ?? "BlackForge",
        folder,
        reviewEnabled: role === "owner" && githubEnabled,
      },
    });
    const projectId = project.id;
    const kind = role === "owner" ? "orchestrator" : "agent";
    let agent = await db.agent.findFirst({
      where: { userId: user.id, projectId, kind },
    });
    agent ??= await db.agent.create({
      data: {
        userId: user.id,
        projectId,
        kind,
        name:
          profile?.name ??
          (role === "owner" ? "BlackForge Orchestrator" : "BlackForge Worker"),
        model: config.model,
        provider: "anthropic",
        engine: role === "owner" ? "api" : "claude-code",
        orchestratorMode: "subscription",
        projectPath: folder,
        maxTokens: 4096,
        systemPrompt:
          (profile
            ? presetInstructions(profile.preset, profile.instructions) + "\n\n"
            : "") +
          "Project instructions:\nUse this project's headless worker. Assign up to 20 exact approved files per task and choose checks explicitly. Keep fixes local until the human approves the exact PR commit, preserve unrelated edits, skip intentional test-only behavior, and ask the owner only about material decisions. BlackForge build and test checks belong in GitHub CI. No live commands.",
        conversation: { create: {} },
      },
    });
    if (agent.model !== config.model)
      agent = await db.agent.update({
        where: { id: agent.id },
        data: { model: config.model },
      });
    await connectSharedProject(user.id, projectId, {
      url: config.url,
      key: config.key,
      remoteProjectId,
      ...(role === "worker" ? { workerId: agent.id } : {}),
    });
    const connections = await db.sharedConnection.findMany({
      where: { projectId },
    });
    if (!connections[0]?.enabled)
      throw Error("This runner's shared connection is paused.");
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    watchSharedProjects(user.id, connections);
    console.log(
      `${pairing.project?.name ?? "BlackForge"} ${role} runner connected. Dashboard tabs can be closed.`,
    );
    let lastFindings = "";
    let nextRepositoryRefresh = 0;
    let announcedUsageWait: string | undefined;
    if (role === "worker") {
      const interrupted = await db.terminalDispatch.findMany({
        where: {
          userId: user.id,
          agentId: agent.id,
          status: "claimed",
          sharedTurnId: { not: null },
        },
      });
      for (const item of interrupted) {
        try {
          const path = await reportPath(folder, item.id);
          const info = await lstat(path);
          if (info.isSymbolicLink() || !info.isFile() || info.size > 24576)
            throw Error();
          const report = reportSchema.parse(
            JSON.parse(await readFile(path, "utf8")),
          );
          if (report.dispatchId !== item.id) throw Error();
          await completeTerminalDispatch(user.id, item.proposalId);
        } catch {
          const saved = await fetchRelay("/v1/project");
          const current = saved.ok ? await saved.json() : null;
          if (
            current?.turn?.kind === "publish_approve" &&
            current.turn.id === item.sharedTurnId
          ) {
            await db.terminalDispatch.update({
              where: { id: item.id },
              data: {
                status: "ready",
                claimedAt: null,
                error: "Resuming the saved PR publication approval.",
              },
            });
            continue;
          }
          await releaseTerminalDispatch(
            user.id,
            item.proposalId,
            "The worker restarted during execution. Inspect the checkout before retrying.",
          );
        }
      }
    }
    while (!shutdown.signal.aborted) {
      try {
        if (role === "owner") {
          const selection = await fetchRelay("/v1/project");
          if (!selection.ok) {
            if ([401, 403].includes(selection.status)) shutdown.abort();
            throw Error("The runner pairing is no longer valid.");
          }
          if ((await selection.json()).managerSelected === false) {
            await delay(10000, undefined, { signal: shutdown.signal }).catch(
              () => {},
            );
            continue;
          }
          if (githubEnabled && Date.now() >= nextRepositoryRefresh) {
            nextRepositoryRefresh = Date.now() + 60000;
            try {
              const snapshot = await repositoryOverview(user.id, projectId);
              if (snapshot.repository) {
                const trimItems = (items: typeof snapshot.issues) =>
                  items?.map((item) => ({
                    ...item,
                    title: item.title.slice(0, 256),
                    labels: item.labels
                      .slice(0, 5)
                      .map(({ name }) => name.slice(0, 50)),
                  })) ?? null;
                const body = JSON.stringify({
                  repository: snapshot.repository,
                  issues: trimItems(snapshot.issues),
                  pulls: trimItems(snapshot.pulls),
                  merged: trimItems(snapshot.merged),
                });
                const response = await fetchRelay("/v1/repository", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body,
                });
                if (!response.ok) throw Error();
              }
            } catch {
              console.error(
                "Could not publish the dashboard's GitHub snapshot. Will retry.",
              );
            }
          }
          if (githubEnabled) {
            await scanProjectReviews(user.id, projectId, false, replay);
            const view = await reviewQueue(user.id, projectId);
            const findings = view.reviews
              .filter((item) => item.status === "complete")
              .flatMap((review) =>
                review.findings.map(({ title, impact, fix, file, line }) => ({
                  repository: review.repository,
                  number: review.number,
                  head: review.head,
                  title,
                  impact,
                  fix,
                  file,
                  line,
                })),
              )
              .slice(0, 30);
            let json = JSON.stringify(findings);
            while (Buffer.byteLength(json) > 65536) {
              findings.pop();
              json = JSON.stringify(findings);
            }
            if (json !== lastFindings) {
              const result = await fetchRelay("/v1/findings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: json,
              });
              if (result.ok) lastFindings = json;
              else throw Error("The host could not save review findings.");
            }
          }
        } else {
          await collectTerminalReports(user.id);
          await sendSharedDeliveryFailures(user.id);
          const task = await db.terminalDispatch.findFirst({
            where: {
              userId: user.id,
              agentId: agent.id,
              status: "ready",
              sharedTurnId: { not: null },
            },
            orderBy: { createdAt: "asc" },
          });
          if (task) {
            const authorization = await fetchRelay("/v1/project");
            if (!authorization.ok) {
              if ([401, 403].includes(authorization.status)) shutdown.abort();
              throw Error("The agent connection is no longer authorized.");
            }
            const current = await authorization.json();
            if (
              current.task?.id !== task.sharedTaskId ||
              current.turn?.id !== task.sharedTurnId
            ) {
              await db.terminalDispatch.update({
                where: { id: task.id },
                data: {
                  status: "superseded",
                  error: "The shared assignment is no longer current.",
                },
              });
              continue;
            }
            if (task.retryAt && task.retryAt.getTime() > Date.now()) {
              const retryAt = task.retryAt.toISOString();
              const eventId = sharedId("usage-wait:" + task.id + ":" + retryAt);
              if (announcedUsageWait !== eventId) {
                const result = await fetchRelay("/v1/project", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    id: eventId,
                    action: {
                      kind: "usage_wait",
                      turnId: task.sharedTurnId,
                      runnerId: connections[0].runnerId,
                      retryAt,
                    },
                  }),
                });
                if (result.ok || result.status === 409)
                  announcedUsageWait = eventId;
              }
              await delay(
                Math.max(
                  0,
                  Math.min(30000, task.retryAt.getTime() - Date.now()),
                ),
                undefined,
                { signal: shutdown.signal },
              ).catch(() => {});
              continue;
            }
            await claimTerminalDispatch(user.id, task.proposalId);
            try {
              const started = await fetchRelay("/v1/project", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id: sharedId(
                    "work-start:" +
                      task.id +
                      (task.retryAt ? ":" + task.retryAt.toISOString() : ""),
                  ),
                  action: {
                    kind: "work_start",
                    turnId: task.sharedTurnId,
                    runnerId: connections[0].runnerId,
                  },
                }),
              });
              if (!started.ok) throw Error("The shared task could not start.");
              const files: string[] = JSON.parse(task.writePaths);
              let report: Awaited<ReturnType<typeof runHeadlessWorker>>;
              if (current.turn.kind === "publish_approve") {
                const handoff = await publishWorkerPr(
                  folder,
                  current.turn.handoff,
                );
                report = {
                  outcome: "completed",
                  summary: `PR ready for manager review: ${handoff.prUrl}`,
                  checks: [
                    ...handoff.checks,
                    "Published the approved commit. GitHub CI and manager review must be verified separately.",
                  ],
                  artifacts: [handoff.prUrl!, handoff.branch, handoff.head],
                  questions: [],
                  handoff,
                };
              } else {
                const queued = current.queue?.find(
                  (item: { executionId: string }) =>
                    item.executionId === task.sharedTaskId,
                );
                report = await runHeadlessWorker(
                  folder,
                  config.model,
                  task.text,
                  files,
                  profile && profile.preset !== "orchestrator"
                    ? {
                        preset: profile.preset,
                        instructions: profile.instructions,
                      }
                    : undefined,
                  {
                    id: task.sharedTaskId!,
                    repository: current.project?.repository ?? repository,
                    title: queued?.title ?? "Vizor task",
                    checks: z
                      .array(checkNames)
                      .parse(queued?.checks ?? ["diff"]),
                    preparePr: Boolean(
                      queued &&
                      !queued.implicit &&
                      profile?.preset === "developer",
                    ),
                  },
                );
              }
              const path = await reportPath(folder, task.id, true);
              const serialized = JSON.stringify(
                reportSchema.parse({ dispatchId: task.id, ...report }),
              );
              if (Buffer.byteLength(serialized) > 24576)
                throw Error("The worker report exceeds the delivery limit.");
              await writeFile(path, serialized, {
                flag: "wx",
                mode: 0o600,
              });
              await completeTerminalDispatch(user.id, task.proposalId);
              await collectTerminalReports(user.id);
            } catch (error) {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "claude_usage_limit"
              ) {
                await db.terminalDispatch.update({
                  where: { id: task.id },
                  data: {
                    status: "ready",
                    claimedAt: null,
                    retryAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
                    error: "Waiting for Claude Code subscription usage.",
                  },
                });
                continue;
              }
              if (current.turn.kind === "publish_approve") {
                await db.terminalDispatch.update({
                  where: { id: task.id },
                  data: {
                    status: "ready",
                    claimedAt: null,
                    error:
                      "PR publication is waiting. The saved approval will be retried.",
                  },
                });
                await fetchRelay("/v1/project", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    id: sharedId(`publish-wait:${task.id}`),
                    action: {
                      kind: "publish_wait",
                      turnId: task.sharedTurnId,
                      runnerId: connections[0].runnerId,
                      text: `PR publication is waiting. ${error instanceof Error ? error.message.slice(0, 350) : "Check GitHub access and the approved revision."} The saved approval will be retried.`,
                    },
                  }),
                }).catch(() => {});
                await delay(30000, undefined, {
                  signal: shutdown.signal,
                }).catch(() => {});
                continue;
              }
              await releaseTerminalDispatch(
                user.id,
                task.proposalId,
                "Worker execution could not be confirmed. Inspect the checkout before retrying.",
              );
              await sendSharedDeliveryFailures(user.id);
            }
          }
        }
      } catch {
        console.error(
          "The runner could not finish this cycle. Saved work will be reconciled on retry.",
        );
      }
      await delay(role === "owner" ? 10000 : 1000, undefined, {
        signal: shutdown.signal,
      }).catch(() => {});
    }
    watchSharedProjects(user.id, []);
    await db.$disconnect();
  } finally {
    if (checkoutLock) rmSync(checkoutLock, { force: true });
    rmSync(lock, { force: true });
  }
}
