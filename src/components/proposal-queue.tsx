"use client";
import { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ClipboardCheck,
  LoaderCircle,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import type { ProposalPayload, ProposalView } from "@/lib/types";
import { api, type useWorkspace } from "./use-workspace";
import { Dialog } from "./ui";
import { AutomationControls } from "./automation-controls";
type WorkspaceState = ReturnType<typeof useWorkspace>;
export async function deliverTerminalTask(
  workspace: WorkspaceState,
  proposalId: string,
  automatic = false,
  queued = false,
) {
  const bridge = window.vizorDesktop?.terminals;
  if (!bridge) throw Error("Open the Windows desktop app to send this task.");
  let claimed = false;
  let deliveryAttempted = false;
  try {
    const task = await api<{ agentId: string; text: string }>(
      `terminal-dispatches/${proposalId}/claim`,
      "POST",
      undefined,
      queued ? { "x-vizor-queue": "1" } : undefined,
    );
    claimed = true;
    let next = await bridge.snapshot(task.agentId);
    if (next.state !== "running") {
      if (automatic && !queued)
        throw Error(
          "Clarification is ready. Resume this worker, then retry delivery.",
        );
      next = await bridge.start(task.agentId);
      if (next.conflict) {
        if (automatic) {
          const target = workspace.agents.find(
            (agent) => agent.id === task.agentId,
          );
          const normalized = (path?: string) =>
            path?.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
          const peers = workspace.agents.filter(
            (agent) =>
              agent.id !== task.agentId &&
              agent.engine !== "api" &&
              normalized(agent.projectPath) === normalized(target?.projectPath),
          );
          if (!target || !peers.length)
            throw Error("Check the other terminal before resuming the queue.");
          for (const peer of peers) {
            const state = await bridge.snapshot(peer.id);
            if (state.state === "running" && !state.inputReady)
              throw Error(
                "Another agent is still working in this project. The queue is paused.",
              );
          }
        } else if (
          !confirm(
            "Another coding agent is open in this project. Their edits can conflict. Start this agent too?",
          )
        )
          throw Error("Task not sent. The project conflict was not approved.");
        next = await bridge.start(task.agentId, true);
      }
    }
    if (next.state !== "running" || !next.token)
      throw Error(
        "The terminal did not start. Use Set up / sign in, then retry.",
      );
    deliveryAttempted = true;
    await bridge.sendTask(task.agentId, next.token, task.text);
    await api(`terminal-dispatches/${proposalId}/complete`, "POST");
  } catch (error) {
    if (claimed && !deliveryAttempted)
      await api(`terminal-dispatches/${proposalId}/release`, "POST", {
        reason: (error as Error).message,
      }).catch(() => {});
    throw error;
  }
}
export const actionLabel: Record<string, string> = {
  send_message: "Send a message",
  create_agent: "Create an agent",
  rename_agent: "Rename an agent",
  pause_agent: "Pause an agent",
  archive_agent: "Archive an agent",
  dispatch_terminal: "Assign coding agent",
  create_terminal_agent: "Create Claude Code worker",
  answer_worker_question: "Orchestrator clarification",
};
const isTerminalTask = (action: string) =>
  action === "dispatch_terminal" ||
  action === "create_terminal_agent" ||
  action === "answer_worker_question";
const needsDelivery = (payload: ProposalPayload) =>
  (payload.action === "dispatch_terminal" ||
    payload.action === "create_terminal_agent") &&
  !!payload.text.trim();
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
  const [adding, setAdding] = useState(false);
  const proposals = workspace.data?.proposals ?? [];
  const pending = proposals.filter((p) => p.status === "pending");
  const readyIds = new Set(
    workspace.data?.terminalDispatches
      .filter((d) => d.status === "ready" || d.status === "claimed")
      .map((d) => d.proposalId),
  );
  const actionable = proposals.filter(
    (p) =>
      p.status === "pending" ||
      p.status === "queued" ||
      (p.status === "approved" && readyIds.has(p.id)),
  );
  const visible = compact
    ? actionable.slice(0, 4)
    : reviewed
      ? proposals.filter(
          (p) =>
            p.status !== "pending" &&
            p.status !== "queued" &&
            !readyIds.has(p.id),
        )
      : actionable;
  async function approveAll() {
    setBusy(true);
    try {
      const batch = pending.slice(0, 20);
      const result = await api<{ results: { status: string }[] }>(
        "proposals/approve-many",
        "POST",
        {
          items: batch.map((p) => ({ id: p.id, version: p.version })),
        },
      );
      await workspace.reload();
      const terminalTasks = batch.filter(
        (proposal) =>
          !workspace.data?.queueEnabled && needsDelivery(proposal.payload),
      );
      let deliveryError = "";
      for (const proposal of terminalTasks) {
        try {
          await deliverTerminalTask(workspace, proposal.id);
        } catch (error) {
          deliveryError = `Approved task for ${workspace.agents.find((agent) => agent.id === proposal.agentId)?.name ?? "agent"} was not delivered: ${(error as Error).message}`;
          break;
        }
      }
      await workspace.reload();
      const failed = result.results.filter((r) => r.status === "failed").length;
      if (deliveryError) workspace.setError(deliveryError);
      else
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
          <h1>Approvals</h1>
          <p>
            Review drafts, queue approved tasks, and choose how your team runs.
          </p>
        </>
      )}
      <AutomationControls workspace={workspace} />
      <div className="queue-toolbar">
        <h2>
          {compact
            ? "Approval queue"
            : reviewed
              ? "Recent decisions"
              : "Pending and queued tasks"}
          <span>
            {(workspace.data?.pendingProposalCount ?? pending.length) +
              readyIds.size +
              proposals.filter((p) => p.status === "queued").length}
          </span>
        </h2>
        <button
          className="secondary"
          onClick={() => setAdding(true)}
          disabled={
            !workspace.agents.some(
              (a) =>
                !a.archived &&
                (a.engine === "api" || !a.engine || a.engine === "claude-code"),
            )
          }
        >
          <Plus size={14} />
          Add task
        </button>
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
            Pending &amp; ready
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
            Ask the Orchestrator to plan a team and prepare scoped agent tasks.
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
      {compact && actionable.length > 4 && (
        <p className="queue-more">{actionable.length - 4} more in Approvals</p>
      )}
      <div className="queue-footnote">
        Approvals are recorded in Audit history.
      </div>
      {adding && (
        <AddTaskDialog workspace={workspace} onClose={() => setAdding(false)} />
      )}
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
  const agent = workspace.agents.find(
    (a) => a.id === ("agentId" in payload ? payload.agentId : proposal.agentId),
  );
  const dispatch = workspace.data?.terminalDispatches.find(
    (item) => item.proposalId === proposal.id,
  );
  async function launchTerminalTask(): Promise<boolean> {
    if (!isTerminalTask(payload.action)) {
      setError("Open the Windows desktop app to send this task.");
      return false;
    }
    setBusy(true);
    setError("");
    try {
      await deliverTerminalTask(workspace, proposal.id);
      await workspace.reload();
      workspace.setNotice("Task sent to the selected terminal agent.");
      return true;
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      await workspace.reload();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: "approve" | "reject" | "queue") {
    setBusy(true);
    setError("");
    try {
      await api(`proposals/${proposal.id}/${action}`, "POST", {
        version: proposal.version,
      });
      if (
        action === "approve" &&
        needsDelivery(payload) &&
        !workspace.data?.queueEnabled
      ) {
        // Approval is the leader's authorization. Vizor handles the terminal
        // startup and task delivery so the user does not need a second button.
        await launchTerminalTask();
      } else {
        await workspace.reload();
        workspace.setNotice(
          action === "approve"
            ? "Proposal approved."
            : action === "queue"
              ? "Approved task added to the queue."
              : proposal.status === "queued"
                ? "Queued task cancelled."
                : "Proposal rejected.",
        );
      }
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
          {proposal.status === "pending"
            ? "Needs approval"
            : dispatch?.status === "ready"
              ? "Ready to send"
              : dispatch?.status === "claimed"
                ? "Sending…"
                : proposal.status}
        </span>
      </div>
      <h3>
        {payload.action === "create_agent" ||
        payload.action === "create_terminal_agent"
          ? payload.config.name
          : (agent?.name ?? "Unavailable agent")}
      </h3>
      {payload.action === "send_message" ||
      payload.action === "answer_worker_question" ||
      payload.action === "dispatch_terminal" ? (
        <p className="proposal-text">{payload.text}</p>
      ) : payload.action === "create_terminal_agent" ? (
        <>
          <p className="proposal-provider">
            Claude Code · {payload.config.projectPath}
          </p>
          <p className="proposal-text">{payload.config.systemPrompt}</p>
          <p className="proposal-text">
            <strong>First task</strong>
            <br />
            {payload.text ||
              "Waiting for dependencies. Creates a stopped worker; no task is sent yet."}
          </p>
        </>
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
        Task ·{" "}
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
            onClick={() => void decide("queue")}
          >
            <Plus size={14} />
            Approve &amp; queue
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
      ) : proposal.status === "queued" ? (
        <div className="proposal-actions">
          <p className="field-note">
            Approved ·{" "}
            {workspace.data?.queueEnabled
              ? "Waiting for earlier work to report."
              : "Queue paused."}
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void decide("reject")}
          >
            Cancel queued task
          </button>
        </div>
      ) : isTerminalTask(payload.action) && dispatch?.status === "ready" ? (
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
          Retry delivery
        </button>
      ) : isTerminalTask(payload.action) && dispatch?.status === "delivered" ? (
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
function AddTaskDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceState;
  onClose: () => void;
}) {
  const agents = workspace.agents.filter(
    (agent) =>
      !agent.archived &&
      !agent.paused &&
      (!agent.engine ||
        agent.engine === "api" ||
        agent.engine === "claude-code"),
  );
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("task-queue", "POST", { agentId, text });
      await workspace.reload();
      workspace.setNotice("Approved task added to the queue.");
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Add approved task" onClose={onClose}>
      <form className="proposal-edit-form" onSubmit={submit}>
        <label>
          Worker
          <select
            aria-label="Queued task worker"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            required
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Task
          <textarea
            aria-label="Queued task instructions"
            rows={7}
            maxLength={32000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Describe the goal, scope, and completion checks…"
            required
          />
        </label>
        <p className="field-note">
          Adding this task approves it.{" "}
          {workspace.data?.queueEnabled
            ? "It will run after earlier work finishes."
            : "Turn on Run approved queue when you are ready."}
        </p>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !agentId || !text.trim()}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Plus size={14} />
            )}
            Add to queue
          </button>
        </div>
      </form>
    </Dialog>
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
        {payload.action === "create_terminal_agent" && (
          <>
            <label>
              Worker name
              <input
                value={payload.config.name}
                required
                maxLength={70}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: { ...payload.config, name: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Project folder
              <input
                value={payload.config.projectPath}
                required
                maxLength={4096}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    config: { ...payload.config, projectPath: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Role instructions
              <textarea
                rows={4}
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
              First task (leave empty to wait for dependencies)
              <textarea
                rows={7}
                maxLength={32000}
                value={payload.text}
                onChange={(e) =>
                  setPayload({ ...payload, text: e.target.value })
                }
              />
            </label>
          </>
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
