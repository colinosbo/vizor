import { z } from "zod";
import { win32 } from "node:path";
import { db } from "./db";
import { AppError } from "./errors";
import { publish } from "./events";
import { audit } from "./audit";
import { parseWritePaths, scopesConflict } from "./work-scopes";
import { commandRunner, inspectGitHubMerge } from "./github-merge-check";
import type { ToolCall } from "../providers/types";

const activeStatuses = [
  "queued",
  "checking",
  "waiting_checks",
  "merging",
  "waiting_merge",
];
const safeText = (value: string) =>
  !/\b(?:sk-ant-|sk-proj-|ghp_|github_pat_|gho_)[A-Za-z0-9_-]{8,}|(?:password|api[_ -]?key|authorization|secret)\s*[:=]\s*\S+/i.test(
    value,
  );
const mergeInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(4000),
  })
  .strict()
  .refine(
    (value) => safeText(value.title) && safeText(value.summary),
    "Remove credentials or secrets from the pull request text.",
  );

export async function requestProjectMerge(
  userId: string,
  projectId: string,
  runId: string,
  call: ToolCall,
) {
  const input = mergeInput.parse(call.arguments);
  const result = await db.$transaction(async (tx) => {
    const prior = await tx.mergeJob.findUnique({
      where: { runId_toolCallId: { runId, toolCallId: call.id } },
    });
    if (prior) {
      if (prior.userId !== userId || prior.projectId !== projectId)
        throw new AppError("not_found", "Merge request unavailable.", 404);
      return prior;
    }
    const project = await tx.project.findFirst({
      where: { id: projectId, userId },
    });
    const run = await tx.run.findFirst({
      where: {
        id: runId,
        userId,
        conversation: { agent: { userId, projectId, kind: "orchestrator" } },
      },
      select: { id: true },
    });
    if (!project || !run)
      throw new AppError(
        "not_found",
        "The project or Orchestrator run is unavailable.",
        404,
      );
    const active = await tx.terminalDispatch.findMany({
      where: { userId, status: { in: ["ready", "claimed", "delivered"] } },
      select: { agent: { select: { projectPath: true } } },
    });
    if (
      active.some((task) =>
        scopesConflict(project.folder, [], task.agent.projectPath, []),
      )
    )
      throw new AppError(
        "project_busy",
        "Wait for all coding tasks in this folder to report before requesting a merge.",
        409,
      );
    if (
      await tx.proposal.findFirst({
        where: {
          userId,
          projectId,
          status: { in: ["pending", "queued", "executing"] },
        },
      })
    )
      throw new AppError(
        "project_pending",
        "Finish or cancel this project's pending work before requesting a merge.",
        409,
      );
    const reported = await tx.terminalDispatch.findMany({
      where: { userId, agent: { projectId }, status: "reported" },
      orderBy: { createdAt: "desc" },
      select: { id: true, agentId: true, outcome: true },
    });
    const latest = reported.filter(
      (task, index) =>
        reported.findIndex(
          (candidate) => candidate.agentId === task.agentId,
        ) === index,
    );
    if (!latest.length)
      throw new AppError(
        "report_required",
        "A completed coding report is required before requesting a merge.",
        409,
      );
    if (latest.some((task) => task.outcome !== "completed"))
      throw new AppError(
        "report_incomplete",
        "The latest coding reports include unfinished or unverified work.",
        409,
      );
    const jobs = await tx.mergeJob.findMany({
      where: { userId, status: { in: activeStatuses } },
      include: { project: { select: { folder: true } } },
    });
    if (
      jobs.some((job) =>
        scopesConflict(project.folder, [], job.project.folder, []),
      )
    )
      throw new AppError(
        "merge_busy",
        "A GitHub operation is already in progress for this folder.",
        409,
      );
    const job = await tx.mergeJob.create({
      data: { userId, projectId, runId, toolCallId: call.id, ...input },
    });
    await audit(
      userId,
      "project.merge_requested",
      projectId,
      { jobId: job.id },
      { actor: "orchestrator" },
      tx,
    );
    return job;
  });
  publish(userId);
  void processProjectMerges(userId).catch(() => {});
  return {
    jobId: result.id,
    status: result.status,
    message:
      "GitHub verification has been requested; merge is not yet confirmed.",
  };
}

