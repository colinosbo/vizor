"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  Bot,
  ClipboardCheck,
  History,
  Wallet,
  ArrowRight,
  Bookmark,
  Check,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  RotateCcw,
  ShieldCheck,
  Settings2,
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
import { OrchestratorPanel } from "./orchestrator-panel";
import { ProposalQueue } from "./proposal-queue";
import { SpendingView } from "./spending-view";
import { AuditHistory } from "./audit-view";
import { DesktopUpdates } from "./desktop-updates";
import { StartupIntro } from "./startup-intro";
export default function Dashboard() {
  const [introVisible, setIntroVisible] = useState(true);
  const finishIntro = useCallback(() => setIntroVisible(false), []);
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
    | "workspace"
    | "keys"
    | "templates"
    | "archive"
    | "orchestrator"
    | "proposals"
    | "spending"
    | "audit"
    | "settings"
  >("workspace");
  const settingsPages = [
    {
      id: "keys",
      label: "API keys",
      description: "Connect providers and manage your saved keys.",
      icon: KeyRound,
    },
    {
      id: "spending",
      label: "Spending limits",
      description: "Set API budgets and review usage.",
      icon: Wallet,
    },
    {
      id: "audit",
      label: "Audit history",
      description: "Review actions and approval decisions.",
      icon: History,
    },
    {
      id: "templates",
      label: "Templates",
      description: "Manage reusable agent configurations.",
      icon: Bookmark,
    },
    {
      id: "archive",
      label: "Archive",
      description: "Find and restore archived agents.",
      icon: Archive,
    },
  ] as const;
  const inSettings =
    view === "settings" || settingsPages.some((page) => page.id === view);
  const [mobileNav, setMobileNav] = useState(false);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(!!window.vizorDesktop?.terminals), []);
  const [editor, setEditor] = useState<{
    id?: string;
    initial: AgentConfig;
  } | null>(null);
  const connected = data?.providers.some((p) => p.connected) ?? false;
  const active = agents.filter((a) => !a.archived);
  const selected = active.find((a) => a.id === layout.activeId) ?? active[0];
  const runs = [
    ...agents,
    ...(workspace.orchestrator ? [workspace.orchestrator] : []),
  ].flatMap((agent) => agent.conversation.runs);
  const initialView = useRef(false);
  useEffect(() => {
    if (data && !initialView.current) {
      initialView.current = true;
      if (data.orchestrator) setView("orchestrator");
    }
  }, [data]);
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
      engine: desktop && !connected ? "claude-code" : "api",
      projectPath: "",
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
    const terminal = window.vizorDesktop?.terminals;
    if (
      terminal &&
      ["archive", "pause"].includes(name) &&
      agents.find((a) => a.id === id)?.engine !== "api"
    ) {
      const snapshot = await terminal.snapshot(id);
      if (snapshot.state === "running" && snapshot.token)
        await terminal.stop(id, snapshot.token);
    }
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
      if (!active.length && !desktop) {
        const result = await api<{ id: string }>("agents", "POST", newConfig());
        await onSaved(result.id);
      } else navigate("workspace");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const content = auth ? (
    <div
      inert={introVisible}
      className={introVisible ? "startup-pending" : undefined}
    >
      <AuthForm onLogin={reload} />
    </div>
  ) : (
    <div
      className={`app-shell${introVisible ? " startup-pending" : ""}`}
      inert={introVisible}
    >
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
          <span className="version">{desktop ? "DESKTOP" : "LOCAL"}</span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-avatar">V</span>
          <div>
            <strong>Personal workspace</strong>
            <small>
              {data?.selfHost === false ? "Private account" : "Local workspace"}
            </small>
          </div>
        </div>
        <button
          className="primary sidebar-create"
          aria-label="Create new agent"
          onClick={newAgent}
        >
          <Plus size={16} /> New agent
        </button>
        <div className="nav-caption">WORKSPACE</div>
        <button
          className={`nav-item ${view === "orchestrator" ? "active" : ""}`}
          onClick={() => navigate("orchestrator")}
        >
          <Bot size={17} />
          Orchestrator
          <span className="approval-dot" title="Approval required" />
        </button>
        <button
          className={`nav-item ${view === "workspace" ? "active" : ""}`}
          onClick={() => navigate("workspace")}
        >
          <MessageSquare size={17} />
          Agent board<span className="nav-number">{active.length}</span>
        </button>
        <button
          className={`nav-item ${view === "proposals" ? "active" : ""}`}
          onClick={() => navigate("proposals")}
        >
          <ClipboardCheck size={17} />
          Approvals
          {data?.proposals.some((p) => p.status === "pending") && (
            <span className="nav-number">{data.pendingProposalCount}</span>
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
        <div
          className="agent-list"
          tabIndex={0}
          role="region"
          aria-label="Your agents"
        >
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
                    {agent.engine && agent.engine !== "api"
                      ? agent.engine === "codex"
                        ? "Codex"
                        : "Claude Code"
                      : data?.providers.find((p) => p.id === agent.provider)
                          ?.label}{" "}
                    ·{" "}
                    {agent.engine && agent.engine !== "api"
                      ? agent.terminalState === "running"
                        ? "Running"
                        : "Stopped"
                      : agentStatus(agent, workspace.pending[agent.id])}
                  </small>
                </span>
                <span
                  className={`agent-dot ${agent.conversation.activeRunId || agent.terminalState === "running" ? "working" : ""}`}
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
          <button
            className={`nav-item ${inSettings ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={17} />
            Settings
          </button>
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
            {inSettings && view !== "settings" ? (
              <button
                className="text-button"
                aria-label="Back to settings"
                onClick={() => navigate("settings")}
              >
                Settings
              </button>
            ) : (
              <span>Workspace</span>
            )}
            <ChevronRight size={13} />
            <strong>
              {view === "settings"
                ? "Settings"
                : view === "orchestrator"
                  ? "Orchestrator"
                  : view === "proposals"
                    ? "Approvals"
                    : view === "spending"
                      ? "Spending limits"
                      : view === "audit"
                        ? "Audit history"
                        : view === "workspace"
                          ? "Agent board"
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
        <DesktopUpdates />
        {!!data?.budgets.some((budget) => budget.warning) && (
          <div className="budget-banner" role="status">
            <ShieldCheck size={15} />
            <span>
              {data.budgets
                .filter((budget) => budget.warning)
                .map(
                  (budget) =>
                    `${budget.label}: ${budget.blocked ? "new generations blocked" : "80% of budget used or reserved"}`,
                )
                .join(" · ")}
            </span>
            <button
              className="text-button"
              onClick={() => navigate("spending")}
            >
              Review spending limits
              <ChevronRight size={13} />
            </button>
          </div>
        )}
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
        ) : view === "settings" ? (
          <div className="collection-view settings-view">
            <div className="page-eyebrow">YOUR WORKSPACE</div>
            <h1>Settings</h1>
            <p>Connections, budgets, and workspace management.</p>
            <div className="settings-grid">
              {settingsPages.map(({ id, label, description, icon: Icon }) => (
                <button
                  key={id}
                  className="settings-card"
                  aria-label={label}
                  onClick={() => navigate(id)}
                >
                  <Icon size={21} />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          </div>
        ) : view === "keys" ||
          (view === "workspace" && !desktop && !connected && !agents.length) ? (
          <ProviderSettings
            providers={data.providers}
            onChange={async () => {
              setView("keys");
              await reload();
            }}
            openWorkspace={openWorkspace}
            onError={setError}
          />
        ) : view === "orchestrator" ? (
          <OrchestratorPanel
            workspace={workspace}
            onFocus={select}
            onNew={newAgent}
            onConnections={() => navigate("keys")}
          />
        ) : view === "proposals" ? (
          <ProposalQueue workspace={workspace} onFocus={select} />
        ) : view === "spending" ? (
          <SpendingView workspace={workspace} />
        ) : view === "audit" ? (
          <AuditHistory workspace={workspace} />
        ) : view === "templates" ? (
          <div className="collection-view">
            <div className="page-eyebrow">
              <span className="eyebrow-line" />
              YOUR REUSABLE ROLES
            </div>
            <h1>Agent templates</h1>
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
            <h1>Archived agents</h1>
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
                          {agent.engine && agent.engine !== "api"
                            ? `${agent.engine === "codex" ? "Codex" : "Claude Code"} · Saved terminal session`
                            : `${agent.model} · ${agent.conversation.messages.length} messages`}
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
              API · {totalTokens.toLocaleString()} reported tokens
              <span className="footer-separator">/</span>
              {runs.length
                ? `${money(totalCost)}${unknown ? " + unknown" : ""} estimated`
                : "No API usage yet"}
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
  return (
    <>
      <StartupIntro ready={!loading} onComplete={finishIntro} />
      {content}
    </>
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
