"use client";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
  MessageSquarePlus,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api, type useWorkspace } from "./use-workspace";
import { AgentPanel } from "./agent-panel";
import { Dialog } from "./ui";
import { ProposalQueue } from "./proposal-queue";
type WorkspaceState = ReturnType<typeof useWorkspace>;
export function OrchestratorPanel({
  workspace,
  onFocus,
  onNew,
  onConnections,
}: {
  workspace: WorkspaceState;
  onFocus: (id: string) => void;
  onNew: () => void;
  onConnections: () => void;
}) {
  const [settings, setSettings] = useState(false);
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  const [clearingChat, setClearingChat] = useState(false);
  const active = workspace.agents.filter(
    (a) => !a.archived && a.engine !== "codex",
  );
  const ids = active.map((a) => a.id).join("|");
  const scope = (
    workspace.contextScope ?? active.slice(0, 20).map((a) => a.id)
  ).filter((id) => active.some((a) => a.id === id));
  const setScope = (update: (old: string[]) => string[]) =>
    workspace.setContextScope(update(scope));
  const agent = workspace.orchestrator;
  const provider = workspace.data!.providers.find(
    (p) => p.id === agent?.provider,
  );
  function ask(text: string) {
    if (agent)
      void workspace.send(agent.id, text, "send", undefined, {
        orchestrator: true,
        agentIds: scope,
      });
  }
  async function startNewChat() {
    if (!agent || clearingChat) return;
    setClearingChat(true);
    try {
      const result = await api<{
        cancelledProposals: number;
        retiredTasks: number;
      }>("orchestrator/clear", "POST");
      await workspace.reload();
      workspace.setNotice(
        `Fresh Orchestrator chat started. Cleared ${result.cancelledProposals} pending approval${result.cancelledProposals === 1 ? "" : "s"} and retired ${result.retiredTasks} unsent or stopped task${result.retiredTasks === 1 ? "" : "s"}. Running terminals were left alone.`,
      );
      setConfirmNewChat(false);
    } catch (error) {
      workspace.setError((error as Error).message);
    } finally {
      setClearingChat(false);
    }
  }
  return (
    <div className="orchestrator-view">
      <div className="orchestrator-heading">
        <div>
          <div className="eyebrow">PLAN · DELEGATE · REVIEW</div>
          <h1>What are we building?</h1>
          <p>Give your team a direction. Manage tasks and automation below.</p>
        </div>
        <span className="approval-only">
          <ShieldCheck size={14} />
          {workspace.data?.autopilot
            ? "Full auto approval on"
            : "Autopilot off"}
        </span>
      </div>
      {!agent ? (
        <div className="welcome">
          <span className="welcome-mark">
            <Sparkles size={28} />
          </span>
          <h2>Set up your team lead.</h2>
          <p>
            The orchestrator uses your API connection to plan work and propose
            tasks for your agents. Choose manual or automatic approval.
          </p>
          <button
            className="primary"
            disabled={!workspace.data?.providers.some((p) => p.connected)}
            onClick={() => setSettings(true)}
          >
            Set up orchestrator
            <ArrowRight size={15} />
          </button>
          {!workspace.data?.providers.some((p) => p.connected) && (
            <button className="secondary" onClick={onConnections}>
              Connect an API key
            </button>
          )}
        </div>
      ) : (
        <div className="orchestrator-columns">
          <div className="orchestrator-conversation">
            <div className="orchestrator-shortcuts">
              <button
                disabled={
                  !!agent.conversation.activeRunId ||
                  !!workspace.pending[agent.id]
                }
                onClick={() =>
                  ask(
                    "Summarize progress across the selected agents. Separate what is done from what is uncertain.",
                  )
                }
              >
                Summarize progress
              </button>
              <button
                disabled={
                  !!agent.conversation.activeRunId ||
                  !!workspace.pending[agent.id]
                }
                onClick={() =>
                  ask(
                    "Draft useful next-step messages for the selected agents. Queue them for my review; do not send anything.",
                  )
                }
              >
                Draft next steps
              </button>
              <button
                className="orchestrator-new-chat"
                disabled={
                  !!agent.conversation.activeRunId ||
                  !!workspace.pending[agent.id] ||
                  clearingChat
                }
                onClick={() => setConfirmNewChat(true)}
                title="Clear this Orchestrator conversation and start fresh"
              >
                <MessageSquarePlus size={14} />
                New chat
              </button>
            </div>
            <AgentPanel
              key={agent.id}
              agent={agent}
              provider={provider!}
              modelName={
                workspace.models[agent.provider]?.models.find(
                  (m) => m.id === agent.model,
                )?.name ?? agent.model
              }
              coordinator
              compact={false}
              pinned={false}
              collapsed={false}
              pending={!!workspace.pending[agent.id]}
              error={workspace.chatErrors[agent.id]}
              onEdit={() => setSettings(true)}
              onPin={() => {}}
              onCollapse={() => {}}
              onFocus={() => {}}
              onMove={() => {}}
              send={(text, mode, messageId) =>
                workspace.send(agent.id, text, mode, messageId, {
                  orchestrator: true,
                  agentIds: scope,
                })
              }
              stop={() => workspace.stop(agent)}
              notify={workspace.setNotice}
            />
          </div>
          <aside className="orchestrator-context">
            <details className="team-guide" open={!active.length}>
              <summary>How delegation works</summary>
              <div className="team-guide-heading">
                <strong>Your workflow</strong>
                <button className="text-button" onClick={onNew}>
                  Add agent <ArrowRight size={13} />
                </button>
              </div>
              <ol>
                <li>Mark which agents are available to this project.</li>
                <li>Describe the goal; the Orchestrator sizes the team.</li>
                <li>
                  Review the team dashboard and approve its task proposals.
                  Vizor then delivers approved terminal tasks automatically.
                </li>
              </ol>
              <p>
                Orchestrator: API usage. Coding terminals: the account signed
                into each tool.
              </p>
            </details>
            <details className="context-picker" open>
              <summary>
                Available agents{" "}
                <span>
                  {scope.length} / {active.length}
                </span>
              </summary>
              <p>
                The Orchestrator chooses the smallest effective team from this
                list. API agents share conversation summaries; terminal agents
                return task reports automatically. Native CLI history stays
                private.
              </p>
              {active.length ? (
                <div className="context-agent-list">
                  {active.map((a) => (
                    <label key={a.id}>
                      <input
                        type="checkbox"
                        checked={scope.includes(a.id)}
                        disabled={!scope.includes(a.id) && scope.length >= 20}
                        onChange={(e) =>
                          setScope((old) =>
                            e.target.checked
                              ? [...old, a.id]
                              : old.filter((id) => id !== a.id),
                          )
                        }
                      />
                      <span>
                        {a.name}
                        <small>
                          {a.paused
                            ? "Paused"
                            : a.engine && a.engine !== "api"
                              ? `${a.engine === "codex" ? "Codex" : "Claude Code"} · ${a.terminalState === "running" ? "Running" : "Stopped"}`
                              : a.conversation.activeRunId
                                ? "Thinking"
                                : "Ready"}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <button className="secondary" onClick={onNew}>
                  Create your first agent
                </button>
              )}
            </details>
            <details className="team-dashboard" open>
              <summary>
                Agent dashboard <span>{active.length} agents</span>
              </summary>
              <p>Live assignments and reports for your full team.</p>
              <div className="team-dashboard-list">
                {active.map((worker) => {
                  const proposals = (workspace.data?.proposals ?? [])
                    .filter((item) => item.agentId === worker.id)
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                  const latest = proposals.find(
                    (item) => item.action === "send_message",
                  );
                  const dispatch = workspace.data?.terminalDispatches.find(
                    (item) =>
                      item.agentId === worker.id &&
                      item.status !== "superseded",
                  );
                  const dispatchProposal = dispatch
                    ? proposals.find((item) => item.id === dispatch.proposalId)
                    : undefined;
                  const apiRun = latest?.resultRunId
                    ? worker.conversation.runs.find(
                        (run) => run.id === latest.resultRunId,
                      )
                    : undefined;
                  const report =
                    workspace.orchestrator?.conversation.messages.some(
                      (message) =>
                        message.origin === "terminal_report" &&
                        message.proposalId === dispatch?.proposalId,
                    ) ||
                    (latest
                      ? workspace.orchestrator?.conversation.messages.some(
                          (message) =>
                            message.origin === "agent_report" &&
                            message.proposalId === latest.id,
                        )
                      : false);
                  const dispatchApprovalPending =
                    dispatchProposal?.status === "pending";
                  let status = "Available";
                  if (worker.paused) status = "Paused";
                  else if (worker.conversation.activeRunId) status = "Working";
                  else if (
                    latest?.status === "pending" ||
                    dispatchApprovalPending
                  )
                    status = "Needs approval";
                  else if (apiRun?.status === "running") status = "Working";
                  else if (report) status = "Report received";
                  else if (
                    apiRun?.status === "error" ||
                    apiRun?.status === "stopped"
                  )
                    status = "Needs follow-up";
                  else if (apiRun?.status === "complete")
                    status = "Completed · report pending";
                  else if (dispatch?.status === "ready")
                    status = "Ready to deliver";
                  else if (dispatch?.status === "claimed")
                    status = "Sending task";
                  else if (dispatch?.status === "delivered")
                    status =
                      worker.terminalState === "running"
                        ? "Terminal open · report pending"
                        : "Stopped · report missing";
                  else if (
                    worker.engine !== "api" &&
                    worker.terminalState === "running"
                  )
                    status = "Terminal open · idle";
                  const task =
                    dispatch?.text ??
                    (latest?.payload.action === "send_message"
                      ? latest.payload.text
                      : undefined);
                  return (
                    <button
                      className="team-dashboard-agent"
                      key={worker.id}
                      onClick={() => onFocus(worker.id)}
                    >
                      <span className="team-dashboard-agent-top">
                        <strong>{worker.name}</strong>
                        <small>{status}</small>
                      </span>
                      <span className="team-dashboard-meta">
                        {worker.engine === "codex"
                          ? "Codex"
                          : worker.engine === "claude-code"
                            ? "Claude Code"
                            : "API agent"}
                        {scope.includes(worker.id)
                          ? " · available"
                          : " · excluded"}
                      </span>
                      {task && (
                        <span className="team-dashboard-task">{task}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </details>
            <ProposalQueue workspace={workspace} compact onFocus={onFocus} />
          </aside>
        </div>
      )}
      {confirmNewChat && (
        <Dialog
          title="Start a new Orchestrator chat?"
          onClose={() => !clearingChat && setConfirmNewChat(false)}
        >
          <p>
            This clears the Orchestrator messages and summary, cancels its
            pending approvals, and retires tasks that were never sent or whose
            terminal is stopped without a report. Running terminals are left
            alone. Your agents and spending history stay. This can’t be undone.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={clearingChat}
              onClick={() => setConfirmNewChat(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={clearingChat}
              onClick={() => void startNewChat()}
            >
              {clearingChat ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <MessageSquarePlus size={15} />
              )}
              {clearingChat ? "Starting…" : "Clear chat and start fresh"}
            </button>
          </div>
        </Dialog>
      )}
      {settings && (
        <OrchestratorSettings
          workspace={workspace}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}
function OrchestratorSettings({
  workspace,
  onClose,
}: {
  workspace: WorkspaceState;
  onClose: () => void;
}) {
  const initial = workspace.orchestrator;
  const fallback = workspace.data!.providers.find((p) => p.connected)!;
  const [config, setConfig] = useState({
    provider: initial?.provider ?? fallback?.id ?? "anthropic",
    model: initial?.model ?? fallback?.defaultModel ?? "claude-sonnet-4-6",
    maxTokens: initial?.maxTokens ?? 2048,
    temperature: initial?.temperature ?? 0.4,
    projectInstructions:
      initial?.systemPrompt
        .split("\n\nProject instructions:\n")
        .slice(1)
        .join("\n\nProject instructions:\n") ?? "",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const models = workspace.models[config.provider];
  return (
    <Dialog title="Orchestrator settings" onClose={onClose}>
      <form
        className="proposal-edit-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api("orchestrator", "PATCH", config);
            await workspace.reload();
            workspace.setNotice(
              "Orchestrator is ready. Approval is required for every action.",
            );
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Provider
          <select
            aria-label="Orchestrator provider"
            value={config.provider}
            onChange={(e) => {
              const next = workspace.data!.providers.find(
                (p) => p.id === e.target.value,
              )!;
              setConfig({
                ...config,
                provider: next.id,
                model: next.defaultModel,
              });
            }}
          >
            {workspace.data?.providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.connected}>
                {p.label}
                {p.connected ? "" : " · connect key first"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select
            aria-label="Orchestrator model"
            value={config.model}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
          >
            {!models?.models.some((m) => m.id === config.model) && (
              <option value={config.model}>{config.model}</option>
            )}
            {models?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {models?.fallback && (
          <p className="field-note warning">Fallback list · {models.message}</p>
        )}
        <label>
          Maximum output tokens per model call
          <input
            type="number"
            min={64}
            max={8192}
            required
            value={config.maxTokens}
            onChange={(e) =>
              setConfig({ ...config, maxTokens: Number(e.target.value) })
            }
          />
        </label>
        <p className="field-note">
          A turn uses at most three model calls. Long plans can raise the first
          call’s output limit to prepare complete task proposals; all usage
          counts toward this provider’s spending limit.
        </p>
        <label>
          Project instructions
          <textarea
            aria-label="Orchestrator project instructions"
            rows={8}
            maxLength={12000}
            value={config.projectInstructions}
            onChange={(e) =>
              setConfig({ ...config, projectInstructions: e.target.value })
            }
            placeholder="Project goals, constraints, roles, and verification requirements…"
          />
          <small className="field-note">
            Saved with this orchestrator and included in each turn. Existing
            approvals and spending limits still apply.
          </small>
        </label>
        <div className="approval-explanation">
          <ShieldCheck size={17} />
          <p>
            The orchestrator drafts messages and agent changes. Use the approval
            queue to review them or turn on full auto approval.
          </p>
        </div>
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
            disabled={busy || !!initial?.conversation.activeRunId}
          >
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            Save orchestrator
          </button>
        </div>
      </form>
    </Dialog>
  );
}