const state = globalThis as unknown as {
  vizorMergeTicks?: Map<string, Promise<void>>;
};
const ticks = (state.vizorMergeTicks ??= new Map());
async function reportMergeResult(jobId: string, userId: string) {
  const job = await db.mergeJob.findFirst({
    where: { id: jobId, userId, status: { in: ["merged", "blocked"] } },
  });
  if (!job) return;
  const lead = await db.agent.findFirst({
    where: { userId, projectId: job.projectId, kind: "orchestrator" },
    select: { conversation: { select: { id: true } } },
  });
  if (!lead?.conversation) return;
  const id = `merge-result-${job.id}-${job.status}`;
  await db.$transaction(async (tx) => {
    if (await tx.message.findUnique({ where: { id } })) return;
    const last = await tx.message.aggregate({
      where: { conversationId: lead.conversation!.id },
      _max: { position: true },
    });
    await tx.message.create({
      data: {
        id,
        conversationId: lead.conversation!.id,
        position: (last._max.position ?? -1) + 1,
        role: "assistant",
        origin: "merge_status",
        status: "complete",
        text:
          job.status === "merged"
            ? `GitHub checks passed and the pull request was merged. ${job.prUrl ?? ""}`.trim()
            : `GitHub merge needs attention: ${job.error ?? "The pull request could not be verified."}${job.prUrl ? ` ${job.prUrl}` : ""}`,
      },
    });
  });
}
export function processProjectMerges(userId: string) {
  const previous = ticks.get(userId);
  if (previous) return previous;
  const task = tick(userId).finally(() => ticks.delete(userId));
  ticks.set(userId, task);
  return task;
}

