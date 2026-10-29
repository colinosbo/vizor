"use client";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
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
}: {
  workspace: WorkspaceState;
  onFocus: (id: string) => void;
}) {
  const [settings, setSettings] = useState(false);
  const active = workspace.agents.filter((a) => !a.archived);
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
  return (
    <div className="orchestrator-view">
      <div className="orchestrator-heading">
        <div>
          <div className="eyebrow">THE BIG PICTURE</div>
          <h1>One conversation. More perspective.</h1>
          <p>Your agents’ progress, and the next moves you approve.</p>
        </div>
        <span className="approval-only">
          <ShieldCheck size={14} />
          Autopilot off
        </span>
      </div>
      {!agent ? (
        <div className="welcome">
          <span className="welcome-mark">
            <Sparkles size={28} />
          </span>
          <h2>Meet your orchestrator.</h2>
          <p>
            Choose its model. It can summarize your agents and draft their next
            steps.
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
            <p>Connect a provider in API keys first.</p>
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
            <details className="context-picker" open>
              <summary>
                Agents in context <span>{scope.length} / 20</span>
              </summary>
              <p>
                API agents share a small local summary. Terminal agents share
                only their name, engine, project and running state; their
                terminal text is never shared with {provider?.label}.
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
                <p>Create an agent to add its progress.</p>
              )}
            </details>
            <ProposalQueue workspace={workspace} compact onFocus={onFocus} />
          </aside>
        </div>
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
          A turn uses at most three model calls to read summaries and prepare
          proposals. All calls count toward this provider’s spending limit.
        </p>
        <div className="approval-explanation">
          <ShieldCheck size={17} />
          <p>
            Approval required. The orchestrator can draft messages and agent
            changes; it cannot execute them on its own.
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
