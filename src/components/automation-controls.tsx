"use client";
import { useState } from "react";
import { api, type useWorkspace } from "./use-workspace";

export function AutomationControls({
  workspace,
}: {
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const [busy, setBusy] = useState(false);
  const running = !!workspace.data?.queueEnabled;
  const automatic = !!workspace.data?.autopilot;
  async function change(queueEnabled: boolean, autoApprove: boolean) {
    setBusy(true);
    try {
      await api("automation", "PATCH", { queueEnabled, autoApprove });
      await workspace.reload();
      workspace.setNotice(
        autoApprove
          ? "Full auto approval is on."
          : queueEnabled
            ? "Approved task queue is running."
            : "Task queue paused. Running work can finish.",
      );
    } catch (error) {
      workspace.setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="automation-controls" aria-label="Task automation">
      <div className="automation-option">
        <div>
          <strong>Run approved queue</strong>
          <p>
            Runs approved tasks in order while Vizor is open. Waits for each
            task’s report.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Run approved queue"
          aria-checked={running}
          className={`automation-switch ${running ? "on" : ""}`}
          disabled={busy}
          onClick={() => void change(!running, running ? false : automatic)}
        >
          <span />
          {running ? "On" : "Off"}
        </button>
      </div>
      <div className="automation-option">
        <div>
          <strong>Full auto approval</strong>
          <p>
            Approves waiting and new proposals and runs them without per-task
            clicks. Turning it off pauses the queue.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Full auto approval"
          aria-checked={automatic}
          className={`automation-switch ${automatic ? "on" : ""}`}
          disabled={busy}
          onClick={() => void change(!automatic, !automatic)}
        >
          <span />
          {automatic ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}