async function tick(userId: string) {
  const stale = new Date(Date.now() - 10 * 60_000);
  await db.mergeJob.updateMany({
    where: {
      userId,
      status: { in: ["checking", "merging"] },
      claimedAt: { lt: stale },
    },
    data: {
      status: "blocked",
      error:
        "A GitHub operation was interrupted. Check the pull request before retrying.",
      claimedAt: null,
    },
  });
  const job = await db.mergeJob.findFirst({
    where: {
      userId,
      status: { in: ["queued", "waiting_checks", "waiting_merge"] },
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
    include: { project: true },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return;
  const oldStatus = job.status;
  const claim = await db.mergeJob.updateMany({
    where: { id: job.id, userId, status: oldStatus },
    data: { status: "checking", claimedAt: new Date() },
  });
  if (!claim.count) return;
  publish(userId);
  try {
    if (oldStatus === "waiting_merge" && job.repository && job.prNumber) {
      const view = await commandRunner(job.project.folder, "gh", [
        "pr",
        "view",
        String(job.prNumber),
        "--repo",
        job.repository,
        "--json",
        "state,headRefOid",
      ]);
      let result: { state?: string; headRefOid?: string } = {};
      try {
        result = JSON.parse(view.stdout);
      } catch {}
      const merged =
        view.code === 0 &&
        result.state === "MERGED" &&
        result.headRefOid === job.expectedHead;
      const waiting =
        view.code === 0 &&
        result.state === "OPEN" &&
        result.headRefOid === job.expectedHead;
      await db.mergeJob.update({
        where: { id: job.id },
        data: {
          status: merged ? "merged" : waiting ? "waiting_merge" : "blocked",
          error:
            merged || waiting
              ? null
              : "GitHub could not confirm the merge. Check the pull request.",
          nextCheckAt: waiting ? new Date(Date.now() + 20000) : null,
          claimedAt: null,
        },
      });
      if (merged) {
        await audit(
          userId,
          "project.merged",
          job.projectId,
          { jobId: job.id, prNumber: job.prNumber, head: job.expectedHead },
          { actor: "system" },
        );
        await reportMergeResult(job.id, userId);
      } else if (!waiting) await reportMergeResult(job.id, userId);
      publish(userId);
      return;
    }
    const reports = await db.terminalDispatch.findMany({
      where: {
        userId,
        agent: { projectId: job.projectId },
        status: "reported",
        outcome: "completed",
      },
      select: { id: true, writePaths: true },
    });
    const otherReports = await db.terminalDispatch.findMany({
      where: { userId },
      select: { id: true, agent: { select: { projectPath: true } } },
    });
    const inspection = await inspectGitHubMerge({
      ...job,
      folder: job.project.folder,
      reportIds: reports.map((report) => report.id),
      otherReportFiles: otherReports
        .filter((report) => report.agent.projectPath)
        .map((report) =>
          win32.join(
            report.agent.projectPath!,
            ".vizor",
            "task-reports",
            `${report.id}.json`,
          ),
        ),
      writePaths: reports.flatMap((report) =>
        parseWritePaths(report.writePaths),
      ),
    });
    if (
      inspection.state === "ready" &&
      inspection.expectedHead &&
      inspection.prNumber &&
      inspection.repo &&
      inspection.strategy
    ) {
      await db.mergeJob.update({
        where: { id: job.id },
        data: {
          status: "merging",
          expectedHead: inspection.expectedHead,
          prNumber: inspection.prNumber,
          prUrl: inspection.prUrl,
          repository: inspection.repo,
          claimedAt: new Date(),
        },
      });
      publish(userId);
      const merged = await commandRunner(job.project.folder, "gh", [
        "pr",
        "merge",
        String(inspection.prNumber),
        "--repo",
        inspection.repo,
        inspection.strategy,
        "--match-head-commit",
        inspection.expectedHead,
      ]);
      const view = await commandRunner(job.project.folder, "gh", [
        "pr",
        "view",
        String(inspection.prNumber),
        "--repo",
        inspection.repo,
        "--json",
        "state,headRefOid",
      ]);
      let result: { state?: string; headRefOid?: string } = {};
      try {
        result = JSON.parse(view.stdout);
      } catch {}
      const confirmed =
        view.code === 0 &&
        result.state === "MERGED" &&
        result.headRefOid === inspection.expectedHead;
      const waiting =
        merged.code === 0 &&
        view.code === 0 &&
        result.state === "OPEN" &&
        result.headRefOid === inspection.expectedHead;
      await db.mergeJob.update({
        where: { id: job.id },
        data: {
          status: confirmed ? "merged" : waiting ? "waiting_merge" : "blocked",
          error:
            confirmed || waiting
              ? null
              : "GitHub did not confirm the merge. Check the pull request before retrying.",
          nextCheckAt: waiting ? new Date(Date.now() + 20000) : null,
          claimedAt: null,
        },
      });
      if (confirmed)
        await audit(
          userId,
          "project.merged",
          job.projectId,
          {
            jobId: job.id,
            prNumber: inspection.prNumber,
            head: inspection.expectedHead,
          },
          { actor: "system" },
        );
    } else {
      await db.mergeJob.update({
        where: { id: job.id },
        data: {
          status: inspection.state,
          expectedHead: inspection.expectedHead ?? job.expectedHead,
          prNumber: inspection.prNumber ?? job.prNumber,
          prUrl: inspection.prUrl ?? job.prUrl,
          repository: inspection.repo ?? job.repository,
          checksPassedAt: inspection.checksPassedAt ?? null,
          checksHash: inspection.checksHash ?? null,
          error: inspection.reason ?? null,
          nextCheckAt:
            inspection.state === "waiting_checks"
              ? new Date(Date.now() + 20000)
              : null,
          claimedAt: null,
        },
      });
    }
  } catch {
    await db.mergeJob.update({
      where: { id: job.id },
      data: {
        status: "blocked",
        error:
          "GitHub verification could not be completed. Check Git and GitHub CLI, then inspect the pull request before retrying.",
        claimedAt: null,
      },
    });
  }
  await reportMergeResult(job.id, userId).catch(() => {});
  publish(userId);
}
