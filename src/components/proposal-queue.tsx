"use client";
import { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ClipboardCheck,
  LoaderCircle,
  Pencil,
  X,
} from "lucide-react";
import type { ProposalPayload, ProposalView } from "@/lib/types";
import { api, type useWorkspace } from "./use-workspace";
import { Dialog } from "./ui";
type WorkspaceState = ReturnType<typeof useWorkspace>;
export const actionLabel: Record<string, string> = {
  send_message: "Send a message",
  create_agent: "Create an agent",
  rename_agent: "Rename an agent",
  pause_agent: "Pause an agent",
  archive_agent: "Archive an agent",
  dispatch_terminal: "Send a terminal task",
};
export function ProposalQueue({
  workspace,
  compact = false,
  onFocus,
}: {
  workspace: WorkspaceState;
  compact?: boolean;
  onFocus?: (id: string) => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const proposals = workspace.data?.proposals ?? [];
  const pending = proposals.filter((p) => p.status === "pending");
  const visible = compact
    ? pending.slice(0, 4)
    : reviewed
      ? proposals.filter((p) => p.status !== "pending")
      : pending;
  async function approveAll() {
    setBusy(true);
    try {
      const result = await api<{ results: { status: string }[] }>(
        "proposals/approve-many",
        "POST",
        {
          items: pending
            .slice(0, 20)
            .map((p) => ({ id: p.id, version: p.version })),
        },
      );
      await workspace.reload();
      const failed = result.results.filter((r) => r.status === "failed").length;
      workspace.setNotice(
        `${result.results.length - failed} approved${failed ? ` · ${failed} need attention` : ""}.`,
      );
    } catch (e) {
      workspace.setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={
        compact
          ? "proposal-queue compact-queue"
          : "collection-view proposal-queue"
      }
    >
      {!compact && (
        <>
          <div className="page-eyebrow">
            <span className="eyebrow-line" />
            YOU MAKE THE CALL
          </div>
          <h1>Review the next move.</h1>
          <p>Every draft stays here until you approve it. Autopilot is off.</p>
        </>
      )}
      <div className="queue-toolbar">
        <h2>
          {compact
            ? "Approval queue"
            : reviewed
              ? "Recent decisions"
              : "Pending proposals"}
          <span>{workspace.data?.pendingProposalCount ?? pending.length}</span>
        </h2>
        {pending.length > 1 && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void approveAll()}
          >
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <CheckCheck size={14} />
            )}
            Approve {Math.min(20, pending.length)}
          </button>
        )}
      </div>
      {!compact && (
        <div className="queue-tabs" role="group" aria-label="Proposal status">
          <button
            className={!reviewed ? "selected" : ""}
            onClick={() => setReviewed(false)}
          >
            Pending
          </button>
          <button
            className={reviewed ? "selected" : ""}
            onClick={() => setReviewed(true)}
          >
            Recent decisions
          </button>
        </div>
      )}
      {!compact &&
        !reviewed &&
        (workspace.data?.pendingProposalCount ?? 0) > pending.length && (
          <p className="field-note">
            Showing the oldest {pending.length} pending proposals. More appear
            as you review these.
          </p>
        )}
      {!visible.length ? (
        <div className="queue-empty">
          <ClipboardCheck size={24} />
          <h3>{reviewed ? "No decisions yet." : "Nothing waiting on you."}</h3>
          <p>
            Ask the orchestrator to draft a message or suggest an agent change.
          </p>
        </div>
      ) : (
        <div className="proposal-list">
          {visible.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              workspace={workspace}
              proposal={proposal}
              onFocus={onFocus}
            />
          ))}
        </div>
      )}
      {compact && pending.length > 4 && (
        <p className="queue-more">{pending.length - 4} more in Proposals</p>
      )}
      <div className="queue-footnote">
        Approvals are recorded in Audit history.
      </div>
    </div>
  );
}
function ProposalCard({
  workspace,
  proposal,
  onFocus,
}: {
  workspace: WorkspaceState;
  proposal: ProposalView;
  onFocus?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [error, setError] = useState("");
  const payload = proposal.payload;
  const agent =
    "agentId" in payload
      ? workspace.agents.find((a) => a.id === payload.agentId)
      : undefined;
  const dispatch = workspace.data?.terminalDispatches.find(
    (item) => item.proposalId === proposal.id,
  );
  async function launchTerminalTask() {
    const bridge = window.vizorDesktop?.terminals;
    if (!bridge || payload.action !== "dispatch_terminal") {
      setError("Open the Windows desktop app to send this task.");
      return;
    }
    setBusy(true);
    setError("");
    let claimed = false;
    try {
      const task = await api<{ agentId: string; text: string }>(
        `terminal-dispatches/${proposal.id}/claim`,
        "POST",
      );
      claimed = true;
      let next = await bridge.snapshot(task.agentId);
      if (next.state !== "running") {
        next = await bridge.start(task.agentId);
        if (next.conflict) {
          if (
            !confirm(
              "Another coding agent is open in this project. Their edits can conflict. Start this agent too?",
            )
          )
            throw Error(
              "Task not sent. The project conflict was not approved.",
            );
          next = await bridge.start(task.agentId, true);
        }
      }
      if (next.state !== "running" || !next.token)
        throw Error(
          "The terminal did not start. Use Set up / sign in, then retry.",
        );
      await bridge.input(task.agentId, next.token, `${task.text}\r`);
      await api(`terminal-dispatches/${proposal.id}/complete`, "POST");
      await workspace.reload();
      workspace.setNotice("Task sent to the selected terminal agent.");
    } catch (e) {
      const message = (e as Error).message;
      if (claimed)
        await api(`terminal-dispatches/${proposal.id}/release`, "POST", {
          reason: message,
        }).catch(() => {});
      setError(message);
      await workspace.reload();
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      await api(`proposals/${proposal.id}/${action}`, "POST", {
        version: proposal.version,
      });
      await workspace.reload();
      workspace.setNotice(
        action === "approve" ? "Proposal approved." : "Proposal rejected.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="proposal-card"
      aria-label={`${actionLabel[proposal.action] ?? proposal.action} proposal`}
    >
      <div className="proposal-card-top">
        <span className="proposal-action">
          {actionLabel[proposal.action] ?? proposal.action}
        </span>
        <span className={`proposal-status ${proposal.status}`}>
          {proposal.status === "pending" ? "Needs approval" : proposal.status}
        </span>
      </div>
      <h3>
        {payload.action === "create_agent"
          ? payload.config.name
          : (agent?.name ?? "Unavailable agent")}
      </h3>
      {payload.action === "send_message" ||
      payload.action === "dispatch_terminal" ? (
        <p className="proposal-text">{payload.text}</p>
      ) : payload.action === "rename_agent" ? (
        <p className="proposal-text">
          New name: <strong>{payload.name}</strong>
        </p>
      ) : payload.action === "create_agent" ? (
        <>
          <p className="proposal-provider">
            {
              workspace.data?.providers.find(
                (p) => p.id === payload.config.provider,
              )?.label
            }{" "}
            · {payload.config.model}
          </p>
          <p className="proposal-text">{payload.config.systemPrompt}</p>
        </>
      ) : (
        <p className="proposal-text">
          {payload.action === "pause_agent"
            ? "Pause this agent and stop its current response."
            : "Archive this agent and keep its conversation history."}
        </p>
      )}
      <div className="proposal-origin">
        Orchestrator draft ·{" "}
        {new Date(proposal.createdAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}
        {proposal.approvedBy && " · Approved by you"}
      </div>
      {(error || proposal.error) && (
        <div className="error-box" role="alert">
          {error || proposal.error}
        </div>
      )}
      {proposal.status === "pending" ? (
        <div className="proposal-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void decide("approve")}
          >
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            Approve
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            <Pencil size={13} />
            Edit
          </button>
          <button
            className="icon-button"
            disabled={busy}
            onClick={() => void decide("reject")}
            aria-label="Reject proposal"
            title="Reject proposal"
          >
            <X size={15} />
          </button>
        </div>
      ) : payload.action === "dispatch_terminal" &&
        dispatch?.status === "ready" ? (
        <button
          className="primary"
          disabled={busy}
          onClick={() => void launchTerminalTask()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <ArrowRight size={14} />
          )}
          Start &amp; send
        </button>
      ) : payload.action === "dispatch_terminal" &&
        dispatch?.status === "delivered" ? (
        <p className="field-note">Task sent to this terminal agent.</p>
      ) : agent && onFocus ? (
        <button className="text-button" onClick={() => onFocus(agent.id)}>
          Open agent
          <ArrowRight size={13} />
        </button>
      ) : null}
      {editing && (
        <ProposalEditor
          workspace={workspace}
          proposal={proposal}
          onClose={() => setEditing(false)}
        />
      )}
    </article>
  );
}
function ProposalEditor({
  workspace,
  proposal,
  onClose,
}: {
  workspace: WorkspaceState;
  proposal: ProposalView;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<ProposalPayload>(proposal.payload),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [version] = useState(proposal.version);
  const provider =
    payload.action === "create_agent"
      ? workspace.data?.providers.find((p) => p.id === payload.config.provider)
      : undefined;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`proposals/${proposal.id}`, "PATCH", { version, payload });
      await workspace.reload();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Edit proposal" onClose={onClose}>
      <form className="proposal-edit-form" onSubmit={save}>
        {"agentId" in payload && (
          <label>
            Target agent
            <select
              aria-label="Target agent"
              value={payload.agentId}
              onChange={(e) =>
                setPayload({ ...payload, agentId: e.target.value })
              }
            >
              {workspace.agents
                .filter(
                  (a) =>
                    !a.archived &&
                    (payload.action === "dispatch_terminal"
                      ? a.engine === "claude-code" || a.engine === "codex"
                      : !a.engine || a.engine === "api"),
                )
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {(payload.action === "send_message" ||
          payload.action === "dispatch_terminal") && (
          <label>
            {payload.action === "dispatch_terminal"
              ? "Terminal task"
              : "Message"}
            <textarea
              aria-label="Proposal message"
              rows={7}
              maxLength={32000}
              required
              value={payload.text}
              onChange={(e) => setPayload({ ...payload, text: e.target.value })}
            />
          </label>
        )}
        {payload.action === "rename_agent" && (
          <label>
            New agent name
            <input
              value={payload.name}
              required
              maxLength={70}
              onChange={(e) => setPayload({ ...payload, name: e.target.value })}
            />
          </label>
        )}
        {payload.action === "create_agent" && (
          <>
            <label>
              Agent name
              <input
                value={payload.config.name}
                maxLength={70}
                required
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: { ...payload.config, name: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Provider
              <select
                aria-label="Proposal provider"
                value={payload.config.provider}
                onChange={(e) => {
                  const next = workspace.data!.providers.find(
                    (p) => p.id === e.target.value,
                  )!;
                  setPayload({
                    ...payload,
                    config: {
                      ...payload.config,
                      provider: next.id,
                      model: next.defaultModel,
                    },
                  });
                }}
              >
                {workspace.data?.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.connected ? "" : " · key required before approval"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select
                aria-label="Proposal model"
                value={payload.config.model}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: { ...payload.config, model: e.target.value },
                  })
                }
              >
                {!workspace.models[payload.config.provider]?.models.some(
                  (m) => m.id === payload.config.model,
                ) && (
                  <option value={payload.config.model}>
                    {payload.config.model}
                  </option>
                )}
                {workspace.models[payload.config.provider]?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              System prompt
              <textarea
                aria-label="Proposal system prompt"
                rows={5}
                maxLength={16000}
                value={payload.config.systemPrompt}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: { ...payload.config, systemPrompt: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Maximum output tokens
              <input
                type="number"
                min={64}
                max={8192}
                required
                value={payload.config.maxTokens}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: {
                      ...payload.config,
                      maxTokens: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <small>
              {provider?.connected
                ? ""
                : "A connected provider is required when this proposal is approved."}
            </small>
            {workspace.models[payload.config.provider]?.models.find(
              (m) => m.id === payload.config.model,
            )?.temperature && (
              <label>
                Temperature
                <input
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  required
                  value={payload.config.temperature}
                  onChange={(e) =>
                    setPayload({
                      ...payload,
                      config: {
                        ...payload.config,
                        temperature: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            )}
            <label>
              Colour
              <select
                value={payload.config.color}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: {
                      ...payload.config,
                      color: e.target.value as
                        "mint" | "amber" | "blue" | "rose",
                    },
                  })
                }
              >
                <option value="mint">Mint</option>
                <option value="amber">Amber</option>
                <option value="blue">Blue</option>
                <option value="rose">Rose</option>
              </select>
            </label>
            <label>
              Icon
              <select
                value={payload.config.icon}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: {
                      ...payload.config,
                      icon: e.target.value as
                        "spark" | "code" | "pen" | "search",
                    },
                  })
                }
              >
                <option value="spark">Spark</option>
                <option value="code">Code</option>
                <option value="pen">Pen</option>
                <option value="search">Search</option>
              </select>
            </label>
          </>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            Save draft
          </button>
        </div>
      </form>
    </Dialog>
  );
}
