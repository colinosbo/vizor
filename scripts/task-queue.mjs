import { z } from "zod";
import { scopePaths } from "./project-store.mjs";
import { checkNames } from "./worker-handoff.mjs";

export const taskInput = z.strictObject({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(3000),
  acceptance: z.string().trim().min(1).max(1500),
  paths: scopePaths,
  checks: z.array(checkNames).min(1).max(4).default(["diff"]),
  dependencies: z.array(z.uuid()).max(20).default([]),
  references: z
    .array(
      z
        .url()
        .max(300)
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.hostname === "github.com" &&
            !url.username &&
            !url.password
          );
        }),
    )
    .max(6)
    .default([]),
});

export function taskBrief(task) {
  if (task.implicit) return task.description;
  return `Task ${task.id}\n${task.title}\n\n${task.description}\n\nAcceptance criteria\n${task.acceptance}\n\nReferences\n${task.references.join("\n")}${task.managerNote ? "\n\nManager direction\n" + task.managerNote : ""}`.trim();
}

export function taskQueue(events) {
  const queue = new Map();
  const turns = new Map();
  for (const event of events) {
    if (event.kind === "task_create")
      queue.set(event.id, {
        id: event.id,
        title: event.title,
        description: event.description,
        acceptance: event.acceptance,
        paths: event.paths,
        dependencies: event.dependencies,
        references: event.references,
        checks: event.checks ?? ["diff"],
        status: "queued",
        assignee: null,
        executionId: null,
        summary: "",
        outcome: null,
        attempts: 0,
        createdAt: event.created,
        updatedAt: event.created,
        implicit: false,
      });
    if (event.kind === "assign") {
      const taskId = event.queuedTaskId ?? event.id;
      if (!queue.has(taskId))
        queue.set(taskId, {
          id: taskId,
          title: event.text.split("\n")[0].slice(0, 160),
          description: event.text,
          acceptance: "Provide evidence for the approved assignment.",
          paths: event.paths,
          dependencies: [],
          references: [],
          checks: ["diff"],
          status: "queued",
          assignee: null,
          executionId: null,
          summary: "",
          outcome: null,
          attempts: 0,
          createdAt: event.created,
          updatedAt: event.created,
          implicit: true,
        });
      const task = queue.get(taskId);
      task.status = "assigned";
      task.assignee = event.agentId ?? null;
      task.executionId = event.id;
      task.attempts++;
      task.outcome = null;
      delete task.retryAt;
      delete task.handoff;
      delete task.publicationApproved;
      task.updatedAt = event.created;
      turns.set(event.id, taskId);
    }
    const task = queue.get(turns.get(event.turnId));
    if (task) {
      if (event.kind === "claim") task.status = "acknowledged";
      if (event.kind === "work_start") {
        task.status = "working";
        if (task.retryAt) {
          delete task.retryAt;
          task.summary = "";
        }
      }
      if (event.kind === "usage_wait") {
        task.status = "assigned";
        task.retryAt = event.retryAt;
        task.summary = "Waiting for Claude Code subscription usage.";
      }
      if (event.kind === "publish_wait") {
        task.status = "blocked";
        task.summary = event.text;
      }
      if (event.kind === "reply") {
        task.status = "assigned";
        turns.set(event.id, task.id);
      }
      if (event.kind === "publish_approve") {
        task.status = "assigned";
        task.publicationApproved = event.head;
        turns.set(event.id, task.id);
      }
      if (event.kind === "report") {
        delete task.retryAt;
        task.status =
          event.outcome === "completed" && !event.needsReply
            ? "review"
            : "blocked";
        task.summary = event.text;
        if (event.handoff) task.handoff = event.handoff;
        task.outcome = event.outcome;
        turns.set(event.id, task.id);
      }
      task.updatedAt = event.created;
    }
    if (event.kind === "task_accept") {
      const accepted = queue.get(event.taskId);
      accepted.status = "complete";
      accepted.managerNote = event.text;
      accepted.updatedAt = event.created;
    }
    if (event.kind === "task_retry") {
      const retry = queue.get(event.taskId);
      retry.status = "queued";
      delete retry.retryAt;
      retry.assignee = null;
      retry.executionId = null;
      retry.managerNote = event.text;
      if (event.checks) retry.checks = event.checks;
      retry.updatedAt = event.created;
    }
    if (event.kind === "complete")
      for (const item of queue.values()) {
        if (item.implicit && item.status === "review") item.status = "complete";
      }
    if (event.kind === "stop")
      for (const item of queue.values()) {
        if (item.status !== "complete") {
          item.status = "blocked";
          delete item.retryAt;
          item.summary = "Project stopped by the owner.";
          item.updatedAt = event.created;
        }
      }
  }
  return [...queue.values()];
}
