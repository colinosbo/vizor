"use client";
import { useRef, useState } from "react";
import {
  Archive,
  BookmarkPlus,
  Check,
  Copy,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import type { AgentConfig, AgentView, ProviderInfo } from "@/lib/types";
import { api, type ModelList } from "./use-workspace";
import { money, useFocusTrap } from "./ui";
export const baseConfig: AgentConfig = {
  name: "My assistant",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "You are a thoughtful, practical assistant. Be clear, accurate, and concise. Ask when essential information is missing.",
  temperature: 0.7,
  maxTokens: 2048,
  color: "mint",
  icon: "spark",
};
export function agentConfig(agent: AgentView): AgentConfig {
  return {
    name: agent.name,
    engine: agent.engine ?? "api",
    projectPath: agent.projectPath ?? "",
    provider: agent.provider,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    color: agent.color,
    icon: agent.icon,
  };
}
export function AgentEditor({
  agent,
  initial,
  providers,
  models,
  refreshModels,
  onClose,
  onSaved,
  onAction,
  notify,
}: {
  agent?: AgentView;
  initial: AgentConfig;
  providers: ProviderInfo[];
  models: Record<string, ModelList>;
  refreshModels: (id: string) => Promise<void>;
  onClose: () => void;
  onSaved: (id?: string) => Promise<void>;
  onAction: (
    id: string,
    action: "duplicate" | "archive" | "pause" | "resume",
  ) => Promise<void>;
  notify: (value: string) => void;
}) {
  const [config, setConfig] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const desktop =
    typeof window !== "undefined" && !!window.vizorDesktop?.terminals;
  const terminal = config.engine && config.engine !== "api";
  const [template, setTemplate] = useState(false);
  const [templateName, setTemplateName] = useState(agent?.name ?? "");
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, onClose);
  const provider = providers.find((p) => p.id === config.provider);
  const list = models[config.provider];
  const model = list?.models.find((m) => m.id === config.model);
  const active = !!agent?.conversation.activeRunId;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (agent) {
        await api(`agents/${agent.id}`, "PATCH", config);
        await onSaved();
      } else {
        const result = await api<{ id: string }>("agents", "POST", config);
        await onSaved(result.id);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="drawer-scrim"
        aria-label="Close agent settings"
        onClick={onClose}
      />
      <aside
        ref={ref}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={agent ? "Agent settings" : "New agent"}
      >
        <div className="panel-heading">
          <div>
            <div className="eyebrow">MAKE IT YOURS</div>
            <h2>{agent ? "Agent settings" : "New agent"}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close agent settings"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <form className="editor-form" onSubmit={save}>
          <div className="settings-scroll">
            <label>
              Agent name
              <input
                value={config.name}
                maxLength={70}
                required
                onChange={(e) => setConfig({ ...config, name: e.target.value })}
              />
            </label>
            <div className="field-row">
              <label>
                Icon
                <select
                  aria-label="Icon"
                  value={config.icon}
                  onChange={(e) =>
                    setConfig({ ...config, icon: e.target.value })
                  }
                >
                  <option value="spark">Sparkles</option>
                  <option value="code">Code</option>
                  <option value="pen">Writing</option>
                  <option value="search">Research</option>
                </select>
              </label>
              <label>
                Colour
                <select
                  aria-label="Colour"
                  value={config.color}
                  onChange={(e) =>
                    setConfig({ ...config, color: e.target.value })
                  }
                >
                  <option value="mint">Mint</option>
                  <option value="amber">Amber</option>
                  <option value="blue">Blue</option>
                  <option value="rose">Rose</option>
                </select>
              </label>
            </div>
            <div className="settings-divider" />
            <label>
              Engine
              <select
                aria-label="Engine"
                value={config.engine ?? "api"}
                disabled={!!agent}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    engine: e.target.value as AgentConfig["engine"],
                    icon: e.target.value === "api" ? "spark" : "code",
                  })
                }
              >
                <option value="api">API connection</option>
                <option value="claude-code" disabled={!desktop}>
                  Claude Code{desktop ? "" : " · Windows app"}
                </option>
                <option value="codex" disabled={!desktop}>
                  Codex{desktop ? "" : " · Windows app"}
                </option>
              </select>
            </label>
            {terminal && (
              <label>
                Project folder
                <div className="terminal-folder">
                  <input
                    aria-label="Project folder"
                    value={config.projectPath ?? ""}
                    readOnly
                    placeholder="Choose a local folder"
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={!!agent}
                    onClick={async () => {
                      const selected =
                        await window.vizorDesktop?.terminals?.chooseFolder();
                      if (selected)
                        setConfig({ ...config, projectPath: selected });
                    }}
                  >
                    Browse
                  </button>
                </div>
                <small>
                  The CLI handles its own sign-in, model, permissions and
                  history. Use a new agent for a different project.
                </small>
              </label>
            )}
            {!terminal && (
              <>
                <label>
                  Provider
                  <select
                    aria-label="Provider"
                    value={config.provider}
                    onChange={(e) => {
                      const next = providers.find(
                        (p) => p.id === e.target.value,
                      )!;
                      setConfig({
                        ...config,
                        provider: next.id,
                        model:
                          models[next.id]?.models.find(
                            (m) => m.id === next.defaultModel,
                          )?.id ??
                          models[next.id]?.models[0]?.id ??
                          next.defaultModel,
                      });
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.connected}>
                        {p.label}
                        {p.connected ? "" : " · connect key first"}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field-heading">
                  <span>Model</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void refreshModels(config.provider)}
                    disabled={!provider?.connected}
                  >
                    <RotateCcw size={11} />
                    Refresh
                  </button>
                </div>
                <label>
                  <span className="sr-only">Model</span>
                  <select
                    aria-label="Model"
                    value={config.model}
                    onChange={(e) =>
                      setConfig({ ...config, model: e.target.value })
                    }
                  >
                    {!list?.models.some((m) => m.id === config.model) && (
                      <option value={config.model}>
                        {config.model} · current
                      </option>
                    )}
                    {list?.models.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                {list?.fallback && (
                  <div className="field-note warning">
                    Fallback list · {list.message}
                  </div>
                )}
                <label>
                  System prompt
                  <textarea
                    aria-label="System prompt"
                    rows={6}
                    maxLength={16000}
                    value={config.systemPrompt}
                    onChange={(e) =>
                      setConfig({ ...config, systemPrompt: e.target.value })
                    }
                  />
                  <small>Give your agent a role and a way to work.</small>
                </label>
                <label>
                  <span className="range-heading">
                    Temperature<span>{config.temperature.toFixed(1)}</span>
                  </span>
                  <input
                    aria-label="Temperature"
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    disabled={!model?.temperature}
                    value={config.temperature}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        temperature: Number(e.target.value),
                      })
                    }
                  />
                  <small>
                    {model?.temperature
                      ? "Lower is more focused. Higher is more exploratory."
                      : "Temperature is managed by this model."}
                  </small>
                </label>
                <label>
                  Maximum output tokens
                  <input
                    type="number"
                    min={64}
                    max={8192}
                    step={1}
                    required
                    value={config.maxTokens}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        maxTokens: Number(e.target.value),
                      })
                    }
                  />
                </label>
                {active && (
                  <p className="field-note warning">
                    Stop the current response before changing settings.
                  </p>
                )}
                {!provider?.connected && (
                  <p className="field-note warning">
                    Connect this provider in API keys before saving.
                  </p>
                )}
              </>
            )}
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            {agent && (
              <>
                {!terminal && (
                  <div className="usage-details">
                    <div className="eyebrow">THIS CONVERSATION</div>
                    <div>
                      <span>Reported tokens</span>
                      <strong>
                        {agent.conversation.runs
                          .reduce(
                            (n, r) =>
                              n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
                            0,
                          )
                          .toLocaleString()}
                      </strong>
                    </div>
                    <div>
                      <span>Estimated cost</span>
                      <strong>
                        {money(
                          agent.conversation.runs.reduce(
                            (n, r) => n + (r.cost ?? 0),
                            0,
                          ),
                        )}
                        {agent.conversation.runs.some(
                          (r) => r.cost == null || !r.usageComplete,
                        )
                          ? " + unknown"
                          : ""}
                      </strong>
                    </div>
                  </div>
                )}
                <div className="editor-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || (!terminal && !provider?.connected)}
                    onClick={() =>
                      void onAction(agent.id, "duplicate").catch((e) =>
                        setError(e.message),
                      )
                    }
                  >
                    <Copy size={14} />
                    Duplicate agent
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void onAction(
                        agent.id,
                        agent.paused ? "resume" : "pause",
                      ).catch((e) => setError(e.message))
                    }
                  >
                    {agent.paused ? <Play size={14} /> : <Pause size={14} />}
                    {agent.paused ? "Resume agent" : "Pause agent"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setTemplate(!template)}
                  >
                    <BookmarkPlus size={14} />
                    Save as template
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    onClick={() =>
                      void onAction(agent.id, "archive")
                        .then(onClose)
                        .catch((e) => setError(e.message))
                    }
                  >
                    <Archive size={14} />
                    Archive agent
                  </button>
                </div>
                {template && (
                  <div className="template-inline">
                    <label>
                      Template name
                      <input
                        value={templateName}
                        maxLength={70}
                        onChange={(e) => setTemplateName(e.target.value)}
                      />
                    </label>
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy || !templateName.trim()}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api("templates", "POST", {
                            name: templateName,
                            agentId: agent.id,
                            config,
                          });
                          setTemplate(false);
                          await onSaved();
                          notify("Template saved.");
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Save template
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="panel-footer">
            <button
              className="primary"
              disabled={
                busy ||
                active ||
                (terminal ? !config.projectPath : !provider?.connected)
              }
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Check size={16} />
              )}
              {agent ? "Save changes" : "Create agent"}
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
