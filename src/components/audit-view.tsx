"use client";
import { useEffect, useState } from "react";
import { ArrowDown, History, LoaderCircle, RotateCcw } from "lucide-react";
import type { AuditView as Entry } from "@/lib/types";
import { api, type useWorkspace } from "./use-workspace";
const labels: Record<string, string> = {
  "proposal.created": "Proposal drafted",
  "proposal.edited": "Proposal edited",
  "proposal.approved": "Proposal approved",
  "proposal.rejected": "Proposal rejected",
  "proposal.failed": "Proposal failed",
  "proposal.interrupted": "Approval interrupted",
  "message.submitted": "Message submitted",
  "response.failed": "Response failed",
  "response.stopped": "Response stopped",
  "agent.created": "Agent created",
  "agent.updated": "Agent settings changed",
  create_agent: "Agent created",
  rename_agent: "Agent renamed",
  pause_agent: "Agent paused",
  archive_agent: "Agent archived",
  "agent.archive": "Agent archived",
  "agent.restore": "Agent restored",
  "agent.pause": "Agent paused",
  "agent.resume": "Agent resumed",
  "orchestrator.configured": "Orchestrator configured",
  "orchestrator.summarized": "Agent summaries read",
  "orchestrator.tool_blocked": "Invalid tool call blocked",
  "budget.updated": "Spending limit changed",
  "budget.reconciled": "Opening balance recorded",
  "budget.blocked": "Spending guard blocked a request",
  "budget.quote_exceeded": "Usage exceeded its reservation",
  "provider.connected": "Provider connected",
  "provider.removed": "Provider removed",
};
export function AuditHistory({
  workspace,
}: {
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load(before?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ entries: Entry[]; nextCursor: string | null }>(
        `audit${before ? `?before=${encodeURIComponent(before)}` : ""}`,
      );
      setEntries((old) =>
        before
          ? [
              ...old,
              ...result.entries.filter(
                (entry) => !old.some((e) => e.id === entry.id),
              ),
            ]
          : result.entries,
      );
      setCursor(result.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [workspace.data]);
  return (
    <div className="collection-view audit-view">
      <div className="page-eyebrow">
        <span className="eyebrow-line" />A CLEAR RECORD
      </div>
      <div className="audit-heading">
        <div>
          <h1>Every decision, in view.</h1>
          <p>Who proposed it, what you approved, and what happened next.</p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          <RotateCcw size={14} />
          Refresh
        </button>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!entries.length && !busy ? (
        <div className="collection-empty">
          <History size={28} />
          <h2>No actions recorded yet.</h2>
          <p>
            Approvals, messages, agent changes and spending settings appear
            here.
          </p>
        </div>
      ) : (
        <div className="audit-list">
          {entries.map((entry) => {
            const agent =
              workspace.agents.find((a) => a.id === entry.subjectId) ??
              (workspace.orchestrator?.id === entry.subjectId
                ? workspace.orchestrator
                : null);
            return (
              <article className="audit-entry" key={entry.id}>
                <span className={`audit-dot ${entry.actor}`} />
                <div>
                  <div className="audit-title">
                    <h2>{labels[entry.action] ?? entry.action}</h2>
                    <time>{new Date(entry.createdAt).toLocaleString()}</time>
                  </div>
                  <p>
                    <strong>
                      {entry.actor === "orchestrator"
                        ? "Orchestrator"
                        : entry.actor === "system"
                          ? "Vizor"
                          : "You"}
                    </strong>
                    {agent ? ` · ${agent.name}` : ""}
                    {entry.approvedBy && " · Approved by you"}
                  </p>
                  {Object.keys(entry.details).length > 0 && (
                    <details>
                      <summary>Details</summary>
                      <pre>{JSON.stringify(entry.details, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {cursor && (
        <button
          className="secondary load-more"
          disabled={busy}
          onClick={() => void load(cursor)}
        >
          {busy ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <ArrowDown size={14} />
          )}
          Load older actions
        </button>
      )}
    </div>
  );
}
