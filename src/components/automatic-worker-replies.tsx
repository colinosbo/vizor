"use client";
import { useEffect, useRef } from "react";
import { api, type useWorkspace } from "./use-workspace";
import { deliverTerminalTask } from "./proposal-queue";
export function AutomaticWorkerReplies({
  workspace,
}: {
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const attempted = useRef(new Set<string>());
  const busy = useRef(false);
  const enabled = useRef(false);
  useEffect(() => {
    if (workspace.data?.queueEnabled && !enabled.current)
      attempted.current.clear();
    enabled.current = !!workspace.data?.queueEnabled;
    if (busy.current || !window.vizorDesktop?.terminals) return;
    const task = workspace.data?.terminalDispatches.find(
      (item) =>
        (item.autoDeliver || workspace.data?.queueEnabled) &&
        item.status === "ready" &&
        !attempted.current.has(item.id),
    );
    if (!task) return;
    busy.current = true;
    attempted.current.add(task.id);
    void deliverTerminalTask(
      workspace,
      task.proposalId,
      true,
      !task.autoDeliver,
    )
      .then(() =>
        workspace.setNotice(
          task.autoDeliver
            ? "Orchestrator’s answer sent to the worker."
            : "Queued task sent to the worker.",
        ),
      )
      .catch(async (error) => {
        workspace.setError(`Task delivery needs attention: ${error.message}`);
        if (!task.autoDeliver)
          await api("automation", "PATCH", {
            queueEnabled: false,
            autoApprove: false,
          }).catch(() => {});
      })
      .finally(async () => {
        busy.current = false;
        await workspace.reload();
      });
  }, [workspace.data]);
  return null;
}
