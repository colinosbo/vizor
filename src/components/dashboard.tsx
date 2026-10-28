"use client";
import { useState } from "react";
import {
  Archive,
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { AgentConfig, AgentView } from "@/lib/types";
import { AgentEditor, agentConfig, baseConfig } from "./agent-editor";
import { AgentIcon, Mark, money, ProviderGlyph } from "./ui";
import { api, useWorkspace } from "./use-workspace";
import { ProviderSettings } from "./provider-settings";
import { WorkspaceBoard } from "./workspace-board";
import { agentStatus } from "./agent-panel";
export default function Dashboard() {
  const workspace = useWorkspace();
  const {
    data,
    agents,
    loading,
    auth,
    reload,
    error,
    setError,
    notice,
    setNotice,
    models,
    refreshModels,
    layout,
    updateLayout,
  } = workspace;
  const [view, setView] = useState<
    "workspace" | "keys" | "templates" | "archive"
  >("workspace");
  const [mobileNav, setMobileNav] = useState(false);
  const [editor, setEditor] = useState<{
    id?: string;
    initial: AgentConfig;
  } | null>(null);
  const connected = data?.providers.some((p) => p.connected) ?? false;
  const active = agents.filter((a) => !a.archived);
  const selected = active.find((a) => a.id === layout.activeId) ?? active[0];
  const runs = agents.flatMap((agent) => agent.conversation.runs);
  const totalTokens = runs.reduce(
    (n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
    0,
  );
  const totalCost = runs.reduce((n, r) => n + (r.cost ?? 0), 0);
  const unknown = runs.some((r) => r.cost == null || !r.usageComplete);
  function navigate(next: typeof view) {
    setView(next);
    setMobileNav(false);
  }
  function newConfig(): AgentConfig {
    const provider =
      data?.providers.find((p) => p.connected) ?? data?.providers[0];
    const model = provider
      ? (models[provider.id]?.models.find((m) => m.id === provider.defaultModel)
          ?.id ??
        models[provider.id]?.models[0]?.id ??
        provider.defaultModel)
      : baseConfig.model;
    return {
      ...baseConfig,
      provider: provider?.id ?? "anthropic",
      model,
      name: active.length ? "New agent" : "My assistant",
    };
  }
  function newAgent() {
    setEditor({ initial: newConfig() });
    setMobileNav(false);
  }
  function select(id: string) {
    updateLayout({ ...layout, activeId: id });
    navigate("workspace");
  }
  async function onSaved(id?: string) {
    const next = await reload();
    if (id) {
      const count =
        next?.agents.filter((a) => !a.archived).length ?? active.length + 1;
      updateLayout({
        ...layout,
        activeId: id,
        order: [...layout.order.filter((value) => value !== id), id],
        mode: layout.mode === "1" && count === 2 ? "2" : layout.mode,
      });
      setView("workspace");
    }
    setNotice(id ? "Agent created." : "Agent settings saved.");
  }
  async function action(
    id: string,
    name: "duplicate" | "archive" | "pause" | "resume" | "restore",
  ) {
    const result = await api<{ id: string }>(`agents/${id}/${name}`, "POST");
    if (name === "duplicate") await onSaved(result.id);
    else {
      await reload();
      setNotice(
        name === "archive"
          ? "Agent archived. Its history is saved."
          : name === "restore"
            ? "Agent restored."
            : name === "pause"
              ? "Agent paused."
              : "Agent resumed.",
      );
    }
  }
  async function openWorkspace() {
    try {
      if (!active.length) {
        const result = await api<{ id: string }>("agents", "POST", newConfig());
        await onSaved(result.id);
      } else navigate("workspace");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (auth) return <AuthForm onLogin={reload} />;
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <a href="/" className="brand" aria-label="Vizor home">
          <Mark />
          <span>
            vizor<span className="brand-dot">.</span>
          </span>
          <span className="version">BETA</span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-avatar">V</span>
          <div>
            <strong>Personal workspace</strong>
            <small>
              {data?.selfHost === false ? "Private account" : "Local workspace"}
            </small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <button
          className={`nav-item ${view === "workspace" ? "active" : ""}`}
          onClick={() => navigate("workspace")}
        >
          <MessageSquare size={17} />
          Conversations<span className="nav-number">{active.length}</span>
        </button>
        <button
          className={`nav-item ${view === "keys" ? "active" : ""}`}
          onClick={() => navigate("keys")}
        >
          <KeyRound size={17} />
          API keys{connected && <span className="tiny-dot" />}
        </button>
        <button
          className={`nav-item ${view === "templates" ? "active" : ""}`}
          onClick={() => navigate("templates")}
        >
          <Bookmark size={17} />
          Templates
          {data?.templates.length ? (
            <span className="nav-number">{data.templates.length}</span>
          ) : null}
        </button>
        <button
          className={`nav-item ${view === "archive" ? "active" : ""}`}
          onClick={() => navigate("archive")}
        >
          <Archive size={17} />
          Archive
          {agents.some((a) => a.archived) && (
            <span className="nav-number">
              {agents.filter((a) => a.archived).length}
            </span>
          )}
        </button>
        <div className="agent-caption">
          <span>YOUR AGENTS</span>
          <button
            className="icon-button"
            aria-label="Create agent"
            title="Create agent"
            onClick={newAgent}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="agent-list">
          {[...active]
            .sort(
              (a, b) =>
                Number(layout.pinned.includes(b.id)) -
                Number(layout.pinned.includes(a.id)),
            )
            .map((agent) => (
              <button
                className={`agent-nav ${view === "workspace" && agent.id === selected?.id ? "selected" : ""}`}
                key={agent.id}
                onClick={() => select(agent.id)}
              >
                <span className={`agent-symbol ${agent.color}`}>
                  <AgentIcon icon={agent.icon} size={16} />
                </span>
                <span className="agent-nav-name">
                  {agent.name}
                  <small>
                    {
                      data?.providers.find((p) => p.id === agent.provider)
                        ?.label
                    }{" "}
                    · {agentStatus(agent, workspace.pending[agent.id])}
                  </small>
                </span>
                <span
                  className={`agent-dot ${agent.conversation.activeRunId ? "working" : ""}`}
                />
              </button>
            ))}
          {!active.length && (
            <div className="empty-sidebar">
              A fresh start.
              <br />
              <span>Your agents will live here.</span>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={16} />
            <div>
              Private by default<small>Stored on this computer</small>
            </div>
          </div>
          <div className="profile">
            <span className="profile-avatar">
              {data?.selfHost === false ? data.email[0].toUpperCase() : "Y"}
            </span>
            <div>
              <strong>
                {data?.selfHost === false ? data.email : "Your workspace"}
              </strong>
              <small>
                <span className="tiny-dot" />
                {data?.selfHost === false ? "Signed in" : "Running locally"}
              </small>
            </div>
            {data?.selfHost === false ? (
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={() =>
                  void workspace.logout().catch((e) => setError(e.message))
                }
              >
                <LogOut size={16} />
              </button>
            ) : (
              <span className="local-tag">LOCAL</span>
            )}
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-icon">
              <MessageSquare size={15} />
            </span>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {view === "workspace"
                ? "Conversations"
                : view === "keys"
                  ? "API keys"
                  : view === "templates"
                    ? "Templates"
                    : "Archive"}
            </strong>
          </div>
          <div className="topbar-right">
            {data?.providers
              .filter((p) => p.connected)
              .map((provider) => (
                <span key={provider.id} className="provider-indicator">
                  <ProviderGlyph id={provider.id} size={13} />
                  {provider.label}
                  <span className="tiny-dot" />
                </span>
              ))}
            <span className="private-pill">
              <span className="tiny-dot" />
              Private workspace
            </span>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Check size={16} />
            {notice}
          </div>
        )}
        {loading ? (
          <div className="loading-state">
            <Mark />
            <LoaderCircle className="spin" size={20} />
            <span>Opening your workspace…</span>
          </div>
        ) : !data ? (
          <div className="loading-state">
            <h1>Workspace unavailable</h1>
            <button className="primary" onClick={() => void reload()}>
              Try again
            </button>
          </div>
        ) : view === "keys" || (!connected && !agents.length) ? (
          <ProviderSettings
            providers={data.providers}
            onChange={async () => {
              setView("keys");
              await reload();
            }}
            openWorkspace={openWorkspace}
            onError={setError}
          />
        ) : view === "templates" ? (
          <div className="collection-view">
            <div className="page-eyebrow">
              <span className="eyebrow-line" />
              YOUR REUSABLE ROLES
            </div>
            <h1>A good starting point.</h1>
            <p>
              Save an agent’s setup from its settings. Start fresh with the same
              role.
            </p>
            {!data.templates.length ? (
              <div className="collection-empty">
                <Bookmark size={28} />
                <h2>No templates yet.</h2>
                <p>Open an agent’s settings and choose Save as template.</p>
              </div>
            ) : (
              <div className="collection-grid">
                {data.templates.map((template) => (
                  <section className="template-card" key={template.id}>
                    <span className={`agent-symbol ${template.config.color}`}>
                      <AgentIcon icon={template.config.icon} />
                    </span>
                    <h2>{template.name}</h2>
                    <span className="template-model">
                      {
                        data.providers.find(
                          (p) => p.id === template.config.provider,
                        )?.label
                      }{" "}
                      · {template.config.model}
                    </span>
                    <p>{template.config.systemPrompt || "No system prompt"}</p>
                    <div>
                      <button
                        className="secondary"
                        onClick={() =>
                          setEditor({
                            initial: {
                              ...template.config,
                              name: template.name,
                            },
                          })
                        }
                      >
                        <Plus size={14} />
                        Use template
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete template ${template.name}`}
                        onClick={() =>
                          void api(`templates/${template.id}`, "DELETE")
                            .then(reload)
                            .catch((e) => setError(e.message))
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        ) : view === "archive" ? (
          <div className="collection-view">
            <div className="page-eyebrow">
              <span className="eyebrow-line" />
              KEEP THE CONTEXT
            </div>
            <h1>On the shelf.</h1>
            <p>
              Archived agents keep their conversations. Restore them whenever
              you need.
            </p>
            {!agents.some((a) => a.archived) ? (
              <div className="collection-empty">
                <Archive size={28} />
                <h2>No archived agents.</h2>
              </div>
            ) : (
              <div className="archive-list">
                {agents
                  .filter((a) => a.archived)
                  .map((agent) => (
                    <section key={agent.id}>
                      <span className={`agent-symbol ${agent.color}`}>
                        <AgentIcon icon={agent.icon} />
                      </span>
                      <div>
                        <h2>{agent.name}</h2>
                        <p>
                          {agent.model} · {agent.conversation.messages.length}{" "}
                          messages
                        </p>
                      </div>
                      <button
                        className="secondary"
                        onClick={() =>
                          void action(agent.id, "restore").catch((e) =>
                            setError(e.message),
                          )
                        }
                      >
                        <RotateCcw size={14} />
                        Restore agent
                      </button>
                    </section>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <WorkspaceBoard
            workspace={workspace}
            onNew={newAgent}
            onEdit={(agent) =>
              setEditor({ id: agent.id, initial: agentConfig(agent) })
            }
          />
        )}
        {data && (
          <footer className="workspace-footer">
            <span className="footer-status">
              <span className="tiny-dot" />
              {workspace.connected ? "Live workspace" : "Reconnecting…"}
            </span>
            <span>
              {totalTokens.toLocaleString()} reported tokens
              <span className="footer-separator">/</span>
              {runs.length
                ? `${money(totalCost)}${unknown ? " + unknown" : ""} estimated`
                : "No usage yet"}
              <span className="footer-separator">/</span>
              <span title={`Text prices checked ${data.pricingDate}`}>USD</span>
            </span>
          </footer>
        )}
        {editor && data && (
          <AgentEditor
            key={editor.id ?? "new"}
            agent={agents.find((a) => a.id === editor.id)}
            initial={editor.initial}
            providers={data.providers}
            models={models}
            refreshModels={refreshModels}
            onClose={() => setEditor(null)}
            onSaved={onSaved}
            onAction={action}
            notify={setNotice}
          />
        )}
      </main>
    </div>
  );
}
function AuthForm({ onLogin }: { onLogin: () => Promise<unknown> }) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <Mark />
        <span>
          vizor<span className="brand-dot">.</span>
        </span>
      </div>
      <form
        className="auth-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const form = new FormData(event.currentTarget);
          try {
            await api(`auth/${register ? "register" : "login"}`, "POST", {
              email: form.get("email"),
              password: form.get("password"),
            });
            await onLogin();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="eyebrow">YOUR PRIVATE WORKSPACE</div>
        <h1>{register ? "Make room for ideas." : "Welcome back."}</h1>
        <p>
          {register
            ? "Create an account to keep your agents and conversations together."
            : "Sign in to pick up where you left off."}
        </p>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            minLength={register ? 12 : 1}
            maxLength={128}
            required
            autoComplete={register ? "new-password" : "current-password"}
          />
        </label>
        {register && <small>Use at least 12 characters.</small>}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <button className="primary" disabled={busy}>
          {busy && <LoaderCircle className="spin" size={16} />}{" "}
          {register ? "Create account" : "Sign in"}
          <ArrowRight size={16} />
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setRegister(!register);
            setError("");
          }}
        >
          {register
            ? "Already have an account? Sign in"
            : "New here? Create an account"}
        </button>
      </form>
      <div className="auth-foot">
        <ShieldCheck size={14} />
        Your keys. Your conversations. Your space.
      </div>
    </div>
  );
}
