"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  PenLine,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentView,
  ProviderModel,
  PublicMessage,
  Workspace,
} from "@/lib/types";
type Config = Pick<
  AgentView,
  | "name"
  | "model"
  | "systemPrompt"
  | "temperature"
  | "maxTokens"
  | "color"
  | "icon"
>;
const blank: Config = {
  name: "My assistant",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "You are a thoughtful, practical assistant. Be clear, accurate, and concise. Ask when essential information is missing.",
  temperature: 0.7,
  maxTokens: 2048,
  color: "mint",
  icon: "spark",
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T = unknown>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(result.message ?? "Please try again.", response.status);
  return result;
}
function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      width={small ? 26 : 34}
      height={small ? 26 : 34}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 10.5 18 4l13 6.5V25l-13 7L5 25V10.5Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="m10 13 8 13 8-13M18 26V14"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Claude({ size = 23 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        {Array.from({ length: 10 }, (_, i) => (
          <path key={i} d="M14 3v7" transform={`rotate(${i * 36} 14 14)`} />
        ))}
      </g>
    </svg>
  );
}
function AgentIcon({ icon, size = 17 }: { icon: string; size?: number }) {
  const Icon =
    icon === "code"
      ? Code2
      : icon === "pen"
        ? PenLine
        : icon === "search"
          ? Search
          : Sparkles;
  return <Icon size={size} />;
}
function money(value: number) {
  return `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
}
export default function Dashboard() {
  const [data, setData] = useState<Workspace | null>(null);
  const [auth, setAuth] = useState(false);
  const [register, setRegister] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"workspace" | "keys">("workspace");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [config, setConfig] = useState<Config>(blank);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [fallback, setFallback] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [liveUsage, setLiveUsage] = useState<{
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
  } | null>(null);
  const [edit, setEdit] = useState<PublicMessage | null>(null);
  const [editText, setEditText] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const agent = data?.agents.find((a) => a.id === selected) ?? data?.agents[0];
  const load = useCallback(async () => {
    try {
      const next = await api<Workspace>("workspace");
      setData(next);
      setAuth(false);
      return next;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuth(true);
        setRegister(false);
      } else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const refreshModels = useCallback(async () => {
    try {
      const result = await api<{
        models: ProviderModel[];
        fallback: boolean;
        message?: string;
      }>("providers/anthropic/models");
      setModels(result.models);
      setFallback(result.fallback ? `Fallback list · ${result.message}` : "");
    } catch (e) {
      setFallback((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  useEffect(() => {
    if (data?.provider.connected) void refreshModels();
  }, [data?.provider.connected, refreshModels]);
  useEffect(() => {
    if (agent) {
      setConfig({
        name: agent.name,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        color: agent.color,
        icon: agent.icon,
      });
      setMessages(agent.conversation.messages);
      setRunId(agent.conversation.activeRunId);
    }
  }, [agent]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    if (!settings) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = settingsRef.current;
    const items = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea, select",
        ) ?? [],
      );
    panel?.querySelector<HTMLInputElement>("input")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettings(false);
        setCreating(false);
      }
      if (event.key === "Tab") {
        const all = items();
        const first = all[0];
        const last = all.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [settings]);
  useEffect(() => {
    if (!runId || streaming) return;
    const timer = setInterval(() => void load(), 1200);
    return () => clearInterval(timer);
  }, [runId, streaming, load]);
  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api(`auth/${register ? "register" : "login"}`, "POST", {
        email: form.get("email"),
        password: form.get("password"),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveAgent() {
    setBusy(true);
    setError("");
    try {
      if (creating || !agent) {
        const result = await api<{ id: string }>("agents", "POST", config);
        setSelected(result.id);
      } else await api(`agents/${agent.id}`, "PATCH", config);
      await load();
      setCreating(false);
      setSettings(false);
      setNotice("Agent settings saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openWorkspace() {
    setBusy(true);
    setError("");
    try {
      if (!data?.agents.length) {
        const result = await api<{ id: string }>("agents", "POST", {
          ...blank,
          model:
            models.find((m) => m.id === blank.model)?.id ??
            models[0]?.id ??
            blank.model,
        });
        setSelected(result.id);
      }
      await load();
      setView("workspace");
      setNotice("Your workspace is ready.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(
    text = draft,
    mode: "send" | "edit" | "regenerate" = "send",
    edited?: PublicMessage,
  ) {
    if (!agent || streaming || runId || (mode !== "regenerate" && !text.trim()))
      return;
    setError("");
    setLiveUsage(null);
    setStreaming(true);
    setDraft("");
    setEdit(null);
    const target = agent.id;
    const abort = new AbortController();
    controller.current = abort;
    if (mode === "send")
      setMessages((prev) => [
        ...prev,
        {
          id: "optimistic",
          role: "user",
          text: text.trim(),
          status: "complete",
          createdAt: new Date().toISOString(),
        },
      ]);
    if (mode === "edit" && edited)
      setMessages((prev) => [
        ...prev.slice(
          0,
          prev.findIndex((m) => m.id === edited.id),
        ),
        { ...edited, text },
      ]);
    if (mode === "regenerate") setMessages((prev) => prev.slice(0, -1));
    let assistantId = "";
    let gotDone = false;
    try {
      const response = await fetch(`/api/agents/${target}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: crypto.randomUUID(),
          mode,
          ...(mode !== "regenerate" ? { text } : {}),
          ...(edited ? { messageId: edited.id, confirm: true } : {}),
        }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.message);
      }
      if (
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        await load();
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let at: number;
        while ((at = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, at);
          pending = pending.slice(at + 2);
          const kind = frame.match(/^event: (.+)$/m)?.[1];
          const raw = frame.match(/^data: (.+)$/m)?.[1];
          if (!raw) continue;
          const event = JSON.parse(raw);
          if (kind === "start") {
            assistantId = event.assistantId;
            setRunId(event.runId);
            setMessages((prev) => [
              ...prev,
              {
                id: assistantId,
                role: "assistant",
                text: "",
                status: "streaming",
                createdAt: new Date().toISOString(),
              },
            ]);
          }
          if (kind === "delta")
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, text: m.text + event.text } : m,
              ),
            );
          if (kind === "usage") setLiveUsage(event);
          if (kind === "error") setError(event.message);
          if (kind === "done") {
            gotDone = true;
            if (event.status === "stopped")
              setNotice("Response stopped. Partial output saved.");
          }
        }
        if (done) break;
      }
      if (!gotDone)
        setError(
          "The connection was interrupted. Your saved conversation will reload.",
        );
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      setStreaming(false);
      setRunId(null);
      controller.current = null;
      await load();
    }
  }
  async function stop() {
    if (runId) {
      try {
        await api(`runs/${runId}/stop`, "POST");
      } catch (e) {
        setError((e as Error).message);
      }
    }
    controller.current?.abort();
    setNotice("Stopping response…");
  }
  function newAgent() {
    setCreating(true);
    setConfig({
      ...blank,
      name: "New agent",
      model:
        models.find((m) => m.id === blank.model)?.id ??
        models[0]?.id ??
        blank.model,
    });
    setSettings(true);
    setMobileNav(false);
  }
  const runs = data?.agents.flatMap((a) => a.conversation.runs) ?? [];
  const totalTokens = runs.reduce(
    (n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
    0,
  );
  const knownCost = runs.reduce((n, r) => n + (r.cost ?? 0), 0);
  const incompleteCost = runs.some((r) => r.cost === null || !r.usageComplete);
  const lastRun = agent?.conversation.runs.at(-1);
  const currentUsage = liveUsage ?? lastRun;
  const effectiveModel = models.find((m) => m.id === config.model);
  if (auth)
    return (
      <div className="auth-shell">
        <div className="auth-brand">
          <Mark />{" "}
          <span>
            vizor<span className="brand-dot">.</span>
          </span>
        </div>
        <form className="auth-card" onSubmit={submitAuth}>
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
            {busy ? <LoaderCircle className="spin" size={16} /> : null}
            {register ? "Create account" : "Sign in"}
            <ArrowRight size={16} />
          </button>
          <button
            type="button"
            className="text-button"
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
          <ShieldCheck size={14} /> Your keys. Your conversations. Your space.
        </div>
      </div>
    );
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
          onClick={() => {
            setView("workspace");
            setMobileNav(false);
          }}
        >
          <MessageSquare size={17} />
          Conversations
          <span className="nav-number">{data?.agents.length ?? 0}</span>
        </button>
        <button
          className={`nav-item ${view === "keys" ? "active" : ""}`}
          onClick={() => {
            setView("keys");
            setMobileNav(false);
          }}
        >
          <KeyRound size={17} />
          API keys{data?.provider.connected && <span className="tiny-dot" />}
        </button>
        <div className="agent-caption">
          <span>YOUR AGENTS</span>
          <button
            className="icon-button"
            aria-label="Create agent"
            title="Create agent"
            onClick={newAgent}
            disabled={streaming || !!runId}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="agent-list">
          {data?.agents.map((a) => (
            <button
              key={a.id}
              disabled={streaming && a.id !== agent?.id}
              className={`agent-nav ${view === "workspace" && a.id === agent?.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(a.id);
                setView("workspace");
                setSettings(false);
                setCreating(false);
                setMobileNav(false);
                setError("");
                setLiveUsage(null);
              }}
            >
              <span className={`agent-symbol ${a.color}`}>
                <AgentIcon icon={a.icon} size={16} />
              </span>
              <span className="agent-nav-name">
                {a.name}
                <small>{a.demo ? "Demo configuration" : "Claude"}</small>
              </span>
              <span
                className={`agent-dot ${a.conversation.activeRunId ? "working" : ""}`}
              />
            </button>
          ))}
          {!data?.agents.length && (
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
              {data?.selfHost === false
                ? data.email.slice(0, 1).toUpperCase()
                : "Y"}
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
                onClick={async () => {
                  await api("auth/logout", "POST");
                  setData(null);
                  await load();
                }}
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
              {view === "keys"
                ? "API keys"
                : (agent?.name ?? "Getting started")}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="private-pill">
              <span className="tiny-dot" />
              Private workspace
            </span>
            <a
              className="docs-link"
              href="https://console.anthropic.com/"
              target="_blank"
              rel="noreferrer"
            >
              Anthropic console <ArrowUp className="external-arrow" size={13} />
            </a>
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
            <h2>Workspace unavailable</h2>
            <button
              className="primary"
              onClick={() => {
                setError("");
                setLoading(true);
                void load();
              }}
            >
              Try again
            </button>
          </div>
        ) : view === "keys" || !data.provider.connected ? (
          <div className="onboarding">
            <div className="page-eyebrow">
              <span className="eyebrow-line" />
              {data.provider.connected
                ? "CONNECTION SETTINGS"
                : "LET’S GET YOU SET UP"}
            </div>
            <h1>
              {data.provider.connected ? (
                "Your connection."
              ) : (
                <>
                  Your ideas.
                  <br />A little more <span>possibility.</span>
                </>
              )}
            </h1>
            <p className="page-intro">
              {data.provider.connected
                ? "Manage the provider that powers your agents."
                : "Bring your own key. Give your next idea a place to start."}
            </p>
            <div className="connection-layout">
              <section className="connection-card">
                <div className="connection-top">
                  <span className="claude-logo">
                    <Claude size={30} />
                  </span>
                  <span
                    className={`connection-badge ${data.provider.connected ? "connected" : ""}`}
                  >
                    <span className="tiny-dot" />
                    {data.provider.connected ? "Connected" : "Ready to connect"}
                  </span>
                </div>
                <h2>Claude</h2>
                <p className="provider-subtitle">by Anthropic</p>
                <p className="connection-description">
                  A thoughtful partner for writing, building,
                  <br className="desktop-break" /> and working through what’s
                  next.
                </p>
                <KeyForm
                  connected={data.provider.connected}
                  last4={data.provider.last4}
                  onError={setError}
                  onSuccess={async () => {
                    setView("keys");
                    await load();
                    setNotice("Claude connected successfully.");
                  }}
                />
                {data.provider.connected && (
                  <div className="connection-actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={openWorkspace}
                    >
                      Open workspace
                      <ArrowRight size={16} />
                    </button>
                    <button
                      className="danger-text"
                      onClick={() => setRemoveConfirm(true)}
                    >
                      Remove key
                    </button>
                  </div>
                )}
                <div className="encrypted-note">
                  <ShieldCheck size={14} />
                  Encrypted here. Saved keys are never returned to your browser.
                </div>
              </section>
              <section className="setup-guide">
                <div className="guide-heading">
                  <KeyRound size={17} />
                  <h3>One key. You’re in.</h3>
                </div>
                <ol>
                  <li>
                    <span>01</span>
                    <div>
                      <strong>Open the Anthropic console</strong>
                      <p>
                        Sign in at{" "}
                        <a
                          href="https://console.anthropic.com/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          console.anthropic.com{" "}
                          <ArrowUp size={11} className="external-arrow" />
                        </a>
                        .
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Create an API key</strong>
                      <p>
                        Go to API Keys → Create Key.
                        <br />
                        Copy the key starting with <code>sk-ant-</code>.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Add API credits</strong>
                      <p>
                        Set up billing under Plans & Billing,
                        <br />
                        then paste your key here to connect.
                      </p>
                    </div>
                  </li>
                </ol>
                <div className="billing-note">
                  <span className="note-icon">i</span>
                  <p>
                    API usage is billed by Anthropic, separately from a Claude
                    Pro subscription. Testing a connection makes a small, capped
                    API call and can incur a charge.
                  </p>
                </div>
              </section>
            </div>
            <div className="onboarding-footer">
              <span className="step-indicator">
                <b />
                Connect provider
                <span />
                Start a conversation
              </span>
              <span>Small setup. Clear headspace.</span>
            </div>
          </div>
        ) : !agent ? (
          <div className="welcome">
            <span className="welcome-mark">
              <Sparkles size={30} />
            </span>
            <div className="eyebrow">A FRESH CONVERSATION</div>
            <h1>Meet your first agent.</h1>
            <p>Give it a role, bring a question, and see where it goes.</p>
            <button className="primary" onClick={newAgent}>
              <Plus size={16} />
              Create an agent
            </button>
          </div>
        ) : (
          <>
            <div className="conversation-heading">
              <div className="conversation-title">
                <span className={`agent-symbol large ${agent.color}`}>
                  <AgentIcon icon={agent.icon} size={23} />
                </span>
                <div>
                  <h1>{agent.name}</h1>
                  <p>
                    <Claude size={13} />
                    {models.find((m) => m.id === agent.model)?.name ??
                      agent.model}
                    <span>·</span>
                    <span
                      className={`agent-state ${streaming || runId ? "thinking" : ""}`}
                    >
                      <span className="tiny-dot" />
                      {streaming || runId
                        ? "Thinking"
                        : lastRun?.status === "error"
                          ? "Error · ready to retry"
                          : lastRun?.status === "stopped" ||
                              lastRun?.status === "interrupted"
                            ? "Stopped"
                            : "Ready"}
                    </span>
                  </p>
                </div>
              </div>
              <button
                className={`secondary settings-toggle ${settings ? "is-active" : ""}`}
                onClick={() => {
                  setSettings(!settings);
                  setCreating(false);
                }}
                aria-expanded={settings}
              >
                <Settings2 size={15} />
                <span>Agent settings</span>
                {settings ? (
                  <PanelRightClose size={15} />
                ) : (
                  <PanelRightOpen size={15} />
                )}
              </button>
            </div>
            <div className="conversation-workspace">
              <section className="chat-panel">
                <div
                  className="chat-scroll"
                  role="log"
                  aria-label="Conversation"
                  aria-live="off"
                >
                  {!messages.length ? (
                    <div className="chat-empty">
                      <div className="orbital-mark">
                        <span />
                        <span />
                        <Sparkles size={27} />
                      </div>
                      <div className="eyebrow">ROOM TO THINK</div>
                      <h2>What’s on your mind?</h2>
                      <p>
                        A rough idea, a tricky question, a blank page.
                        <br />
                        Start anywhere.
                      </p>
                      <div className="starter-prompts">
                        {[
                          {
                            icon: PenLine,
                            title: "Find the right words",
                            text: "Help me turn a rough idea into a clear piece of writing. Ask me what I want to say and who it’s for.",
                          },
                          {
                            icon: Code2,
                            title: "Build something useful",
                            text: "I want to build something useful. Help me work through the requirements, then suggest a practical first step.",
                          },
                          {
                            icon: Zap,
                            title: "Work through an idea",
                            text: "Help me think through an idea. Ask me a few focused questions before offering suggestions.",
                          },
                        ].map((p) => (
                          <button
                            key={p.title}
                            onClick={() => setDraft(p.text)}
                          >
                            <p.icon size={17} />
                            <span>{p.title}</span>
                            <ArrowUp size={14} className="external-arrow" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="message-list">
                      {messages.map((message, index) => (
                        <Message
                          key={message.id}
                          message={message}
                          agent={agent}
                          canEdit={!streaming && !runId}
                          canRegenerate={
                            index === messages.length - 1 &&
                            !streaming &&
                            !runId
                          }
                          onCopy={() => {
                            void navigator.clipboard
                              .writeText(message.text)
                              .then(() => setNotice("Copied to clipboard."))
                              .catch(() =>
                                setError(
                                  "Clipboard unavailable. Select the text to copy it.",
                                ),
                              );
                          }}
                          onEdit={() => {
                            setEdit(message);
                            setEditText(message.text);
                          }}
                          onRegenerate={() => void send("", "regenerate")}
                        />
                      ))}
                      <div ref={end} />
                    </div>
                  )}
                </div>
                <div className="composer-area">
                  <form
                    className={`composer ${streaming ? "is-streaming" : ""}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send();
                    }}
                  >
                    <label className="sr-only" htmlFor="message-input">
                      Message {agent.name}
                    </label>
                    <textarea
                      id="message-input"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={`Message ${agent.name}…`}
                      maxLength={32000}
                      rows={2}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          if (!streaming && !runId) void send();
                        }
                      }}
                    />
                    <div className="composer-bottom">
                      <span>
                        <Claude size={15} />
                        <span>
                          {models
                            .find((m) => m.id === agent.model)
                            ?.name.replace("Claude ", "") ?? agent.model}
                        </span>
                        <span className="composer-divider" />
                        <span className="context-label">
                          {messages.filter((m) => m.role === "user").length}{" "}
                          messages
                        </span>
                      </span>
                      {streaming || runId ? (
                        <button
                          type="button"
                          className="send-button stop-button"
                          onClick={stop}
                          aria-label="Stop response"
                        >
                          <Square size={14} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          type="submit"
                          className="send-button"
                          disabled={!draft.trim()}
                          aria-label="Send message"
                        >
                          <ArrowUp size={19} />
                        </button>
                      )}
                    </div>
                  </form>
                  <div className="composer-meta">
                    <span>
                      Enter to send <span>·</span> Shift + Enter for a new line
                    </span>
                    <span>
                      <ShieldCheck size={12} />
                      Only shared with Claude
                    </span>
                  </div>
                </div>
              </section>
            </div>
            <footer className="workspace-footer">
              <span className="footer-status">
                <span className="tiny-dot" />
                All systems local
              </span>
              <span>
                {totalTokens.toLocaleString()} reported tokens
                <span className="footer-separator">/</span>
                {runs.length
                  ? `${money(knownCost)}${incompleteCost ? " + unknown" : ""} estimated`
                  : "No usage yet"}
                <span className="footer-separator">/</span>
                <span
                  title={`Standard text prices checked ${data.pricingDate}`}
                >
                  USD
                </span>
              </span>
            </footer>
          </>
        )}
        {settings && (
          <>
            <button
              className="drawer-scrim"
              aria-label="Close agent settings"
              onClick={() => {
                setSettings(false);
                setCreating(false);
              }}
            />
            <aside
              ref={settingsRef}
              className="settings-panel"
              role="dialog"
              aria-modal="true"
              aria-label={creating ? "New agent" : "Agent settings"}
            >
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">MAKE IT YOURS</div>
                  <h2>{creating ? "New agent" : "Agent settings"}</h2>
                </div>
                <button
                  className="icon-button"
                  onClick={() => {
                    setSettings(false);
                    setCreating(false);
                  }}
                  aria-label="Close agent settings"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="settings-scroll">
                <label>
                  Agent name
                  <input
                    value={config.name}
                    maxLength={70}
                    onChange={(e) =>
                      setConfig({ ...config, name: e.target.value })
                    }
                  />
                </label>
                <div className="field-row">
                  <label>
                    Icon
                    <select
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
                <div className="field-heading">
                  <span>Model</span>
                  <button
                    className="text-button"
                    onClick={() => void refreshModels()}
                    disabled={!data?.provider.connected}
                  >
                    <RotateCcw size={11} />
                    Refresh
                  </button>
                </div>
                <label>
                  <span className="sr-only">Model</span>
                  <select
                    value={config.model}
                    onChange={(e) =>
                      setConfig({ ...config, model: e.target.value })
                    }
                  >
                    {!models.some((m) => m.id === config.model) && (
                      <option value={config.model}>
                        {config.model} · current
                      </option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                {fallback && (
                  <div className="field-note warning">{fallback}</div>
                )}
                <label>
                  System prompt
                  <textarea
                    aria-label="System prompt"
                    value={config.systemPrompt}
                    maxLength={16000}
                    rows={7}
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
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    disabled={!effectiveModel?.temperature}
                    value={config.temperature}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        temperature: Number(e.target.value),
                      })
                    }
                  />
                  <small>
                    {effectiveModel?.temperature
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
                    value={config.maxTokens}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        maxTokens: Number(e.target.value),
                      })
                    }
                  />
                </label>
                {!creating && currentUsage && (
                  <div className="usage-details">
                    <div className="eyebrow">LAST RESPONSE</div>
                    <div>
                      <span>Input tokens</span>
                      <strong>
                        {currentUsage.inputTokens?.toLocaleString() ??
                          "Unavailable"}
                      </strong>
                    </div>
                    <div>
                      <span>Output tokens</span>
                      <strong>
                        {currentUsage.outputTokens?.toLocaleString() ??
                          "Unavailable"}
                      </strong>
                    </div>
                    <div>
                      <span>Estimated cost</span>
                      <strong>
                        {currentUsage.cost != null
                          ? money(currentUsage.cost)
                          : "Unavailable"}
                      </strong>
                    </div>
                    <small>
                      {lastRun?.usageComplete && !streaming
                        ? "Provider-reported tokens"
                        : "Partial usage · final totals may differ"}{" "}
                      · Prices {data?.pricingDate}
                    </small>
                  </div>
                )}
              </div>
              <div className="panel-footer">
                <button
                  className="primary"
                  onClick={saveAgent}
                  disabled={
                    busy ||
                    streaming ||
                    !!runId ||
                    !config.name.trim() ||
                    !Number.isInteger(config.maxTokens) ||
                    config.maxTokens < 64 ||
                    config.maxTokens > 8192
                  }
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  {creating ? "Create agent" : "Save changes"}
                </button>
              </div>
            </aside>
          </>
        )}
      </main>
      {edit && (
        <ConfirmDialog title="Edit & resend" onClose={() => setEdit(null)}>
          <p>
            This replaces the message and removes all responses after it from
            the active conversation.
          </p>
          <label>
            Message
            <textarea
              aria-label="Message"
              autoFocus
              rows={6}
              maxLength={32000}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!editText.trim()}
              onClick={() => void send(editText, "edit", edit)}
            >
              Replace & resend
              <ArrowRight size={15} />
            </button>
          </div>
        </ConfirmDialog>
      )}
      {removeConfirm && (
        <ConfirmDialog
          title="Remove Claude key?"
          onClose={() => setRemoveConfirm(false)}
        >
          <p>
            The saved key will be deleted and current responses will stop. Your
            agents and conversations stay here.
          </p>
          <div className="dialog-actions">
            <button
              className="secondary"
              onClick={() => setRemoveConfirm(false)}
            >
              Keep key
            </button>
            <button
              className="danger-button"
              onClick={async () => {
                try {
                  await api("providers/anthropic", "DELETE");
                  controller.current?.abort();
                  setRemoveConfirm(false);
                  setModels([]);
                  await load();
                  setNotice("Claude key removed.");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Remove key
            </button>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
function KeyForm({
  connected,
  last4,
  onSuccess,
  onError,
}: {
  connected: boolean;
  last4: string | null;
  onSuccess: () => Promise<void>;
  onError: (v: string) => void;
}) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  if (connected && !replacing)
    return (
      <div className="saved-key">
        <KeyRound size={16} />
        <span>•••• •••• •••• {last4}</span>
        <button className="text-button" onClick={() => setReplacing(true)}>
          Replace
        </button>
      </div>
    );
  return (
    <form
      className="key-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        onError("");
        try {
          await api("providers/anthropic", "POST", { key });
          setKey("");
          setReplacing(false);
          await onSuccess();
        } catch (error) {
          onError((error as Error).message);
        } finally {
          setKey("");
          setBusy(false);
        }
      }}
    >
      <label htmlFor="api-key">
        {replacing ? "New Anthropic API key" : "Your Anthropic API key"}
      </label>
      <div className="key-input">
        <KeyRound size={16} />
        <input
          id="api-key"
          type={show ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
          maxLength={512}
          disabled={busy}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={show ? "Hide API key" : "Show API key"}
          onClick={() => setShow(!show)}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <button className="primary" type="submit" disabled={busy || !key.trim()}>
        {busy ? (
          <>
            <LoaderCircle size={16} className="spin" />
            Testing connection…
          </>
        ) : (
          <>
            Test connection
            <ArrowRight size={16} />
          </>
        )}
      </button>
      {replacing && (
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setReplacing(false);
            setKey("");
          }}
        >
          Cancel replacement
        </button>
      )}
    </form>
  );
}
function Message({
  message,
  agent,
  canEdit,
  canRegenerate,
  onCopy,
  onEdit,
  onRegenerate,
}: {
  message: PublicMessage;
  agent: AgentView;
  canEdit: boolean;
  canRegenerate: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onRegenerate: () => void;
}) {
  const user = message.role === "user";
  return (
    <article
      className={`message ${user ? "user-message" : "assistant-message"}`}
    >
      <span className={`message-avatar ${user ? "user-avatar" : agent.color}`}>
        {user ? "Y" : <AgentIcon icon={agent.icon} size={17} />}
      </span>
      <div className="message-content">
        <div className="message-heading">
          <strong>{user ? "You" : agent.name}</strong>
          {!user && <span>Claude</span>}
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </div>
        <div className="markdown">
          {message.text ? (
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: () => (
                  <span className="blocked-image">[Remote image hidden]</span>
                ),
                a: ({ href, children }) =>
                  /^https?:\/\//.test(href ?? "") ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  ),
                code: ({ children, className }) => (
                  <code className={className}>{children}</code>
                ),
              }}
            >
              {message.text}
            </Markdown>
          ) : message.status === "streaming" ? (
            <span className="thinking-dots">
              <i />
              <i />
              <i />
              <span className="sr-only">Thinking</span>
            </span>
          ) : (
            <p className="muted">No text returned.</p>
          )}
        </div>
        <div className="message-actions">
          {message.text && (
            <button
              onClick={onCopy}
              aria-label="Copy message"
              title="Copy message"
            >
              <Copy size={13} />
            </button>
          )}
          {user && canEdit && (
            <button
              onClick={onEdit}
              aria-label="Edit message"
              title="Edit and resend"
            >
              <Pencil size={13} />
            </button>
          )}
          {!user && canRegenerate && (
            <button
              onClick={onRegenerate}
              aria-label="Regenerate response"
              title="Regenerate response"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {["stopped", "interrupted", "error"].includes(message.status) && (
            <span className="partial-label">
              {message.status === "error"
                ? "Response failed"
                : "Stopped · partial response"}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
function ConfirmDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const focusable = () =>
      Array.from(
        element?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), textarea, input, [href]",
        ) ?? [],
      );
    (
      element?.querySelector<HTMLElement>("textarea") ?? focusable()[0]
    )?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="dialog-heading">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
